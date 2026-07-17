import { randomUUID } from "node:crypto";

import { createDatabase, runMigrations } from "@open-excalidraw/database";
import type { ObjectStorage } from "@open-excalidraw/storage";

import {
  DEFAULT_ASSET_RETENTION_MS,
  DEFAULT_AUDIT_RETENTION_MS,
  DEFAULT_DELETED_DRAWING_RETENTION_MS,
  DEFAULT_MUTATION_RETENTION_MS,
  MaintenanceJobs,
} from "../src/jobs/index.js";
import {
  ContentService,
  PostgresContentRepository,
} from "../src/modules/content/index.js";
import {
  PostgresDrawingRepository,
  prepareDrawingPurge,
  storageDrawingBlobStore,
} from "../src/modules/drawings/index.js";

const databaseUrl = process.env.DATABASE_TEST_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const NOW = new Date("2026-07-11T12:00:00.000Z");

describeDatabase("maintenance jobs", () => {
  const database = createDatabase(databaseUrl ?? "postgresql://unused");
  const ownerId = randomUUID();
  let storage: TestStorage;
  let jobs: MaintenanceJobs;

  beforeAll(async () => {
    await runMigrations({ pool: database.pool });
    await database.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, 'Maintenance Owner', $2, true)`,
      [ownerId, `${ownerId}@example.test`],
    );
  });

  beforeEach(() => {
    storage = new TestStorage();
    jobs = new MaintenanceJobs(database.pool, storage, { now: () => NOW });
  });

  afterEach(async () => {
    await database.pool.query(
      `DELETE FROM audit_events WHERE request_id LIKE $1`,
      [`maintenance-${ownerId}-%`],
    );
    await database.pool.query(
      `DELETE FROM verification WHERE identifier LIKE $1`,
      [`maintenance-${ownerId}-%`],
    );
    await database.pool.query(`DELETE FROM "session" WHERE user_id = $1`, [
      ownerId,
    ]);
    await database.pool.query(`DELETE FROM drawings WHERE owner_user_id = $1`, [
      ownerId,
    ]);
  });

  afterAll(async () => {
    await database.pool.query(`DELETE FROM "user" WHERE id = $1`, [ownerId]);
    await database.close();
  });

  it("keeps the newest 20 revisions per drawing and is retry-safe", async () => {
    const first = await createDrawing(ownerId);
    const second = await createDrawing(ownerId);
    await insertRevisions(first, 25);
    await insertRevisions(second, 22);

    expect(await jobs.pruneRevisions()).toBe(7);
    expect(await revisionNumbers(first)).toEqual(
      Array.from({ length: 20 }, (_, index) => 25 - index),
    );
    expect(await revisionNumbers(second)).toEqual(
      Array.from({ length: 20 }, (_, index) => 22 - index),
    );
    expect(await jobs.pruneRevisions()).toBe(0);
  });

  it("deletes only seven-day-old unreferenced assets and safely retries blob failures", async () => {
    const drawingId = await createDrawing(ownerId, imageScene("current"));
    await insertRevision(drawingId, 1, imageScene("history"));

    const older = ago(DEFAULT_ASSET_RETENTION_MS + 1);
    const exact = ago(DEFAULT_ASSET_RETENTION_MS);
    const recent = ago(DEFAULT_ASSET_RETENTION_MS - 1);
    await insertAsset(drawingId, "orphan", older);
    await insertAsset(drawingId, "failing", older);
    await insertAsset(drawingId, "current", older);
    await insertAsset(drawingId, "history", older);
    await insertAsset(drawingId, "recent", recent);
    await insertAsset(drawingId, "exact", exact);
    await insertAsset(drawingId, "referenced-at-boundary", older, exact);
    storage.failNext(storageKey(drawingId, "failing"));

    const first = await jobs.cleanupOrphanAssets();
    expect(first.deleted).toBe(1);
    expect(first.failures).toEqual([
      expect.objectContaining({
        errorType: "Error",
        stage: "asset-delete",
      }),
    ]);
    expect(await assetDeletedAt(drawingId, "failing")).toEqual(
      expect.any(Date),
    );
    expect(await assetFileIds(drawingId)).toEqual([
      "current",
      "exact",
      "history",
      "recent",
      "referenced-at-boundary",
    ]);
    expect(storage.has(storageKey(drawingId, "orphan"))).toBe(false);
    expect(storage.has(storageKey(drawingId, "failing"))).toBe(true);

    const retry = await jobs.cleanupOrphanAssets();
    expect(retry).toEqual({ deleted: 1, failures: [] });
    expect(await jobs.cleanupOrphanAssets()).toEqual({
      deleted: 0,
      failures: [],
    });
    expect(await assetFileIds(drawingId)).toEqual([
      "current",
      "exact",
      "history",
      "recent",
      "referenced-at-boundary",
    ]);
  });

  it("keeps a committed tombstone when metadata finalization fails and safely retries", async () => {
    const drawingId = await createDrawing(ownerId);
    const assetId = await insertAsset(
      drawingId,
      "finalize-failure",
      ago(DEFAULT_ASSET_RETENTION_MS + 1),
    );
    await database.pool.query(`
      CREATE OR REPLACE FUNCTION maintenance_reject_asset_finalize()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.file_id = 'finalize-failure' AND NEW.storage_deleted_at IS NOT NULL THEN
          RAISE EXCEPTION 'injected finalization failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER maintenance_reject_asset_finalize
      BEFORE UPDATE OF storage_deleted_at ON drawing_assets
      FOR EACH ROW EXECUTE FUNCTION maintenance_reject_asset_finalize();
    `);

    try {
      const first = await jobs.cleanupOrphanAssets();
      expect(first).toEqual({
        deleted: 0,
        failures: [
          { id: assetId, errorType: "P0001", stage: "asset-finalize" },
        ],
      });
      expect(storage.has(storageKey(drawingId, "finalize-failure"))).toBe(
        false,
      );
      expect(await assetDeletedAt(drawingId, "finalize-failure")).toEqual(
        expect.any(Date),
      );
      expect(
        await assetStorageDeletedAt(drawingId, "finalize-failure"),
      ).toBeNull();
    } finally {
      await database.pool.query(`
        DROP TRIGGER IF EXISTS maintenance_reject_asset_finalize ON drawing_assets;
        DROP FUNCTION IF EXISTS maintenance_reject_asset_finalize();
      `);
    }

    expect(await jobs.cleanupOrphanAssets()).toEqual({
      deleted: 1,
      failures: [],
    });
    expect(await assetFileIds(drawingId)).toEqual([]);
    expect(await assetStorageDeletedAt(drawingId, "finalize-failure")).toEqual(
      expect.any(Date),
    );
  });

  it("cancels between candidates after completing any started safe phase", async () => {
    const drawingId = await createDrawing(ownerId);
    await insertAsset(
      drawingId,
      "cancel-a",
      ago(DEFAULT_ASSET_RETENTION_MS + 1),
    );
    await insertAsset(
      drawingId,
      "cancel-b",
      ago(DEFAULT_ASSET_RETENTION_MS + 1),
    );
    const abort = new AbortController();
    storage.onNextDelete(() => abort.abort());

    await expect(
      jobs.cleanupOrphanAssets(NOW, abort.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await assetFileIds(drawingId)).toHaveLength(1);
  });

  it("prunes mutations older than 30 days while preserving boundary idempotency", async () => {
    const drawingId = await createDrawing(ownerId);
    const service = new ContentService(
      new PostgresContentRepository(database.pool),
    );
    const boundaryMutation = randomUUID();
    const newMutation = randomUUID();
    const request = { assetIds: [], scene: emptyScene() };
    expect(
      await service.save(ownerId, drawingId, 0n, boundaryMutation, request),
    ).toMatchObject({ revision: "1" });
    const cutoff = ago(DEFAULT_MUTATION_RETENTION_MS);
    await database.pool.query(
      `UPDATE drawing_mutations SET created_at = $3
       WHERE drawing_id = $1 AND mutation_id = $2`,
      [drawingId, boundaryMutation, cutoff],
    );
    expect(
      await service.save(ownerId, drawingId, 1n, newMutation, request),
    ).toMatchObject({ revision: "2" });
    const oldMutation = randomUUID();
    await database.pool.query(
      `INSERT INTO drawing_mutations
         (drawing_id, mutation_id, payload_hash, base_revision,
          resulting_revision, created_at)
       VALUES ($1, $2, $3, 0, 1, $4)`,
      [
        drawingId,
        oldMutation,
        Buffer.alloc(32, 3),
        new Date(cutoff.getTime() - 1),
      ],
    );

    expect(await jobs.cleanupExpiredMutations()).toBe(1);
    expect(await mutationIds(drawingId)).toEqual(
      [boundaryMutation, newMutation].sort(),
    );
    expect(
      await service.save(ownerId, drawingId, 0n, boundaryMutation, request),
    ).toMatchObject({ revision: "1" });
    expect(await jobs.cleanupExpiredMutations()).toBe(0);
  });

  it("removes expired invitations and security records but preserves the exact boundary", async () => {
    const drawingId = await createDrawing(ownerId);
    const expired = new Date(NOW.getTime() - 1);
    await insertInvitation(drawingId, "expired", expired);
    await insertInvitation(drawingId, "boundary", NOW);
    await insertInvitation(drawingId, "future", new Date(NOW.getTime() + 1));
    await insertSession("expired", expired);
    await insertSession("boundary", NOW);
    await insertVerification("expired", expired);
    await insertVerification("boundary", NOW);

    expect(await jobs.cleanupExpiredInvitations()).toBe(1);
    expect(await jobs.cleanupExpiredSecurityRecords()).toEqual({
      sessions: 1,
      verifications: 1,
    });
    expect(await jobs.cleanupExpiredInvitations()).toBe(0);
    expect(await jobs.cleanupExpiredSecurityRecords()).toEqual({
      sessions: 0,
      verifications: 0,
    });

    const invitations = await database.pool.query<{ invitee_email: string }>(
      `SELECT invitee_email FROM drawing_invitations
       WHERE drawing_id = $1 ORDER BY invitee_email`,
      [drawingId],
    );
    expect(invitations.rows.map((row) => row.invitee_email)).toEqual([
      `maintenance-${ownerId}-boundary@example.test`,
      `maintenance-${ownerId}-future@example.test`,
    ]);
    expect(await tokens("session")).toEqual(["boundary"]);
    expect(await tokens("verification")).toEqual(["boundary"]);
  });

  it("retains the audit boundary and prunes only older events", async () => {
    const cutoff = ago(DEFAULT_AUDIT_RETENTION_MS);
    await insertAudit("old", new Date(cutoff.getTime() - 1));
    await insertAudit("boundary", cutoff);
    await insertAudit("new", new Date(cutoff.getTime() + 1));

    expect(await jobs.cleanupAuditEvents()).toBe(1);
    expect(await jobs.cleanupAuditEvents()).toBe(0);
    const records = await database.pool.query<{ request_id: string }>(
      `SELECT request_id FROM audit_events
       WHERE request_id LIKE $1 ORDER BY request_id`,
      [`maintenance-${ownerId}-%`],
    );
    expect(records.rows.map((row) => row.request_id)).toEqual([
      `maintenance-${ownerId}-boundary`,
      `maintenance-${ownerId}-new`,
    ]);
  });

  it("purges deleted drawings after seven days, including blobs, with safe retries", async () => {
    const old = await createDrawing(ownerId, emptyScene(), {
      deletedAt: ago(DEFAULT_DELETED_DRAWING_RETENTION_MS + 1),
    });
    const failing = await createDrawing(ownerId, emptyScene(), {
      deletedAt: ago(DEFAULT_DELETED_DRAWING_RETENTION_MS + 1),
    });
    const boundary = await createDrawing(ownerId, emptyScene(), {
      deletedAt: ago(DEFAULT_DELETED_DRAWING_RETENTION_MS),
    });
    const recent = await createDrawing(ownerId, emptyScene(), {
      deletedAt: ago(DEFAULT_DELETED_DRAWING_RETENTION_MS - 1),
    });
    await insertAsset(old, "old", ago(DEFAULT_ASSET_RETENTION_MS + 1));
    await insertAsset(failing, "failing", ago(DEFAULT_ASSET_RETENTION_MS + 1));
    await insertAsset(
      boundary,
      "boundary",
      ago(DEFAULT_ASSET_RETENTION_MS + 1),
    );
    await insertAsset(recent, "recent", ago(DEFAULT_ASSET_RETENTION_MS + 1));
    storage.failNext(storageKey(failing, "failing"));

    const first = await jobs.purgeDeletedDrawings();
    expect(first.deleted).toBe(1);
    expect(first.failures).toEqual([
      expect.objectContaining({
        id: failing,
        errorType: "Error",
        stage: "drawing-delete",
      }),
    ]);
    expect(await drawingIds([old, failing, boundary, recent])).toEqual(
      [boundary, failing, recent].sort(),
    );
    expect(storage.has(storageKey(old, "old"))).toBe(false);
    expect(storage.has(storageKey(failing, "failing"))).toBe(true);

    expect(await jobs.purgeDeletedDrawings()).toEqual({
      deleted: 1,
      failures: [],
    });
    expect(await jobs.purgeDeletedDrawings()).toEqual({
      deleted: 0,
      failures: [],
    });
    expect(await drawingIds([old, failing, boundary, recent])).toEqual(
      [boundary, recent].sort(),
    );
    expect(storage.has(storageKey(boundary, "boundary"))).toBe(true);
    expect(storage.has(storageKey(recent, "recent"))).toBe(true);
  });

  it("purges the drawing's thumbnail blob even though it has no asset row", async () => {
    const drawingId = await createDrawing(ownerId, emptyScene(), {
      deletedAt: ago(DEFAULT_DELETED_DRAWING_RETENTION_MS + 1),
    });
    storage.seed(`drawings/${drawingId}/thumbnail`);

    expect(await jobs.purgeDeletedDrawings()).toEqual({
      deleted: 1,
      failures: [],
    });
    expect(storage.has(`drawings/${drawingId}/thumbnail`)).toBe(false);
  });

  it("purges a trashed drawing on demand for its owner only, regardless of age", async () => {
    const repository = new PostgresDrawingRepository(
      database.pool,
      storageDrawingBlobStore(storage),
    );
    // Deleted just now — the owner purge must not wait out the retention.
    const trashed = await createDrawing(ownerId, emptyScene(), {
      deletedAt: NOW,
    });
    await insertAsset(trashed, "keep", NOW);
    storage.seed(`drawings/${trashed}/thumbnail`);
    const active = await createDrawing(ownerId);

    expect(
      await repository.purge({ drawingId: trashed, ownerUserId: randomUUID() }),
    ).toBe("not-found");
    expect(
      await repository.purge({ drawingId: active, ownerUserId: ownerId }),
    ).toBe("not-found");
    expect(
      await repository.purge({
        drawingId: trashed,
        ownerUserId: ownerId,
        auditRequestId: `maintenance-${ownerId}-user-purge`,
      }),
    ).toBe("purged");
    expect(storage.has(storageKey(trashed, "keep"))).toBe(false);
    expect(storage.has(`drawings/${trashed}/thumbnail`)).toBe(false);
    expect(await drawingIds([trashed, active])).toEqual([active]);

    // The purge is audited even though the drawing row (the usual FK target)
    // is gone; the drawing id survives in the event metadata.
    const audit = await database.pool.query<{
      metadata: { drawingId: string };
      drawing_id: string | null;
    }>(
      `SELECT metadata, drawing_id FROM audit_events
       WHERE request_id = $1 AND event_type = 'drawing.purged'`,
      [`maintenance-${ownerId}-user-purge`],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.drawing_id).toBeNull();
    expect(audit.rows[0]?.metadata).toEqual({ drawingId: trashed });
  });

  it("blocks restore and hides the trash entry once a purge starts, then reclaims it", async () => {
    const repository = new PostgresDrawingRepository(
      database.pool,
      storageDrawingBlobStore(storage),
    );
    const drawingId = await createDrawing(ownerId, emptyScene(), {
      deletedAt: NOW,
    });
    await insertAsset(drawingId, "marked", NOW);

    // A purge that dies right after prepare leaves only the durable marker.
    expect(
      await prepareDrawingPurge(database.pool, drawingId, {
        ownerUserId: ownerId,
      }),
    ).not.toBeNull();

    expect(await repository.restore({ drawingId, ownerUserId: ownerId })).toBe(
      "not-found",
    );
    expect(await repository.listTrashedForUser(ownerId)).toEqual([]);

    // The next maintenance run completes the crashed purge even though
    // deleted_at is far younger than the retention cutoff.
    expect(await jobs.purgeDeletedDrawings()).toEqual({
      deleted: 1,
      failures: [],
    });
    expect(await drawingIds([drawingId])).toEqual([]);
    expect(storage.has(storageKey(drawingId, "marked"))).toBe(false);
  });

  async function createDrawing(
    owner: string,
    scene = emptyScene(),
    options: { deletedAt?: Date } = {},
  ) {
    const id = randomUUID();
    const serialized = JSON.stringify(scene);
    await database.pool.query(
      `INSERT INTO drawings
         (id, owner_user_id, title, scene, scene_format_version, scene_bytes,
          deleted_at)
       VALUES ($1, $2, 'Maintenance test', $3::jsonb, 2, $4, $5)`,
      [id, owner, serialized, Buffer.byteLength(serialized), options.deletedAt],
    );
    return id;
  }

  async function insertRevisions(drawingId: string, count: number) {
    for (let revision = 1; revision <= count; revision += 1) {
      await insertRevision(drawingId, revision, textScene(`r-${revision}`));
    }
  }

  async function insertRevision(
    drawingId: string,
    revision: number,
    scene: ReturnType<typeof emptyScene>,
  ) {
    const serialized = JSON.stringify(scene);
    await database.pool.query(
      `INSERT INTO drawing_revisions
         (drawing_id, content_revision, scene, scene_format_version,
          scene_bytes, author_user_id, reason, created_at)
       VALUES ($1, $2, $3::jsonb, 2, $4, $5, 'checkpoint', $6)`,
      [
        drawingId,
        revision,
        serialized,
        Buffer.byteLength(serialized),
        ownerId,
        new Date(NOW.getTime() - (30 - revision) * 5 * 60_000),
      ],
    );
  }

  async function revisionNumbers(drawingId: string) {
    const result = await database.pool.query<{ content_revision: string }>(
      `SELECT content_revision FROM drawing_revisions
       WHERE drawing_id = $1 ORDER BY content_revision DESC`,
      [drawingId],
    );
    return result.rows.map((row) => Number(row.content_revision));
  }

  async function insertAsset(
    drawingId: string,
    fileId: string,
    createdAt: Date,
    lastReferencedAt: Date | null = null,
  ) {
    const key = storageKey(drawingId, fileId);
    const result = await database.pool.query<{ id: string }>(
      `INSERT INTO drawing_assets
         (drawing_id, file_id, storage_key, mime_type, byte_size, sha256,
          created_by_user_id, created_at, last_referenced_at)
       VALUES ($1, $2, $3, 'image/png', 1, $4, $5, $6, $7)
       RETURNING id`,
      [
        drawingId,
        fileId,
        key,
        Buffer.alloc(32, 7),
        ownerId,
        createdAt,
        lastReferencedAt,
      ],
    );
    storage.seed(key);
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Asset insert did not return an ID");
    return id;
  }

  async function assetDeletedAt(drawingId: string, fileId: string) {
    const result = await database.pool.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM drawing_assets
       WHERE drawing_id = $1 AND file_id = $2`,
      [drawingId, fileId],
    );
    return result.rows[0]?.deleted_at ?? null;
  }

  async function assetStorageDeletedAt(drawingId: string, fileId: string) {
    const result = await database.pool.query<{
      storage_deleted_at: Date | null;
    }>(
      `SELECT storage_deleted_at FROM drawing_assets
       WHERE drawing_id = $1 AND file_id = $2`,
      [drawingId, fileId],
    );
    return result.rows[0]?.storage_deleted_at ?? null;
  }

  async function mutationIds(drawingId: string) {
    const result = await database.pool.query<{ mutation_id: string }>(
      `SELECT mutation_id FROM drawing_mutations
       WHERE drawing_id = $1 ORDER BY mutation_id`,
      [drawingId],
    );
    return result.rows.map((row) => row.mutation_id);
  }

  async function assetFileIds(drawingId: string) {
    const result = await database.pool.query<{ file_id: string }>(
      `SELECT file_id FROM drawing_assets
       WHERE drawing_id = $1 AND deleted_at IS NULL ORDER BY file_id`,
      [drawingId],
    );
    return result.rows.map((row) => row.file_id);
  }

  async function insertInvitation(
    drawingId: string,
    name: string,
    expiresAt: Date,
  ) {
    await database.pool.query(
      `INSERT INTO drawing_invitations
         (drawing_id, invitee_email, role, token_hash, invited_by_user_id,
          expires_at, delivery_status)
       VALUES ($1, $2, 'viewer', $3, $4, $5, 'manual')`,
      [
        drawingId,
        `maintenance-${ownerId}-${name}@example.test`,
        Buffer.from(name.padEnd(32, "x").slice(0, 32)),
        ownerId,
        expiresAt,
      ],
    );
  }

  async function insertSession(name: string, expiresAt: Date) {
    await database.pool.query(
      `INSERT INTO "session" (id, expires_at, token, user_id)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), expiresAt, `maintenance-${ownerId}-${name}`, ownerId],
    );
  }

  async function insertVerification(name: string, expiresAt: Date) {
    await database.pool.query(
      `INSERT INTO verification (identifier, value, expires_at)
       VALUES ($1, $2, $3)`,
      [`maintenance-${ownerId}-${name}`, `value-${randomUUID()}`, expiresAt],
    );
  }

  async function tokens(table: "session" | "verification") {
    if (table === "session") {
      const result = await database.pool.query<{ token: string }>(
        `SELECT token FROM "session" WHERE user_id = $1 ORDER BY token`,
        [ownerId],
      );
      return result.rows.map((row) => row.token.split("-").at(-1));
    }
    const result = await database.pool.query<{ identifier: string }>(
      `SELECT identifier FROM verification WHERE identifier LIKE $1
       ORDER BY identifier`,
      [`maintenance-${ownerId}-%`],
    );
    return result.rows.map((row) => row.identifier.split("-").at(-1));
  }

  async function insertAudit(name: string, createdAt: Date) {
    await database.pool.query(
      `INSERT INTO audit_events (event_type, request_id, created_at)
       VALUES ('maintenance.test', $1, $2)`,
      [`maintenance-${ownerId}-${name}`, createdAt],
    );
  }

  async function drawingIds(ids: string[]) {
    const result = await database.pool.query<{ id: string }>(
      `SELECT id FROM drawings WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [ids],
    );
    return result.rows.map((row) => row.id).sort();
  }

  function ago(milliseconds: number) {
    return new Date(NOW.getTime() - milliseconds);
  }
});

class TestStorage implements ObjectStorage {
  readonly #keys = new Set<string>();
  readonly #failNext = new Set<string>();
  #onNextDelete: (() => void) | null = null;

  public seed(key: string) {
    this.#keys.add(key);
  }

  public has(key: string) {
    return this.#keys.has(key);
  }

  public failNext(key: string) {
    this.#failNext.add(key);
  }

  public onNextDelete(action: () => void) {
    this.#onNextDelete = action;
  }

  public put(): Promise<never> {
    return Promise.reject(new Error("not implemented"));
  }

  public get(): Promise<never> {
    return Promise.reject(new Error("not implemented"));
  }

  public stat(): Promise<never> {
    return Promise.reject(new Error("not implemented"));
  }

  public delete(key: string) {
    const action = this.#onNextDelete;
    this.#onNextDelete = null;
    action?.();
    if (this.#failNext.delete(key)) {
      return Promise.reject(new Error("injected delete failure"));
    }
    return Promise.resolve({ deleted: this.#keys.delete(key) });
  }
}

function emptyScene() {
  return {
    type: "excalidraw" as const,
    version: 2,
    source: "open-excalidraw-maintenance-test",
    elements: [] as Array<Record<string, unknown>>,
    appState: {},
  };
}

function textScene(id: string) {
  return {
    ...emptyScene(),
    elements: [
      { id, type: "text", version: 1, versionNonce: 1, isDeleted: false },
    ],
  };
}

function imageScene(fileId: string) {
  return {
    ...emptyScene(),
    elements: [
      {
        id: `image-${fileId}`,
        type: "image",
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        fileId,
      },
    ],
  };
}

function storageKey(drawingId: string, fileId: string) {
  return `drawings/${drawingId}/assets/${fileId}`;
}
