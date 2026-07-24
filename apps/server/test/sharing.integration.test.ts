import { randomUUID } from "node:crypto";

import { createDatabase, runMigrations } from "@open-excalidraw/database";
import { DisabledMailer, type Mailer } from "@open-excalidraw/mail";
import type { Pool } from "pg";

import type { RequestIdentity } from "../src/modules/auth/index.js";
import {
  ContentService,
  PostgresContentRepository,
} from "../src/modules/content/index.js";
import {
  PostgresSharingRepository,
  SharingService,
} from "../src/modules/sharing/index.js";

const databaseUrl = process.env.DATABASE_TEST_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const SHARE_REQUEST_ID = `sharing-invite-${randomUUID()}`;

describeDatabase("sharing and invitation lifecycle", () => {
  const database = createDatabase(databaseUrl ?? "postgresql://unused");
  const ownerId = randomUUID();
  const existingId = randomUUID();
  const inviteeId = randomUUID();
  const otherId = randomUUID();
  const drawingId = randomUUID();
  const additionalUserIds: string[] = [];
  const repository = new PostgresSharingRepository(database.pool);
  const service = new SharingService({
    repository,
    mailer: new DisabledMailer(),
    publicBaseUrl: "https://draw.example.test",
    requireVerifiedEmailForAcceptance: false,
  });

  beforeAll(async () => {
    await runMigrations({ pool: database.pool });
    await database.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES
         ($1, 'Sharing Owner', $2, true),
         ($3, 'Existing User', $4, true),
         ($5, 'Other User', $6, true)`,
      [
        ownerId,
        `${ownerId}@example.test`,
        existingId,
        "existing@example.test",
        otherId,
        "other@example.test",
      ],
    );
    const scene = JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "test",
      elements: [],
      appState: {},
    });
    await database.pool.query(
      `INSERT INTO drawings
         (id, owner_user_id, title, scene, scene_format_version, scene_bytes)
       VALUES ($1, $2, 'Shared drawing', $3::jsonb, 2, $4)`,
      [drawingId, ownerId, scene, Buffer.byteLength(scene)],
    );
  });

  afterAll(async () => {
    await database.pool.query(
      `DELETE FROM audit_events WHERE request_id = $1`,
      [SHARE_REQUEST_ID],
    );
    await database.pool.query(`DELETE FROM drawings WHERE id = $1`, [
      drawingId,
    ]);
    await database.pool.query(`DELETE FROM "user" WHERE id = ANY($1::uuid[])`, [
      [ownerId, existingId, inviteeId, otherId, ...additionalUserIds],
    ]);
    await database.close();
  });

  it("grants existing users immediately without creating an invitation", async () => {
    const result = await service.invite(
      ownerId,
      drawingId,
      {
        email: "Existing@Example.Test",
        role: "editor",
      },
      SHARE_REQUEST_ID,
    );
    expect(result).toMatchObject({
      deliveryStatus: "not-needed",
      membership: { userId: existingId, role: "editor" },
    });
    expect(result.invitation).toBeUndefined();
    const count = await database.pool.query<{ count: string }>(
      `SELECT count(*) FROM drawing_invitations
       WHERE drawing_id = $1 AND invitee_email = 'existing@example.test'`,
      [drawingId],
    );
    expect(count.rows[0]?.count).toBe("0");
    const audit = await database.pool.query<{
      event_type: string;
      metadata: Record<string, string>;
    }>(`SELECT event_type, metadata FROM audit_events WHERE request_id = $1`, [
      SHARE_REQUEST_ID,
    ]);
    expect(audit.rows).toEqual([
      {
        event_type: "sharing.member_upserted",
        metadata: { role: "editor", targetUserId: existingId },
      },
    ]);
  });

  it("returns 403 to known members while concealing the drawing from outsiders", async () => {
    await expect(service.list(existingId, drawingId)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    await expect(service.list(otherId, drawingId)).rejects.toMatchObject({
      code: "DRAWING_NOT_FOUND",
      status: 404,
    });
    await expect(
      service.invite(otherId, drawingId, {
        email: `concealed-${randomUUID()}@example.test`,
        role: "viewer",
      }),
    ).rejects.toMatchObject({ code: "DRAWING_NOT_FOUND", status: 404 });
  });

  it("stores only a token hash and exposes a manual URL only in creation", async () => {
    const email = `new-${randomUUID()}@example.test`;
    const result = await service.invite(ownerId, drawingId, {
      email,
      role: "viewer",
    });
    expect(result).toMatchObject({
      deliveryStatus: "manual",
      invitation: { email, role: "viewer", status: "pending" },
    });
    expect(result.manualUrl).toMatch(
      /^https:\/\/draw\.example\.test\/invite\//,
    );
    const token = new URL(result.manualUrl ?? "").pathname.split("/").at(-1);
    expect(token).toHaveLength(43);

    const stored = await database.pool.query<{ token_hash: Buffer }>(
      `SELECT token_hash FROM drawing_invitations WHERE id = $1`,
      [result.invitation?.id],
    );
    expect(stored.rows[0]?.token_hash).toHaveLength(32);
    expect(stored.rows[0]?.token_hash.toString("utf8")).not.toBe(token);

    const listed = await service.list(ownerId, drawingId);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(JSON.stringify(listed)).not.toContain("manualUrl");
  });

  it("issues a token instead of membership when the invited account is unverified", async () => {
    // An attacker who pre-registers an unclaimed address must not be handed
    // membership when an owner later invites that address; only the real
    // mailbox owner, proven by accepting the emailed token, may join.
    const verifyingService = new SharingService({
      repository,
      mailer: new DisabledMailer(),
      publicBaseUrl: "https://draw.example.test",
      requireVerifiedEmailForAcceptance: true,
    });
    const email = `squatted-${randomUUID()}@example.test`;
    const squatterId = randomUUID();
    additionalUserIds.push(squatterId);
    await database.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, 'Squatter', $2, false)`,
      [squatterId, email],
    );

    const result = await verifyingService.invite(ownerId, drawingId, {
      email,
      role: "editor",
    });

    expect(result.invitation).toMatchObject({ email, status: "pending" });
    expect(result.membership).toBeUndefined();
    const granted = await database.pool.query(
      `SELECT 1 FROM drawing_members WHERE drawing_id = $1 AND user_id = $2`,
      [drawingId, squatterId],
    );
    expect(granted.rowCount).toBe(0);

    // Once the address is verified, the direct-membership path is safe again.
    await database.pool.query(
      `UPDATE "user" SET email_verified = true WHERE id = $1`,
      [squatterId],
    );
    const afterVerification = await verifyingService.invite(
      ownerId,
      drawingId,
      { email, role: "editor" },
    );
    expect(afterVerification.membership).toMatchObject({
      userId: squatterId,
      role: "editor",
    });
  });

  it("returns a manual URL when SMTP delivery fails", async () => {
    const failingMailer: Mailer = {
      send: () => Promise.reject(new Error("SMTP adapter crashed")),
    };
    const failingService = new SharingService({
      repository,
      mailer: failingMailer,
      publicBaseUrl: "https://draw.example.test",
      requireVerifiedEmailForAcceptance: true,
    });
    const result = await failingService.invite(ownerId, drawingId, {
      email: `failed-${randomUUID()}@example.test`,
      role: "viewer",
    });
    expect(result.deliveryStatus).toBe("failed");
    expect(result.manualUrl).toBeDefined();
  });

  it("changes and revokes memberships, and invalidates tokens on cancel and reissue", async () => {
    await service.updateMember(ownerId, drawingId, existingId, "viewer");
    expect((await service.list(ownerId, drawingId)).members).toContainEqual(
      expect.objectContaining({ userId: existingId, role: "viewer" }),
    );
    await service.removeMember(ownerId, drawingId, existingId);
    expect((await service.list(ownerId, drawingId)).members).not.toContainEqual(
      expect.objectContaining({ userId: existingId }),
    );

    const email = `reissue-${randomUUID()}@example.test`;
    const first = await service.invite(ownerId, drawingId, {
      email,
      role: "viewer",
    });
    const firstToken = tokenFrom(first.manualUrl);
    await service.revokeInvitation(
      ownerId,
      drawingId,
      first.invitation?.id ?? "",
    );
    expect(await service.inspect(firstToken)).toMatchObject({
      invitation: { status: "revoked" },
    });

    const reissued = await service.invite(ownerId, drawingId, {
      email,
      role: "editor",
    });
    expect(tokenFrom(reissued.manualUrl)).not.toBe(firstToken);
    expect(reissued.invitation).toMatchObject({
      role: "editor",
      status: "pending",
    });
  });

  it("enforces email match and makes concurrent acceptance single-use", async () => {
    const pending = await service.invite(ownerId, drawingId, {
      email: "pending@example.test",
      role: "editor",
    });
    const token = tokenFrom(pending.manualUrl);

    await database.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, 'Pending Invitee', 'pending@example.test', true)`,
      [inviteeId],
    );

    await expect(
      service.accept(identity(otherId, "other@example.test"), token),
    ).rejects.toMatchObject({
      code: "INVITATION_EMAIL_MISMATCH",
      status: 403,
    });

    const outcomes = await Promise.allSettled([
      service.accept(identity(inviteeId, "pending@example.test"), token),
      service.accept(identity(inviteeId, "pending@example.test"), token),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { code: "INVITATION_USED", status: 409 },
    });
    const membership = await database.pool.query<{ role: string }>(
      `SELECT role FROM drawing_members WHERE drawing_id = $1 AND user_id = $2`,
      [drawingId, inviteeId],
    );
    expect(membership.rows).toEqual([{ role: "editor" }]);
  });

  it("serializes acceptance and reissue in drawing-first order without deadlock", async () => {
    const email = `race-${randomUUID()}@example.test`;
    const userId = randomUUID();
    additionalUserIds.push(userId);
    const pending = await service.invite(ownerId, drawingId, {
      email,
      role: "viewer",
    });
    await database.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, 'Race Invitee', $2, true)`,
      [userId, email],
    );

    const outcomes = await withTimeout(
      Promise.allSettled([
        service.accept(identity(userId, email), tokenFrom(pending.manualUrl)),
        service.invite(ownerId, drawingId, { email, role: "editor" }),
      ]),
      5_000,
    );
    expect(outcomes[1]).toMatchObject({ status: "fulfilled" });
    if (outcomes[0]?.status === "rejected") {
      expect(outcomes[0].reason).toMatchObject({ code: "INVITATION_REVOKED" });
    }
    const membership = await database.pool.query<{ role: string }>(
      `SELECT role FROM drawing_members WHERE drawing_id = $1 AND user_id = $2`,
      [drawingId, userId],
    );
    expect(membership.rows).toEqual([{ role: "editor" }]);
  });

  it("queues ACL revocation ahead of a content save and prevents a later old-role commit", async () => {
    const editorId = randomUUID();
    additionalUserIds.push(editorId);
    await database.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, 'Concurrent Editor', $2, true)`,
      [editorId, `${editorId}@example.test`],
    );
    await database.pool.query(
      `INSERT INTO drawing_members (drawing_id, user_id, role, created_by_user_id)
       VALUES ($1, $2, 'editor', $3)`,
      [drawingId, editorId, ownerId],
    );
    const content = new ContentService(
      new PostgresContentRepository(database.pool),
    );
    const before = await content.load(editorId, drawingId);
    const blocker = await database.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(`SELECT id FROM drawings WHERE id = $1 FOR UPDATE`, [
      drawingId,
    ]);

    const removal = service.removeMember(ownerId, drawingId, editorId);
    await waitForDrawingLockWaiter(database.pool);
    const save = content.save(
      editorId,
      drawingId,
      BigInt(before.revision),
      randomUUID(),
      { scene: textScene("revoked-editor"), assetIds: [] },
    );
    await blocker.query("COMMIT");
    blocker.release();

    await expect(removal).resolves.toBeUndefined();
    await expect(save).rejects.toMatchObject({
      code: "DRAWING_NOT_FOUND",
      status: 404,
    });
    expect((await content.load(ownerId, drawingId)).revision).toBe(
      before.revision,
    );
  });

  it("rejects expired, revoked, and unverified SMTP invitations", async () => {
    const expiringEmail = `expired-${randomUUID()}@example.test`;
    const expired = await service.invite(ownerId, drawingId, {
      email: expiringEmail,
      role: "viewer",
    });
    await database.pool.query(
      `UPDATE drawing_invitations SET expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [expired.invitation?.id],
    );
    await expect(
      service.accept(
        identity(otherId, expiringEmail),
        tokenFrom(expired.manualUrl),
      ),
    ).rejects.toMatchObject({
      code: "INVITATION_EXPIRED",
      status: 410,
    });

    const revoked = await service.invite(ownerId, drawingId, {
      email: `revoked-${randomUUID()}@example.test`,
      role: "viewer",
    });
    await service.revokeInvitation(
      ownerId,
      drawingId,
      revoked.invitation?.id ?? "",
    );
    await expect(
      service.accept(
        identity(otherId, revoked.invitation?.email ?? ""),
        tokenFrom(revoked.manualUrl),
      ),
    ).rejects.toMatchObject({
      code: "INVITATION_REVOKED",
      status: 410,
    });

    const smtpService = new SharingService({
      repository,
      mailer: new DisabledMailer(),
      publicBaseUrl: "https://draw.example.test",
      requireVerifiedEmailForAcceptance: true,
    });
    const verification = await smtpService.invite(ownerId, drawingId, {
      email: `verify-${randomUUID()}@example.test`,
      role: "viewer",
    });
    await expect(
      smtpService.accept(
        {
          ...identity(otherId, verification.invitation?.email ?? ""),
          emailVerified: false,
        },
        tokenFrom(verification.manualUrl),
      ),
    ).rejects.toMatchObject({
      code: "EMAIL_VERIFICATION_REQUIRED",
      status: 403,
    });
  });
});

function tokenFrom(url: string | undefined) {
  if (!url) throw new Error("Expected a manual invitation URL");
  const token = new URL(url).pathname.split("/").at(-1);
  if (!token) throw new Error("Invitation URL has no token");
  return token;
}

function identity(userId: string, email: string): RequestIdentity {
  return {
    userId,
    email,
    name: "Invitee",
    image: null,
    emailVerified: true,
    twoFactorEnabled: false,
    createdAt: new Date(),
    authKind: "session",
    sessionId: randomUUID(),
    sessionExpiresAt: new Date(Date.now() + 60_000),
  };
}

function textScene(id: string) {
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

async function waitForDrawingLockWaiter(pool: Pool, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query LIKE '%SELECT owner_user_id FROM drawings%'
       ) AS waiting`,
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("ACL mutation did not wait for the drawing lock");
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Concurrent operation timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describeDatabase("public share link lifecycle", () => {
  const database = createDatabase(databaseUrl ?? "postgresql://unused");
  const ownerId = randomUUID();
  const editorId = randomUUID();
  const drawingId = randomUUID();
  const repository = new PostgresSharingRepository(database.pool);
  const revokedLinks: Array<{ drawingId: string; linkId: string }> = [];
  const service = new SharingService({
    repository,
    mailer: new DisabledMailer(),
    publicBaseUrl: "https://draw.example.test",
    requireVerifiedEmailForAcceptance: false,
    shareLinkEvents: {
      revoked: (revokedDrawingId, linkId) => {
        revokedLinks.push({ drawingId: revokedDrawingId, linkId });
      },
    },
  });

  const tokenFromUrl = (url: string) =>
    decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");

  beforeAll(async () => {
    await runMigrations({ pool: database.pool });
    await database.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES
         ($1, 'Link Owner', $2, true),
         ($3, 'Link Editor', $4, true)`,
      [
        ownerId,
        `${ownerId}@example.test`,
        editorId,
        `${editorId}@example.test`,
      ],
    );
    const scene = JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "test",
      elements: [],
      appState: {},
    });
    await database.pool.query(
      `INSERT INTO drawings
         (id, owner_user_id, title, scene, scene_format_version, scene_bytes)
       VALUES ($1, $2, 'Linked drawing', $3::jsonb, 2, $4)`,
      [drawingId, ownerId, scene, Buffer.byteLength(scene)],
    );
    await database.pool.query(
      `INSERT INTO drawing_members (drawing_id, user_id, role, created_by_user_id)
       VALUES ($1, $2, 'editor', $3)`,
      [drawingId, editorId, ownerId],
    );
  });

  afterAll(async () => {
    await database.pool.query(`DELETE FROM drawings WHERE id = $1`, [
      drawingId,
    ]);
    await database.pool.query(`DELETE FROM "user" WHERE id = ANY($1::uuid[])`, [
      [ownerId, editorId],
    ]);
    await database.close();
  });

  it("creates, resolves, regenerates, and revokes the link", async () => {
    const created = await service.createShareLink(ownerId, drawingId);
    const firstToken = tokenFromUrl(created.url);
    expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(revokedLinks).toHaveLength(0);

    const status = await service.getShareLink(ownerId, drawingId);
    expect(status).toMatchObject({ active: true, url: created.url });

    const shared = await service.inspectShareToken(firstToken);
    expect(shared).toMatchObject({
      drawingId,
      title: "Linked drawing",
      revision: "0",
    });
    expect(shared.scene.type).toBe("excalidraw");

    const regenerated = await service.createShareLink(ownerId, drawingId);
    const secondToken = tokenFromUrl(regenerated.url);
    expect(secondToken).not.toBe(firstToken);
    expect(revokedLinks).toHaveLength(1);
    await expect(service.inspectShareToken(firstToken)).rejects.toMatchObject({
      code: "SHARE_LINK_NOT_FOUND",
    });
    await expect(service.inspectShareToken(secondToken)).resolves.toMatchObject(
      { drawingId },
    );

    await service.revokeShareLink(ownerId, drawingId);
    expect(revokedLinks).toHaveLength(2);
    await expect(service.getShareLink(ownerId, drawingId)).resolves.toEqual({
      active: false,
    });
    await expect(service.inspectShareToken(secondToken)).rejects.toMatchObject({
      code: "SHARE_LINK_NOT_FOUND",
    });
    await expect(
      service.revokeShareLink(ownerId, drawingId),
    ).rejects.toMatchObject({ code: "SHARE_LINK_NOT_FOUND" });
  });

  it("conceals link management from editors and outsiders", async () => {
    await expect(
      service.createShareLink(editorId, drawingId),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(
      service.createShareLink(randomUUID(), drawingId),
    ).rejects.toMatchObject({ code: "DRAWING_NOT_FOUND", status: 404 });
    await expect(
      service.getShareLink(editorId, drawingId),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("stops resolving tokens of a soft-deleted drawing", async () => {
    const created = await service.createShareLink(ownerId, drawingId);
    const token = tokenFromUrl(created.url);
    await database.pool.query(
      `UPDATE drawings SET deleted_at = now() WHERE id = $1`,
      [drawingId],
    );
    try {
      await expect(service.inspectShareToken(token)).rejects.toMatchObject({
        code: "SHARE_LINK_NOT_FOUND",
      });
    } finally {
      await database.pool.query(
        `UPDATE drawings SET deleted_at = NULL WHERE id = $1`,
        [drawingId],
      );
    }
  });
});
