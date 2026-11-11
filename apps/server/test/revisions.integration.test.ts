import { randomUUID } from "node:crypto";

import { createDatabase, runMigrations } from "@open-excalidraw/database";

import {
  ContentService,
  PostgresContentRepository,
} from "../src/modules/content/index.js";

const databaseUrl = process.env.DATABASE_TEST_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const RESTORE_REQUEST_ID = `revision-restore-${randomUUID()}`;

describeDatabase("revision checkpoints", () => {
  const database = createDatabase(databaseUrl ?? "postgresql://unused");
  const ownerId = randomUUID();
  const drawingId = randomUUID();
  const restoredEvent = vi.fn();
  const service = new ContentService(
    new PostgresContentRepository(database.pool),
    60_000,
    { restored: restoredEvent },
  );

  beforeAll(async () => {
    await runMigrations({ pool: database.pool });
    await database.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, 'Revision Owner', $2, true)`,
      [ownerId, `${ownerId}@example.test`],
    );
    const initialScene = scene("initial");
    const serialized = JSON.stringify(initialScene);
    await database.pool.query(
      `INSERT INTO drawings
         (id, owner_user_id, title, scene, scene_format_version, scene_bytes)
       VALUES ($1, $2, 'Revision test', $3::jsonb, 2, $4)`,
      [drawingId, ownerId, serialized, Buffer.byteLength(serialized)],
    );
    await database.pool.query(
      `INSERT INTO drawing_assets
         (drawing_id, file_id, storage_key, mime_type, byte_size, sha256, created_by_user_id)
       VALUES ($1, 'revision-asset', $2, 'image/png', 1, $3, $4)`,
      [
        drawingId,
        `drawings/${drawingId}/assets/revision-asset`,
        Buffer.alloc(32, 7),
        ownerId,
      ],
    );
  });

  afterAll(async () => {
    await database.pool.query(
      `DELETE FROM audit_events WHERE request_id = $1`,
      [RESTORE_REQUEST_ID],
    );
    await database.pool.query(`DELETE FROM drawings WHERE id = $1`, [
      drawingId,
    ]);
    await database.pool.query(`DELETE FROM "user" WHERE id = $1`, [ownerId]);
    await database.close();
  });

  it("restores a checkpoint as a new monotonic current revision", async () => {
    const first = await service.save(ownerId, drawingId, 0n, randomUUID(), {
      scene: imageScene("first", "revision-asset"),
      assetIds: ["revision-asset"],
    });
    const second = await service.save(ownerId, drawingId, 1n, randomUUID(), {
      scene: scene("second"),
      assetIds: [],
    });
    expect([first.revision, second.revision]).toEqual(["1", "2"]);

    const staleReferenceTime = new Date("2020-01-01T00:00:00.000Z");
    await database.pool.query(
      `UPDATE drawing_assets SET last_referenced_at = $2 WHERE drawing_id = $1`,
      [drawingId, staleReferenceTime],
    );
    await database.pool.query(
      `UPDATE drawings SET scene_format_version = 7 WHERE id = $1`,
      [drawingId],
    );

    const restored = await service.restore(
      ownerId,
      drawingId,
      1n,
      RESTORE_REQUEST_ID,
    );
    expect(restored.revision).toBe("3");
    expect(restoredEvent).toHaveBeenCalledWith(drawingId, 3n);
    const current = await service.load(ownerId, drawingId);
    expect(current.revision).toBe("3");
    expect(current.scene.elements[0]).toMatchObject({
      id: "first",
      fileId: "revision-asset",
    });
    expect(await service.listRevisions(ownerId, drawingId)).toEqual({
      revisions: expect.arrayContaining([
        expect.objectContaining({ revision: "3", reason: "restore" }),
        expect.objectContaining({ revision: "1", reason: "checkpoint" }),
      ]),
    });
    const preservation = await database.pool.query<{
      scene_format_version: number;
      last_referenced_at: Date;
    }>(
      `SELECT r.scene_format_version, a.last_referenced_at
       FROM drawing_revisions r
       JOIN drawing_assets a ON a.drawing_id = r.drawing_id
       WHERE r.drawing_id = $1 AND r.content_revision = 2`,
      [drawingId],
    );
    expect(preservation.rows[0]?.scene_format_version).toBe(7);
    expect(preservation.rows[0]?.last_referenced_at.getTime()).toBeGreaterThan(
      staleReferenceTime.getTime(),
    );
    const audit = await database.pool.query<{
      event_type: string;
      metadata: Record<string, string>;
    }>(`SELECT event_type, metadata FROM audit_events WHERE request_id = $1`, [
      RESTORE_REQUEST_ID,
    ]);
    expect(audit.rows).toEqual([
      {
        event_type: "revision.restored",
        metadata: { restoredFromRevision: "1", resultingRevision: "3" },
      },
    ]);
  });
});

function scene(id: string) {
  return {
    type: "excalidraw" as const,
    version: 2,
    source: "open-excalidraw-test",
    elements: [
      {
        id,
        type: "text",
        version: 1,
        versionNonce: 1,
        isDeleted: false,
      },
    ],
    appState: {},
  };
}

function imageScene(id: string, fileId: string) {
  return {
    ...scene(id),
    elements: [
      {
        id,
        type: "image",
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        fileId,
      },
    ],
  };
}
