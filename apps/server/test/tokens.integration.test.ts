import { randomBytes, randomUUID } from "node:crypto";

import { PERSONAL_ACCESS_TOKEN_PREFIX } from "@open-excalidraw/contracts";
import { createDatabase, runMigrations } from "@open-excalidraw/database";
import type {
  ObjectStorage,
  PutObjectResult,
  StorageKey,
} from "@open-excalidraw/storage";
import express from "express";
import request from "supertest";

import {
  createIdentityService,
  type OpenExcalidrawAuth,
} from "../src/modules/auth/index.js";
import {
  createDrawingRouter,
  DrawingService,
  PostgresDrawingRepository,
  storageDrawingBlobStore,
} from "../src/modules/drawings/index.js";
import {
  createTokenRouter,
  PostgresTokenRepository,
  TokenService,
} from "../src/modules/tokens/index.js";

const databaseUrl = process.env.DATABASE_TEST_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

// A fake better-auth whose getSession trusts an `x-test-user` header. The token
// path in createIdentityService uses the REAL repository against Postgres; this
// stub only stands in for cookie-session resolution so both branches — and the
// no-fallthrough rule between them — exercise the real seam.
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

class InMemoryObjectStorage implements ObjectStorage {
  public put(key: StorageKey): Promise<PutObjectResult> {
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
  public delete(): Promise<{ deleted: boolean }> {
    return Promise.resolve({ deleted: true });
  }
}

const garbageSecret = () =>
  PERSONAL_ACCESS_TOKEN_PREFIX + randomBytes(32).toString("base64url");

describeDatabase("personal access tokens", () => {
  const database = createDatabase(databaseUrl ?? "postgresql://unused");
  const tokenRepository = new PostgresTokenRepository(database.pool);
  const tokenService = new TokenService(tokenRepository);
  const drawingService = new DrawingService(
    new PostgresDrawingRepository(
      database.pool,
      storageDrawingBlobStore(new InMemoryObjectStorage()),
    ),
  );
  const identity = createIdentityService(sessionAuthStub(), {
    resolve: (secret) => tokenService.resolveIdentity(secret),
  });

  const app = express();
  app.use(express.json());
  app.use(createTokenRouter({ service: tokenService, identity }));
  app.use(createDrawingRouter({ service: drawingService, identity }));

  const createdUsers: string[] = [];

  async function createUser(): Promise<string> {
    const id = randomUUID();
    await database.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, 'Token User', $2, true)`,
      [id, `${id}@example.test`],
    );
    createdUsers.push(id);
    return id;
  }

  const asSession = (userId: string) => (r: request.Test) =>
    r.set("x-test-user", userId);
  const asBearer = (secret: string) => (r: request.Test) =>
    r.set("authorization", `Bearer ${secret}`);

  async function createToken(
    userId: string,
    body: { name: string; expiresInDays: number | null } = {
      name: "ci",
      expiresInDays: null,
    },
  ): Promise<{ secret: string; tokenId: string }> {
    const response = await asSession(userId)(
      request(app).post("/api/v1/tokens").send(body),
    );
    expect(response.status).toBe(201);
    return { secret: response.body.secret, tokenId: response.body.token.id };
  }

  beforeAll(async () => {
    await runMigrations({ pool: database.pool });
  });

  afterAll(async () => {
    await database.pool.query(
      `DELETE FROM drawings WHERE owner_user_id = ANY($1::uuid[])`,
      [createdUsers],
    );
    await database.pool.query(
      `DELETE FROM audit_events WHERE actor_user_id = ANY($1::uuid[])`,
      [createdUsers],
    );
    await database.pool.query(`DELETE FROM "user" WHERE id = ANY($1::uuid[])`, [
      createdUsers,
    ]);
    await database.close();
  });

  it("creates, lists, and revokes a token over a session, hiding the secret", async () => {
    const userId = await createUser();

    const created = await asSession(userId)(
      request(app)
        .post("/api/v1/tokens")
        .send({ name: "laptop", expiresInDays: null }),
    );
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^oepat_[A-Za-z0-9_-]{43}$/);
    expect(created.body.token.name).toBe("laptop");
    expect(created.body.token.lastFour).toBe(created.body.secret.slice(-4));
    expect(created.body.token.expiresAt).toBeNull();
    expect(created.body.token.lastUsedAt).toBeNull();
    // The metadata object never leaks the secret or a hash.
    expect(created.body.token).not.toHaveProperty("secret");
    expect(created.body.token).not.toHaveProperty("tokenHash");

    const listed = await asSession(userId)(request(app).get("/api/v1/tokens"));
    expect(listed.status).toBe(200);
    expect(listed.body.tokens).toHaveLength(1);
    expect(listed.body.tokens[0].id).toBe(created.body.token.id);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.secret);

    const revoked = await asSession(userId)(
      request(app).delete(`/api/v1/tokens/${created.body.token.id}`),
    );
    expect(revoked.status).toBe(204);

    const empty = await asSession(userId)(request(app).get("/api/v1/tokens"));
    expect(empty.body.tokens).toHaveLength(0);
  });

  it("returns 404 revoking a token owned by another user", async () => {
    const owner = await createUser();
    const other = await createUser();
    const { tokenId } = await createToken(owner);

    const foreign = await asSession(other)(
      request(app).delete(`/api/v1/tokens/${tokenId}`),
    );
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe("TOKEN_NOT_FOUND");

    // The owner's token is untouched.
    const stillThere = await asSession(owner)(
      request(app).get("/api/v1/tokens"),
    );
    expect(stillThere.body.tokens).toHaveLength(1);
  });

  it("authenticates a real REST call as the token's owner", async () => {
    const userId = await createUser();
    const drawingId = randomUUID();
    await database.pool.query(
      `INSERT INTO drawings
         (id, owner_user_id, title, scene, scene_format_version, scene_bytes)
       VALUES ($1, $2, 'Owned', '{}'::jsonb, 1, 2)`,
      [drawingId, userId],
    );
    const { secret } = await createToken(userId);

    const response = await asBearer(secret)(
      request(app).get("/api/v1/drawings"),
    );
    expect(response.status).toBe(200);
    const ids = response.body.owned.map((d: { id: string }) => d.id);
    expect(ids).toContain(drawingId);
  });

  it("rejects expired, revoked, garbage, and disabled-user tokens with 401", async () => {
    const userId = await createUser();

    const expired = await createToken(userId, {
      name: "exp",
      expiresInDays: 1,
    });
    await database.pool.query(
      `UPDATE personal_access_tokens SET expires_at = now() - interval '1 day'
       WHERE user_id = $1`,
      [userId],
    );
    const expiredResponse = await asBearer(expired.secret)(
      request(app).get("/api/v1/drawings"),
    );
    expect(expiredResponse.status).toBe(401);

    const revokedUser = await createUser();
    const revoked = await createToken(revokedUser);
    await asSession(revokedUser)(
      request(app).delete(`/api/v1/tokens/${revoked.tokenId}`),
    );
    const revokedResponse = await asBearer(revoked.secret)(
      request(app).get("/api/v1/drawings"),
    );
    expect(revokedResponse.status).toBe(401);

    const garbageResponse = await asBearer(garbageSecret())(
      request(app).get("/api/v1/drawings"),
    );
    expect(garbageResponse.status).toBe(401);

    const disabledUser = await createUser();
    const disabled = await createToken(disabledUser);
    await database.pool.query(
      `UPDATE "user" SET disabled_at = now() WHERE id = $1`,
      [disabledUser],
    );
    const disabledResponse = await asBearer(disabled.secret)(
      request(app).get("/api/v1/drawings"),
    );
    expect(disabledResponse.status).toBe(401);
  });

  it("never falls back to a session cookie when a bearer token is invalid", async () => {
    const userId = await createUser();

    // A valid session header alongside a garbage bearer must still be 401: the
    // explicit bearer attempt owns the request and does not fall through.
    const response = await request(app)
      .get("/api/v1/drawings")
      .set("x-test-user", userId)
      .set("authorization", `Bearer ${garbageSecret()}`);
    expect(response.status).toBe(401);

    // The same session header without the bearer resolves normally.
    const sessionOnly = await asSession(userId)(
      request(app).get("/api/v1/drawings"),
    );
    expect(sessionOnly.status).toBe(200);
  });

  it("forbids managing tokens with a bearer token", async () => {
    const userId = await createUser();
    const { secret } = await createToken(userId);

    const list = await asBearer(secret)(request(app).get("/api/v1/tokens"));
    expect(list.status).toBe(403);
    expect(list.body.code).toBe("TOKEN_MANAGEMENT_REQUIRES_SESSION");

    const create = await asBearer(secret)(
      request(app)
        .post("/api/v1/tokens")
        .send({ name: "nope", expiresInDays: null }),
    );
    expect(create.status).toBe(403);
    expect(create.body.code).toBe("TOKEN_MANAGEMENT_REQUIRES_SESSION");

    const remove = await asBearer(secret)(
      request(app).delete(`/api/v1/tokens/${randomUUID()}`),
    );
    expect(remove.status).toBe(403);
    expect(remove.body.code).toBe("TOKEN_MANAGEMENT_REQUIRES_SESSION");
  });

  it("caps a user at 25 tokens", async () => {
    const userId = await createUser();
    for (let i = 0; i < 25; i += 1) {
      await createToken(userId, { name: `t${i}`, expiresInDays: null });
    }
    const overflow = await asSession(userId)(
      request(app)
        .post("/api/v1/tokens")
        .send({ name: "26th", expiresInDays: null }),
    );
    expect(overflow.status).toBe(400);
    expect(overflow.body.code).toBe("TOKEN_LIMIT_REACHED");
  });

  it("audits create and revoke without any secret material", async () => {
    const userId = await createUser();
    const { secret, tokenId } = await createToken(userId, {
      name: "audited",
      expiresInDays: null,
    });
    await asSession(userId)(request(app).delete(`/api/v1/tokens/${tokenId}`));

    const audit = await database.pool.query<{
      event_type: string;
      metadata: { tokenId: string; name: string };
    }>(
      `SELECT event_type, metadata FROM audit_events
       WHERE actor_user_id = $1 AND event_type IN ('token.created', 'token.revoked')
       ORDER BY created_at ASC`,
      [userId],
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      "token.created",
      "token.revoked",
    ]);
    for (const row of audit.rows) {
      expect(row.metadata).toEqual({ tokenId, name: "audited" });
      expect(JSON.stringify(row.metadata)).not.toContain(secret);
      expect(JSON.stringify(row.metadata)).not.toContain(secret.slice(6));
    }
  });
});
