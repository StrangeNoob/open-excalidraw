import { randomUUID } from "node:crypto";

import type {
  AdminOverview,
  AdminUser,
  AdminUserList,
} from "@open-excalidraw/contracts";
import { createDatabase, runMigrations } from "@open-excalidraw/database";
import type {
  ObjectStorage,
  PutObjectResult,
  StorageKey,
} from "@open-excalidraw/storage";
import express from "express";
import request from "supertest";

import {
  AdminDomainError,
  AdminService,
  createAdminRouter,
  PostgresAdminRepository,
  type AdminRepository,
  type AdminStorageSettings,
} from "../src/modules/admin/index.js";
import type {
  IdentityService,
  RequestIdentity,
} from "../src/modules/auth/index.js";
import {
  PostgresDrawingRepository,
  storageDrawingBlobStore,
} from "../src/modules/drawings/index.js";

const adminId = randomUUID();
const adminEmail = `${adminId}@example.test`;

describe("admin HTTP domain", () => {
  it("rejects anonymous and non-admin callers before any work", async () => {
    const fixture = createFixture();

    const anonymous = await request(fixture.app).get("/api/v1/admin/overview");
    expect(anonymous.status).toBe(401);
    expect(anonymous.type).toBe("application/problem+json");
    expect(anonymous.body.code).toBe("AUTHENTICATION_REQUIRED");

    const nonAdmin = await request(fixture.app)
      .get("/api/v1/admin/overview")
      .set("x-test-user", randomUUID());
    expect(nonAdmin.status).toBe(403);
    expect(nonAdmin.body.code).toBe("ADMIN_ACCESS_REQUIRED");

    // An allowlisted email that has not proven mailbox ownership is not admin.
    const unverifiedAdmin = await request(fixture.app)
      .get("/api/v1/admin/overview")
      .set("x-test-user", adminId)
      .set("x-test-verified", "false");
    expect(unverifiedAdmin.status).toBe(403);
    expect(unverifiedAdmin.body.code).toBe("ADMIN_ACCESS_REQUIRED");
  });

  it("returns instance counts to an admin", async () => {
    const fixture = createFixture();
    fixture.repository.overviewStats = {
      users: 7,
      drawings: 3,
      storageBytes: 4096,
    };

    const response = await request(fixture.app)
      .get("/api/v1/admin/overview")
      .set("x-test-user", adminId);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      users: 7,
      drawings: 3,
      storageBytes: 4096,
    });
  });

  it("lists users and honours search and limit", async () => {
    const fixture = createFixture();
    fixture.repository.seedUser({ name: "Alice", email: "alice@example.test" });
    fixture.repository.seedUser({ name: "Bob", email: "bob@example.test" });
    fixture.repository.seedUser({
      name: "Carol",
      email: "carol@example.test",
    });

    const all = await request(fixture.app)
      .get("/api/v1/admin/users")
      .set("x-test-user", adminId);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(all.body.users.map((user: { name: string }) => user.name)).toEqual([
      "Alice",
      "Bob",
      "Carol",
    ]);

    const searched = await request(fixture.app)
      .get("/api/v1/admin/users?search=ALI")
      .set("x-test-user", adminId);
    expect(searched.body.users).toHaveLength(1);
    expect(searched.body.users[0].email).toBe("alice@example.test");

    const limited = await request(fixture.app)
      .get("/api/v1/admin/users?limit=1")
      .set("x-test-user", adminId);
    expect(limited.body.users).toHaveLength(1);
    expect(limited.body.total).toBe(3);
    expect(fixture.repository.lastLimit).toBe(1);

    // Non-numeric or fractional limits fall back to the default, not parseInt's
    // lenient "50abc" => 50 / "1.9" => 1.
    await request(fixture.app)
      .get("/api/v1/admin/users?limit=50abc")
      .set("x-test-user", adminId);
    expect(fixture.repository.lastLimit).toBe(50);
    await request(fixture.app)
      .get("/api/v1/admin/users?limit=1.9")
      .set("x-test-user", adminId);
    expect(fixture.repository.lastLimit).toBe(50);
  });

  it("disables another user and revokes their sessions but refuses self", async () => {
    const fixture = createFixture();
    const target = fixture.repository.seedUser({
      name: "Target",
      email: "target@example.test",
    });

    const selfDisable = await request(fixture.app)
      .post(`/api/v1/admin/users/${adminId}/disable`)
      .set("x-test-user", adminId);
    expect(selfDisable.status).toBe(409);
    expect(selfDisable.body.code).toBe("CANNOT_TARGET_SELF");

    const disabled = await request(fixture.app)
      .post(`/api/v1/admin/users/${target}/disable`)
      .set("x-test-user", adminId);
    expect(disabled.status).toBe(204);
    expect(fixture.repository.disabled.has(target)).toBe(true);
    expect(fixture.repository.sessionsRevoked.has(target)).toBe(true);

    const enabled = await request(fixture.app)
      .post(`/api/v1/admin/users/${target}/enable`)
      .set("x-test-user", adminId);
    expect(enabled.status).toBe(204);
    expect(fixture.repository.disabled.has(target)).toBe(false);
  });

  it("resets two-factor enrollment, idempotently, and gates access", async () => {
    const fixture = createFixture();
    const target = fixture.repository.seedUser({
      name: "Enrolled",
      email: "enrolled@example.test",
      twoFactorEnabled: true,
    });

    const anonymous = await request(fixture.app).post(
      `/api/v1/admin/users/${target}/two-factor/disable`,
    );
    expect(anonymous.status).toBe(401);

    const nonAdmin = await request(fixture.app)
      .post(`/api/v1/admin/users/${target}/two-factor/disable`)
      .set("x-test-user", randomUUID());
    expect(nonAdmin.status).toBe(403);

    const reset = await request(fixture.app)
      .post(`/api/v1/admin/users/${target}/two-factor/disable`)
      .set("x-test-user", adminId);
    expect(reset.status).toBe(204);
    expect(fixture.repository.twoFactorReset.has(target)).toBe(true);
    expect(fixture.repository.users.get(target)?.twoFactorEnabled).toBe(false);

    // A user who never enrolled resets just the same.
    const again = await request(fixture.app)
      .post(`/api/v1/admin/users/${target}/two-factor/disable`)
      .set("x-test-user", adminId);
    expect(again.status).toBe(204);

    const unknown = await request(fixture.app)
      .post(`/api/v1/admin/users/${randomUUID()}/two-factor/disable`)
      .set("x-test-user", adminId);
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("USER_NOT_FOUND");
  });

  it("disables, purges owned drawings, then deletes the user and refuses self", async () => {
    const fixture = createFixture();
    const target = fixture.repository.seedUser({
      name: "Doomed",
      email: "doomed@example.test",
    });

    const selfDelete = await request(fixture.app)
      .delete(`/api/v1/admin/users/${adminId}`)
      .set("x-test-user", adminId);
    expect(selfDelete.status).toBe(409);
    expect(selfDelete.body.code).toBe("CANNOT_TARGET_SELF");

    const deleted = await request(fixture.app)
      .delete(`/api/v1/admin/users/${target}`)
      .set("x-test-user", adminId);
    expect(deleted.status).toBe(204);
    expect(fixture.repository.calls).toEqual([
      `disable:${target}`,
      `purge:${target}`,
      `delete:${target}`,
    ]);
    expect(fixture.repository.users.has(target)).toBe(false);
  });

  it("re-purges and retries once when the final delete hits the owner FK", async () => {
    const fixture = createFixture();
    const target = fixture.repository.seedUser({
      name: "Racy",
      email: "racy@example.test",
    });
    fixture.repository.failDeleteUserOnce = true;

    const deleted = await request(fixture.app)
      .delete(`/api/v1/admin/users/${target}`)
      .set("x-test-user", adminId);
    expect(deleted.status).toBe(204);
    expect(fixture.repository.calls).toEqual([
      `disable:${target}`,
      `purge:${target}`,
      `purge:${target}`,
      `delete:${target}`,
    ]);
    expect(fixture.repository.users.has(target)).toBe(false);
  });

  it("answers 404 for an unknown user", async () => {
    const fixture = createFixture();

    const disable = await request(fixture.app)
      .post(`/api/v1/admin/users/${randomUUID()}/disable`)
      .set("x-test-user", adminId);
    expect(disable.status).toBe(404);
    expect(disable.body.code).toBe("USER_NOT_FOUND");

    const remove = await request(fixture.app)
      .delete(`/api/v1/admin/users/${randomUUID()}`)
      .set("x-test-user", adminId);
    expect(remove.status).toBe(404);
  });

  it("reads and updates the instance storage quota setting", async () => {
    const fixture = createFixture(5000);

    const initial = await request(fixture.app)
      .get("/api/v1/admin/settings")
      .set("x-test-user", adminId);
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({
      storageQuotaPerUserBytes: null,
      envFallbackBytes: 5000,
    });

    const updated = await request(fixture.app)
      .patch("/api/v1/admin/settings")
      .set("x-test-user", adminId)
      .send({ storageQuotaPerUserBytes: 12345 });
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({
      storageQuotaPerUserBytes: 12345,
      envFallbackBytes: 5000,
    });

    // Zero and negative quotas are rejected by the contract schema.
    const invalid = await request(fixture.app)
      .patch("/api/v1/admin/settings")
      .set("x-test-user", adminId)
      .send({ storageQuotaPerUserBytes: 0 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("INVALID_REQUEST");

    const anonymous = await request(fixture.app)
      .patch("/api/v1/admin/settings")
      .send({ storageQuotaPerUserBytes: 1 });
    expect(anonymous.status).toBe(401);
  });

  it("sets and clears a user's storage quota override", async () => {
    const fixture = createFixture();
    const target = fixture.repository.seedUser({
      name: "Quota",
      email: "quota@example.test",
    });

    const set = await request(fixture.app)
      .patch(`/api/v1/admin/users/${target}/quota`)
      .set("x-test-user", adminId)
      .send({ storageQuotaBytes: 4096 });
    expect(set.status).toBe(200);
    expect(set.body.id).toBe(target);
    expect(set.body.storageQuotaBytes).toBe(4096);

    const cleared = await request(fixture.app)
      .patch(`/api/v1/admin/users/${target}/quota`)
      .set("x-test-user", adminId)
      .send({ storageQuotaBytes: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.storageQuotaBytes).toBeNull();

    const invalid = await request(fixture.app)
      .patch(`/api/v1/admin/users/${target}/quota`)
      .set("x-test-user", adminId)
      .send({ storageQuotaBytes: -1 });
    expect(invalid.status).toBe(400);

    const unknown = await request(fixture.app)
      .patch(`/api/v1/admin/users/${randomUUID()}/quota`)
      .set("x-test-user", adminId)
      .send({ storageQuotaBytes: 4096 });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("USER_NOT_FOUND");
  });
});

const databaseUrl = process.env.DATABASE_TEST_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("admin persistence", () => {
  const database = createDatabase(databaseUrl ?? "postgresql://unused");
  const storage = new InMemoryObjectStorage();
  const drawingRepository = new PostgresDrawingRepository(
    database.pool,
    storageDrawingBlobStore(storage),
  );
  const repository = new PostgresAdminRepository(database.pool, (input) =>
    drawingRepository.purge(input),
  );
  const service = new AdminService(repository);

  const disabledAtFor = async (userId: string): Promise<Date | null> => {
    const result = await database.pool.query<{ disabled_at: Date | null }>(
      `SELECT disabled_at FROM "user" WHERE id = $1`,
      [userId],
    );
    return result.rows[0]?.disabled_at ?? null;
  };

  const actorId = randomUUID();
  const targetId = randomUUID();
  const otherId = randomUUID();
  const disableId = randomUUID();
  const twoFactorId = randomUUID();
  const ownedDrawingId = randomUUID();
  const otherDrawingId = randomUUID();
  const assetKey = `drawings/${ownedDrawingId}/assets/file-1`;
  const requestId = "admin-test-request";

  let baseline: AdminOverview;

  beforeAll(async () => {
    await runMigrations({ pool: database.pool });
    baseline = await service.getOverview();

    await database.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, 'Actor', $2, true),
              ($3, 'Target', $4, true),
              ($5, 'Other', $6, true),
              ($7, 'Disable', $8, true),
              ($9, 'TwoFactor', $10, true)`,
      [
        actorId,
        `${actorId}@example.test`,
        targetId,
        `${targetId}@example.test`,
        otherId,
        `${otherId}@example.test`,
        disableId,
        `${disableId}@example.test`,
        twoFactorId,
        `${twoFactorId}@example.test`,
      ],
    );
    const scene = JSON.stringify(emptyScene());
    const bytes = Buffer.byteLength(scene);
    await database.pool.query(
      `INSERT INTO drawings
         (id, owner_user_id, title, scene, scene_format_version, scene_bytes)
       VALUES ($1, $2, 'Owned', $5::jsonb, 2, $6),
              ($3, $4, 'Other', $5::jsonb, 2, $6)`,
      [ownedDrawingId, targetId, otherDrawingId, otherId, scene, bytes],
    );
    // Active asset on the owned drawing, with its blob present in storage.
    storage.keys.add(assetKey);
    await database.pool.query(
      `INSERT INTO drawing_assets
         (drawing_id, file_id, storage_key, mime_type, byte_size, sha256,
          created_by_user_id)
       VALUES ($1, 'file-1', $2, 'image/png', 1234, $3, $4)`,
      [ownedDrawingId, assetKey, Buffer.alloc(32), targetId],
    );
    // A revision the target authored inside another user's drawing.
    await database.pool.query(
      `INSERT INTO drawing_revisions
         (drawing_id, content_revision, scene, scene_format_version,
          scene_bytes, author_user_id, reason)
       VALUES ($1, 1, $2::jsonb, 2, $3, $4, 'checkpoint')`,
      [otherDrawingId, scene, bytes, targetId],
    );
  });

  afterAll(async () => {
    // admin.user_* and drawing.purged rows all carry this suite's requestId;
    // clean them so they do not accumulate in the shared test database.
    await database.pool.query(
      `DELETE FROM audit_events WHERE request_id = $1`,
      [requestId],
    );
    await database.pool.query(
      `DELETE FROM drawings WHERE id = ANY($1::uuid[])`,
      [[ownedDrawingId, otherDrawingId]],
    );
    await database.pool.query(`DELETE FROM "user" WHERE id = ANY($1::uuid[])`, [
      [actorId, targetId, otherId, disableId, twoFactorId],
    ]);
    await database.close();
  });

  it("counts users, active drawings, and active asset bytes", async () => {
    const overview = await service.getOverview();
    expect(overview.users - baseline.users).toBe(5);
    expect(overview.drawings - baseline.drawings).toBe(2);
    expect(overview.storageBytes - baseline.storageBytes).toBe(1234);
  });

  it("surfaces each user's owned storage usage and quota override in the list", async () => {
    const listed = await service.listUsers({
      search: `${targetId}@example.test`,
    });
    const user = listed.users.find((row) => row.id === targetId);
    // targetId owns one drawing carrying a single 1234-byte active asset.
    expect(user?.storageBytes).toBe(1234);
    expect(user?.storageQuotaBytes).toBeNull();
  });

  it("escapes LIKE wildcards so search matches the term literally", async () => {
    const literalId = randomUUID();
    const wildcardId = randomUUID();
    await database.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, 'John Literal', 'john_doe@x.test', true),
              ($2, 'John Wildcard', 'johnXdoe@x.test', true)`,
      [literalId, wildcardId],
    );
    try {
      const result = await service.listUsers({ search: "john_" });
      const emails = result.users.map((user) => user.email);
      expect(emails).toContain("john_doe@x.test");
      expect(emails).not.toContain("johnXdoe@x.test");
    } finally {
      await database.pool.query(
        `DELETE FROM "user" WHERE id = ANY($1::uuid[])`,
        [[literalId, wildcardId]],
      );
    }
  });

  it("disable stamps disabled_at, deletes sessions, and is idempotent", async () => {
    await database.pool.query(
      `INSERT INTO "session" (user_id, token, expires_at)
       VALUES ($1, $2, now() + interval '1 day')`,
      [disableId, `token-${disableId}`],
    );

    await service.disableUser({
      actorUserId: actorId,
      targetUserId: disableId,
      requestId,
    });
    const disabledAt = await disabledAtFor(disableId);
    expect(disabledAt).not.toBeNull();
    const sessions = await database.pool.query(
      `SELECT 1 FROM "session" WHERE user_id = $1`,
      [disableId],
    );
    expect(sessions.rowCount).toBe(0);

    await service.disableUser({
      actorUserId: actorId,
      targetUserId: disableId,
      requestId,
    });
    expect((await disabledAtFor(disableId))?.getTime()).toBe(
      disabledAt?.getTime(),
    );

    await service.enableUser({
      actorUserId: actorId,
      targetUserId: disableId,
      requestId,
    });
    expect(await disabledAtFor(disableId)).toBeNull();
  });

  it("reset drops two_factor rows, clears the flag, surfaces it, and audits idempotently", async () => {
    await database.pool.query(
      `UPDATE "user" SET two_factor_enabled = true WHERE id = $1`,
      [twoFactorId],
    );
    await database.pool.query(
      `INSERT INTO two_factor (secret, backup_codes, user_id)
       VALUES ('secret', 'codes', $1)`,
      [twoFactorId],
    );

    const enrolled = await service.listUsers({
      search: `${twoFactorId}@example.test`,
    });
    expect(enrolled.users[0]?.twoFactorEnabled).toBe(true);

    await service.resetTwoFactor({
      actorUserId: actorId,
      targetUserId: twoFactorId,
      requestId,
    });

    const flag = await database.pool.query<{ two_factor_enabled: boolean }>(
      `SELECT two_factor_enabled FROM "user" WHERE id = $1`,
      [twoFactorId],
    );
    expect(flag.rows[0]?.two_factor_enabled).toBe(false);
    const rows = await database.pool.query(
      `SELECT 1 FROM two_factor WHERE user_id = $1`,
      [twoFactorId],
    );
    expect(rows.rowCount).toBe(0);

    // Idempotent: resetting a now-unenrolled user still succeeds and audits.
    await service.resetTwoFactor({
      actorUserId: actorId,
      targetUserId: twoFactorId,
      requestId,
    });
    const audit = await database.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events
       WHERE event_type = 'admin.user_two_factor_reset'
         AND metadata->>'targetUserId' = $1`,
      [twoFactorId],
    );
    expect(audit.rows[0]?.n).toBe(2);
  });

  it("rejects mutating a vanished user and writes no phantom audit row", async () => {
    const ghostId = randomUUID();
    const ghostRequestId = `ghost-${ghostId}`;
    await expect(
      repository.disableUser({
        actorUserId: actorId,
        targetUserId: ghostId,
        requestId: ghostRequestId,
      }),
    ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
    const audit = await database.pool.query(
      `SELECT 1 FROM audit_events WHERE request_id = $1`,
      [ghostRequestId],
    );
    expect(audit.rowCount).toBe(0);
  });

  it("deletes a user, purges their drawings, and nulls foreign attribution", async () => {
    await service.deleteUser({
      actorUserId: actorId,
      targetUserId: targetId,
      requestId,
    });

    const user = await database.pool.query(
      `SELECT 1 FROM "user" WHERE id = $1`,
      [targetId],
    );
    expect(user.rowCount).toBe(0);

    const ownedDrawing = await database.pool.query(
      `SELECT 1 FROM drawings WHERE id = $1`,
      [ownedDrawingId],
    );
    expect(ownedDrawing.rowCount).toBe(0);
    const ownedAssets = await database.pool.query(
      `SELECT 1 FROM drawing_assets WHERE drawing_id = $1`,
      [ownedDrawingId],
    );
    expect(ownedAssets.rowCount).toBe(0);
    expect(storage.keys.has(assetKey)).toBe(false);

    const revision = await database.pool.query<{
      author_user_id: string | null;
    }>(`SELECT author_user_id FROM drawing_revisions WHERE drawing_id = $1`, [
      otherDrawingId,
    ]);
    expect(revision.rowCount).toBe(1);
    expect(revision.rows[0]?.author_user_id).toBeNull();

    const audit = await database.pool.query(
      `SELECT 1 FROM audit_events
       WHERE event_type = 'admin.user_deleted'
         AND metadata->>'targetUserId' = $1`,
      [targetId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it("round-trips the instance storage setting and audits the change", async () => {
    expect(await service.getSettings()).toEqual({
      storageQuotaPerUserBytes: null,
      envFallbackBytes: null,
    });

    const updated = await service.updateSettings({
      actorUserId: actorId,
      requestId,
      body: { storageQuotaPerUserBytes: 500000 },
    });
    expect(updated).toEqual({
      storageQuotaPerUserBytes: 500000,
      envFallbackBytes: null,
    });
    expect((await service.getSettings()).storageQuotaPerUserBytes).toBe(500000);

    // envFallbackBytes is the read-only env default threaded through the service.
    const withEnv = new AdminService(repository, 999);
    expect((await withEnv.getSettings()).envFallbackBytes).toBe(999);

    const audit = await database.pool.query<{
      metadata: {
        storageQuotaPerUserBytes: { before: number | null; after: number };
      };
    }>(
      `SELECT metadata FROM audit_events
       WHERE event_type = 'admin.settings.updated' AND request_id = $1`,
      [requestId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]?.metadata.storageQuotaPerUserBytes).toEqual({
      before: null,
      after: 500000,
    });

    // Reset the shared single-row table to unlimited without another audit row.
    await database.pool.query(
      `UPDATE app_settings SET storage_quota_per_user_bytes = NULL WHERE id = true`,
    );
  });

  it("sets and clears a user's quota override, returning usage and auditing both", async () => {
    // otherId still exists (only targetId was deleted above) and owns no assets.
    const set = await service.setUserQuota({
      actorUserId: actorId,
      targetUserId: otherId,
      requestId,
      body: { storageQuotaBytes: 8192 },
    });
    expect(set.id).toBe(otherId);
    expect(set.storageQuotaBytes).toBe(8192);
    expect(set.storageBytes).toBe(0);

    const cleared = await service.setUserQuota({
      actorUserId: actorId,
      targetUserId: otherId,
      requestId,
      body: { storageQuotaBytes: null },
    });
    expect(cleared.storageQuotaBytes).toBeNull();

    await expect(
      service.setUserQuota({
        actorUserId: actorId,
        targetUserId: randomUUID(),
        requestId,
        body: { storageQuotaBytes: 1 },
      }),
    ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });

    const audit = await database.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events
       WHERE event_type = 'admin.user.quota_updated'
         AND metadata->>'targetUserId' = $1`,
      [otherId],
    );
    expect(audit.rows[0]?.n).toBe(2);
  });
});

function createFixture(envFallbackBytes: number | null = null) {
  const repository = new InMemoryAdminRepository();
  const service = new AdminService(repository, envFallbackBytes);
  const identity: IdentityService = {
    resolve(headers) {
      const header = (name: string): string | null =>
        headers instanceof Headers
          ? headers.get(name)
          : typeof headers[name] === "string"
            ? headers[name]
            : null;
      const userId = header("x-test-user");
      if (!userId) return Promise.resolve(null);
      // Emails are verified unless a test explicitly opts out.
      return Promise.resolve(
        identityFor(userId, header("x-test-verified") !== "false"),
      );
    },
  };
  const app = express();
  app.use(express.json());
  app.use(
    createAdminRouter({
      service,
      identity,
      adminEmails: new Set([adminEmail.toLowerCase()]),
    }),
  );
  return { app, repository };
}

function identityFor(userId: string, emailVerified = true): RequestIdentity {
  return {
    userId,
    email: `${userId}@example.test`,
    name: "Test User",
    image: null,
    emailVerified,
    twoFactorEnabled: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    authKind: "session",
    sessionId: randomUUID(),
    sessionExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
  };
}

interface SeededUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
  disabledAt: string | null;
  twoFactorEnabled: boolean;
  drawingCount: number;
  storageBytes: number;
  storageQuotaBytes: number | null;
}

class InMemoryAdminRepository implements AdminRepository {
  public overviewStats: AdminOverview = {
    users: 0,
    drawings: 0,
    storageBytes: 0,
  };
  public readonly users = new Map<string, SeededUser>();
  public readonly disabled = new Set<string>();
  public readonly sessionsRevoked = new Set<string>();
  public readonly twoFactorReset = new Set<string>();
  public readonly calls: string[] = [];
  public lastLimit = 0;
  public failDeleteUserOnce = false;
  private seq = 0;

  public seedUser(input: {
    name: string;
    email: string;
    twoFactorEnabled?: boolean;
  }): string {
    const id = randomUUID();
    this.seq += 1;
    this.users.set(id, {
      id,
      name: input.name,
      email: input.email,
      emailVerified: true,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, this.seq)).toISOString(),
      disabledAt: null,
      twoFactorEnabled: input.twoFactorEnabled ?? false,
      drawingCount: 0,
      storageBytes: 0,
      storageQuotaBytes: null,
    });
    return id;
  }

  public overview(): Promise<AdminOverview> {
    return Promise.resolve(this.overviewStats);
  }

  public listUsers(input: {
    search?: string;
    limit: number;
  }): Promise<AdminUserList> {
    this.lastLimit = input.limit;
    const needle = input.search?.toLowerCase();
    const matched = [...this.users.values()]
      .filter(
        (user) =>
          !needle ||
          user.email.toLowerCase().includes(needle) ||
          user.name.toLowerCase().includes(needle),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return Promise.resolve({
      users: matched.slice(0, input.limit),
      total: matched.length,
    });
  }

  public userExists(userId: string): Promise<boolean> {
    return Promise.resolve(this.users.has(userId));
  }

  public settings: AdminStorageSettings = { storageQuotaPerUserBytes: null };

  public getSettings(): Promise<AdminStorageSettings> {
    return Promise.resolve(this.settings);
  }

  public updateSettings(input: {
    storageQuotaPerUserBytes: number | null;
  }): Promise<AdminStorageSettings> {
    this.settings = {
      storageQuotaPerUserBytes: input.storageQuotaPerUserBytes,
    };
    return Promise.resolve(this.settings);
  }

  public setUserQuota(input: {
    targetUserId: string;
    storageQuotaBytes: number | null;
  }): Promise<AdminUser> {
    const user = this.users.get(input.targetUserId);
    if (!user) {
      return Promise.reject(
        new AdminDomainError("USER_NOT_FOUND", 404, "User not found"),
      );
    }
    user.storageQuotaBytes = input.storageQuotaBytes;
    return Promise.resolve(user);
  }

  public disableUser(input: { targetUserId: string }): Promise<void> {
    this.calls.push(`disable:${input.targetUserId}`);
    this.disabled.add(input.targetUserId);
    this.sessionsRevoked.add(input.targetUserId);
    return Promise.resolve();
  }

  public enableUser(input: { targetUserId: string }): Promise<void> {
    this.disabled.delete(input.targetUserId);
    return Promise.resolve();
  }

  public resetTwoFactor(input: { targetUserId: string }): Promise<void> {
    this.calls.push(`resetTwoFactor:${input.targetUserId}`);
    this.twoFactorReset.add(input.targetUserId);
    // Mirror the real repository: reset also clears the user's flag.
    const user = this.users.get(input.targetUserId);
    if (user) {
      user.twoFactorEnabled = false;
    }
    return Promise.resolve();
  }

  public purgeOwnedDrawings(input: { ownerUserId: string }): Promise<void> {
    this.calls.push(`purge:${input.ownerUserId}`);
    return Promise.resolve();
  }

  public deleteUser(input: { targetUserId: string }): Promise<void> {
    if (this.failDeleteUserOnce) {
      this.failDeleteUserOnce = false;
      // Shaped like a Postgres foreign_key_violation on drawings.owner_user_id.
      return Promise.reject(
        Object.assign(new Error("foreign key violation"), { code: "23503" }),
      );
    }
    this.calls.push(`delete:${input.targetUserId}`);
    this.users.delete(input.targetUserId);
    return Promise.resolve();
  }
}

class InMemoryObjectStorage implements ObjectStorage {
  public readonly keys = new Set<string>();

  public put(key: StorageKey): Promise<PutObjectResult> {
    this.keys.add(key);
    return Promise.resolve({
      key,
      size: 0,
      sha256: "",
      modifiedAt: new Date(),
      created: true,
    });
  }

  public get(): never {
    throw new Error("unused");
  }

  public stat(): never {
    throw new Error("unused");
  }

  public delete(key: StorageKey): Promise<{ deleted: boolean }> {
    return Promise.resolve({ deleted: this.keys.delete(key) });
  }
}

function emptyScene() {
  return {
    type: "excalidraw" as const,
    version: 2,
    source: "open-excalidraw-test",
    elements: [],
    appState: {},
  };
}
