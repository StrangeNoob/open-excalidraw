import { randomUUID } from "node:crypto";

import { createDatabase, runMigrations } from "@open-excalidraw/database";
import express from "express";
import request from "supertest";

import {
  createIdentityService,
  type OpenExcalidrawAuth,
} from "../src/modules/auth/index.js";
import { PostgresMentionNotificationRepository } from "../src/modules/chat/index.js";
import {
  createNotificationRouter,
  PostgresNotificationSettingsRepository,
} from "../src/modules/notifications/index.js";

const databaseUrl = process.env.DATABASE_TEST_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

// Stands in for cookie-session resolution: the `x-test-user` header is the
// signed-in user. Token resolution is out of scope here.
function sessionAuthStub(): OpenExcalidrawAuth {
  return {
    api: {
      getSession: ({ headers }: { headers: Headers }) => {
        const userId = headers.get("x-test-user");
        if (!userId) return Promise.resolve(null);
        return Promise.resolve({
          user: {
            id: userId,
            email: `${userId}@example.test`,
            name: "Session User",
            image: null,
            emailVerified: true,
            twoFactorEnabled: false,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          },
          session: {
            id: randomUUID(),
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        });
      },
    },
  } as unknown as OpenExcalidrawAuth;
}

describeDatabase("mention notification settings and cooldown", () => {
  const database = createDatabase(databaseUrl ?? "postgresql://unused");
  const settings = new PostgresNotificationSettingsRepository(database.pool);
  const mentions = new PostgresMentionNotificationRepository(database.pool);
  const identity = createIdentityService(sessionAuthStub(), {
    resolve: () => Promise.resolve(null),
  });

  const app = express();
  app.use(express.json());
  app.use(createNotificationRouter({ repository: settings, identity }));

  const ownerId = randomUUID();
  const drawingId = randomUUID();
  const createdUsers: string[] = [ownerId];

  const asSession = (userId: string) => (r: request.Test) =>
    r.set("x-test-user", userId);

  async function createUser(): Promise<string> {
    const id = randomUUID();
    await database.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, 'Mentioned User', $2, true)`,
      [id, `${id}@example.test`],
    );
    createdUsers.push(id);
    return id;
  }

  async function addMember(userId: string): Promise<string> {
    await database.pool.query(
      `INSERT INTO drawing_members (drawing_id, user_id, role, created_by_user_id)
       VALUES ($1, $2, 'editor', $3)`,
      [drawingId, userId, ownerId],
    );
    return userId;
  }

  beforeAll(async () => {
    await runMigrations({ pool: database.pool });
    await database.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, 'Drawing Owner', $2, true)`,
      [ownerId, `${ownerId}@example.test`],
    );
    await database.pool.query(
      `INSERT INTO drawings
         (id, owner_user_id, title, scene, scene_format_version, scene_bytes)
       VALUES ($1, $2, 'Roadmap', '{}'::jsonb, 2, 2)`,
      [drawingId, ownerId],
    );
  });

  afterAll(async () => {
    await database.pool.query(`DELETE FROM drawings WHERE id = $1`, [
      drawingId,
    ]);
    await database.pool.query(`DELETE FROM "user" WHERE id = ANY($1::uuid[])`, [
      createdUsers,
    ]);
    await database.close();
  });

  it("defaults to on, persists an opt-out, and reads it back", async () => {
    const userId = await createUser();

    // No settings row yet: absent means opted in.
    const initial = await asSession(userId)(
      request(app).get("/api/v1/notification-settings"),
    );
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({ mentionEmails: true });

    const saved = await asSession(userId)(
      request(app)
        .put("/api/v1/notification-settings")
        .send({ mentionEmails: false }),
    );
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ mentionEmails: false });

    const reread = await asSession(userId)(
      request(app).get("/api/v1/notification-settings"),
    );
    expect(reread.body).toEqual({ mentionEmails: false });

    // The upsert path: a second write updates the existing row.
    const reenabled = await asSession(userId)(
      request(app)
        .put("/api/v1/notification-settings")
        .send({ mentionEmails: true }),
    );
    expect(reenabled.body).toEqual({ mentionEmails: true });
    const rows = await database.pool.query(
      `SELECT mention_emails FROM user_notification_settings WHERE user_id = $1`,
      [userId],
    );
    expect(rows.rows).toEqual([{ mention_emails: true }]);
  });

  it("keeps settings per user and rejects unauthenticated or invalid writes", async () => {
    const optedOut = await createUser();
    const untouched = await createUser();
    await asSession(optedOut)(
      request(app)
        .put("/api/v1/notification-settings")
        .send({ mentionEmails: false }),
    );

    const other = await asSession(untouched)(
      request(app).get("/api/v1/notification-settings"),
    );
    expect(other.body).toEqual({ mentionEmails: true });

    const anonymous = await request(app).get("/api/v1/notification-settings");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe("AUTHENTICATION_REQUIRED");

    const invalid = await asSession(optedOut)(
      request(app)
        .put("/api/v1/notification-settings")
        .send({ mentionEmails: "no" }),
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("INVALID_REQUEST");
    // The rejected write left the stored preference alone.
    const unchanged = await asSession(optedOut)(
      request(app).get("/api/v1/notification-settings"),
    );
    expect(unchanged.body).toEqual({ mentionEmails: false });
  });

  it("suppresses the mention email of a user who opted out through the API", async () => {
    const optedIn = await addMember(await createUser());
    const optedOut = await addMember(await createUser());
    await asSession(optedOut)(
      request(app)
        .put("/api/v1/notification-settings")
        .send({ mentionEmails: false }),
    );

    const recipients = await mentions.findMentionRecipients({
      drawingId,
      userIds: [optedIn, optedOut],
    });

    expect(
      recipients.map(({ userId, mentionEmails }) => ({
        userId,
        mentionEmails,
      })),
    ).toEqual(
      expect.arrayContaining([
        { userId: optedIn, mentionEmails: true },
        { userId: optedOut, mentionEmails: false },
      ]),
    );
    expect(recipients.every((r) => r.drawingTitle === "Roadmap")).toBe(true);
  });

  it("returns the owner and members only, never an unrelated user", async () => {
    const member = await addMember(await createUser());
    const stranger = await createUser();

    const recipients = await mentions.findMentionRecipients({
      drawingId,
      userIds: [member, stranger, ownerId],
    });

    expect(recipients.map((entry) => entry.userId).sort()).toEqual(
      [member, ownerId].sort(),
    );
  });

  it("claims a mention cooldown once per window and again once it expires", async () => {
    const userId = await createUser();
    const claim = () =>
      mentions.claimMentionEmailCooldown({
        drawingId,
        userIds: [userId],
        cooldownMinutes: 15,
      });

    // Fresh pair: the first claim wins and writes the ledger row.
    await expect(claim()).resolves.toEqual([userId]);
    const stored = await database.pool.query<{ last_sent_at: Date }>(
      `SELECT last_sent_at FROM mention_email_state
       WHERE user_id = $1 AND drawing_id = $2`,
      [userId, drawingId],
    );
    expect(stored.rowCount).toBe(1);

    // Inside the window every further mention is suppressed, however many.
    await expect(claim()).resolves.toEqual([]);
    await expect(claim()).resolves.toEqual([]);

    // Once the window has passed the same pair may be emailed again, and the
    // row is updated rather than duplicated.
    await database.pool.query(
      `UPDATE mention_email_state SET last_sent_at = now() - interval '16 minutes'
       WHERE user_id = $1 AND drawing_id = $2`,
      [userId, drawingId],
    );
    await expect(claim()).resolves.toEqual([userId]);
    const after = await database.pool.query(
      `SELECT count(*) AS n FROM mention_email_state WHERE user_id = $1`,
      [userId],
    );
    expect(Number(after.rows[0].n)).toBe(1);
  });

  it("claims each recipient of a batch independently", async () => {
    const cooled = await createUser();
    const fresh = await createUser();
    await mentions.claimMentionEmailCooldown({
      drawingId,
      userIds: [cooled],
      cooldownMinutes: 15,
    });

    const claimed = await mentions.claimMentionEmailCooldown({
      drawingId,
      userIds: [cooled, fresh],
      cooldownMinutes: 15,
    });

    expect(claimed).toEqual([fresh]);
  });

  it("drops cooldown rows when the drawing is deleted", async () => {
    const userId = await createUser();
    const temporaryDrawing = randomUUID();
    await database.pool.query(
      `INSERT INTO drawings
         (id, owner_user_id, title, scene, scene_format_version, scene_bytes)
       VALUES ($1, $2, 'Temporary', '{}'::jsonb, 2, 2)`,
      [temporaryDrawing, ownerId],
    );
    await mentions.claimMentionEmailCooldown({
      drawingId: temporaryDrawing,
      userIds: [userId],
      cooldownMinutes: 15,
    });

    await database.pool.query(`DELETE FROM drawings WHERE id = $1`, [
      temporaryDrawing,
    ]);

    const remaining = await database.pool.query(
      `SELECT 1 FROM mention_email_state WHERE drawing_id = $1`,
      [temporaryDrawing],
    );
    expect(remaining.rowCount).toBe(0);
  });
});
