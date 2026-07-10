import { DisabledMailer } from "@open-excalidraw/mail";
import type { DBAdapter, DBAdapterInstance, Where } from "better-auth";
import express from "express";
import { randomUUID } from "node:crypto";
import request from "supertest";

import {
  authCapabilities,
  buildBetterAuthOptions,
  createAuthRouter,
  createIdentityService,
  createOpenExcalidrawAuth,
  hashSessionToken,
  OneTimeManualResetLinkStore,
  withHashedSessionTokens,
} from "../src/modules/auth/index.js";

const BASE_URL = "https://draw.example.test";
const SECRET = "test-secret-that-is-at-least-thirty-two-characters-long";
const ADMIN_RESET_TOKEN =
  "admin-reset-token-that-is-at-least-thirty-two-characters";

describe("Better Auth configuration", () => {
  it("hashes verification identifiers, generates UUIDs, and omits partial OAuth providers", () => {
    const options = buildBetterAuthOptions({
      database: {} as never,
      mailer: new DisabledMailer(),
      baseUrl: BASE_URL,
      secret: SECRET,
      smtpEnabled: false,
      google: { clientId: "", clientSecret: "missing" },
      github: { clientId: "github-id", clientSecret: "github-secret" },
    });

    expect(options.advanced?.database?.generateId).toBe("uuid");
    expect(options.verification?.storeIdentifier).toBe("hashed");
    expect(options.session).toMatchObject({
      expiresIn: 60 * 60 * 24 * 7,
      cookieCache: { enabled: false },
    });
    expect(options.socialProviders).toEqual({
      github: { clientId: "github-id", clientSecret: "github-secret" },
    });
    expect(options.account).toMatchObject({
      encryptOAuthTokens: true,
      accountLinking: {
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
      },
    });
  });

  it("reports OAuth and SMTP capabilities only when fully configured", () => {
    expect(
      authCapabilities({
        smtpEnabled: false,
        google: { clientId: "google", clientSecret: "secret" },
      }),
    ).toEqual({
      emailPassword: true,
      google: true,
      github: false,
      smtp: false,
    });
  });
});

describe("hashed database sessions", () => {
  it("stores only a hash while preserving the raw request token for cookies", async () => {
    const memory = createMemoryAdapter();
    const adapter = withHashedSessionTokens(memory.factory)({});
    const rawToken = "raw-cookie-session-token";

    const created = await adapter.create<{ token: string; userId: string }>({
      model: "session",
      data: { token: rawToken, userId: randomUUID() },
    });
    expect(created.token).toBe(rawToken);
    expect(memory.rows.session![0]?.token).toBe(hashSessionToken(rawToken));
    expect(memory.rows.session![0]?.token).not.toContain(rawToken);

    const found = await adapter.findOne<{ token: string }>({
      model: "session",
      where: [{ field: "token", value: rawToken }],
    });
    expect(found?.token).toBe(rawToken);
  });
});

describe("auth HTTP boundary", () => {
  it("keeps forgot-password responses generic and stores disabled-mail links only behind the admin boundary", async () => {
    const memory = createMemoryAdapter();
    memory.rows.user!.push(testUser("known@example.test"));
    const resetLinks = new OneTimeManualResetLinkStore();
    const auth = createOpenExcalidrawAuth({
      database: {} as never,
      databaseAdapter: memory.factory,
      mailer: new DisabledMailer(),
      manualResetLinks: resetLinks,
      baseUrl: BASE_URL,
      secret: SECRET,
      smtpEnabled: false,
      secureCookies: true,
    });
    const app = express();
    app.use(express.json());
    app.use(
      createAuthRouter({
        auth,
        identity: createIdentityService(auth),
        capabilities: authCapabilities({ smtpEnabled: false }),
        adminResetToken: ADMIN_RESET_TOKEN,
        manualResetLinks: resetLinks,
      }),
    );

    const known = await request(app)
      .post("/api/auth/request-password-reset")
      .set("origin", BASE_URL)
      .send({ email: "known@example.test", redirectTo: "/reset" });
    const unknown = await request(app)
      .post("/api/auth/request-password-reset")
      .set("origin", BASE_URL)
      .send({ email: "unknown@example.test", redirectTo: "/reset" });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect(JSON.stringify(known.body)).not.toContain("known@example.test");
    await request(app)
      .post("/api/admin/manual-reset-links/consume")
      .set("authorization", "Bearer wrong-token")
      .send({ email: "known@example.test" })
      .expect(401);
    const manualResponse = await request(app)
      .post("/api/admin/manual-reset-links/consume")
      .set("authorization", `Bearer ${ADMIN_RESET_TOKEN}`)
      .send({ email: "known@example.test" })
      .expect(200);
    const manualLink = manualResponse.body as { url: string };
    expect(manualLink?.url).toContain("/api/auth/reset-password/");
    const plaintextResetToken = manualLink?.url.match(
      /\/reset-password\/([^?]+)/,
    )?.[1];
    const storedIdentifier = String(memory.rows.verification![0]?.identifier);
    expect(plaintextResetToken).toBeTruthy();
    expect(storedIdentifier).not.toContain("reset-password:");
    expect(storedIdentifier).not.toContain(plaintextResetToken);
    await request(app)
      .post("/api/admin/manual-reset-links/consume")
      .set("authorization", `Bearer ${ADMIN_RESET_TOKEN}`)
      .send({ email: "known@example.test" })
      .expect(404);
    expect(resetLinks.consume("unknown@example.test")).toBeNull();
  });

  it("issues secure same-site cookies with the configured expiration and rejects disabled OAuth", async () => {
    const memory = createMemoryAdapter();
    const auth = createOpenExcalidrawAuth({
      database: {} as never,
      databaseAdapter: memory.factory,
      mailer: new DisabledMailer(),
      baseUrl: BASE_URL,
      secret: SECRET,
      smtpEnabled: false,
      secureCookies: true,
      sessionExpiresInSeconds: 3600,
    });
    const app = express();
    app.use(express.json());
    app.use(
      createAuthRouter({
        auth,
        identity: createIdentityService(auth),
        capabilities: authCapabilities({ smtpEnabled: false }),
      }),
    );

    const signup = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", BASE_URL)
      .send({
        name: "New User",
        email: "new@example.test",
        password: "correct-horse-battery-staple",
      });
    expect(signup.status).toBe(200);
    const cookies = signup.headers["set-cookie"];
    const cookieLines = Array.isArray(cookies) ? cookies : [String(cookies)];
    expect(cookieLines.join("\n")).toContain("HttpOnly");
    expect(cookieLines.join("\n")).toContain("Secure");
    expect(cookieLines.join("\n")).toContain("SameSite=Lax");

    const storedSession = memory.rows.session![0];
    expect(storedSession?.token).toMatch(/^sha256:/);
    const lifetime =
      (storedSession?.expiresAt as Date).getTime() -
      (storedSession?.createdAt as Date).getTime();
    expect(lifetime).toBeGreaterThanOrEqual(3_599_000);
    expect(lifetime).toBeLessThanOrEqual(3_601_000);

    const sessionCookieName = cookieLines
      .find((cookie) => cookie.includes("session_token="))
      ?.split("=", 1)[0];
    expect(sessionCookieName).toBeTruthy();
    const leakedHash = String(storedSession?.token);
    const unsignedHashCookie = await request(app)
      .get("/api/v1/me")
      .set("cookie", `${sessionCookieName}=${encodeURIComponent(leakedHash)}`);
    expect(unsignedHashCookie.body.user).toBeNull();
    const bearerHash = await request(app)
      .get("/api/v1/me")
      .set("authorization", `Bearer ${leakedHash}`);
    expect(bearerHash.body.user).toBeNull();
    await request(app).post("/api/auth/revoke-other-sessions").expect(404);
    await request(app).get("/api/auth/list-sessions").expect(404);
    expect(memory.rows.session).toHaveLength(1);

    const oauth = await request(app)
      .post("/api/auth/sign-in/social")
      .set("origin", BASE_URL)
      .send({ provider: "google", callbackURL: "/dashboard" });
    expect(oauth.status).toBeGreaterThanOrEqual(400);
  });
});

function testUser(email: string): Record<string, unknown> {
  const now = new Date();
  return {
    id: randomUUID(),
    name: "Known User",
    email,
    emailVerified: false,
    image: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createMemoryAdapter() {
  const rows: Record<string, Array<Record<string, unknown>>> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };

  const factory: DBAdapterInstance = () => {
    const adapter: DBAdapter = {
      id: "open-excalidraw-test-memory",
      create<T extends Record<string, unknown>, R = T>(input: {
        model: string;
        data: Omit<T, "id">;
      }): Promise<R> {
        const row = { id: randomUUID(), ...input.data };
        rows[input.model] ??= [];
        rows[input.model]!.push(row);
        return Promise.resolve(row as R);
      },
      findOne(input) {
        const row = rows[input.model]?.find((candidate) =>
          matches(candidate, input.where),
        );
        if (!row) return Promise.resolve(null);
        if (input.model === "user" && input.join?.account) {
          return Promise.resolve({
            ...row,
            account: rows.account!.filter(
              (account) => account.userId === row.id,
            ),
          } as never);
        }
        return Promise.resolve({ ...row } as never);
      },
      findMany(input) {
        return Promise.resolve(
          (rows[input.model] ?? [])
            .filter((candidate) => matches(candidate, input.where ?? []))
            .map((row) => ({ ...row })) as never[],
        );
      },
      count(input) {
        return Promise.resolve(
          (rows[input.model] ?? []).filter((candidate) =>
            matches(candidate, input.where ?? []),
          ).length,
        );
      },
      update(input) {
        const row = rows[input.model]?.find((candidate) =>
          matches(candidate, input.where),
        );
        if (!row) return Promise.resolve(null);
        Object.assign(row, input.update);
        return Promise.resolve({ ...row } as never);
      },
      updateMany(input) {
        const matched = (rows[input.model] ?? []).filter((candidate) =>
          matches(candidate, input.where),
        );
        matched.forEach((row) => Object.assign(row, input.update));
        return Promise.resolve(matched.length);
      },
      delete(input) {
        removeMatches(rows, input.model, input.where, 1);
        return Promise.resolve();
      },
      deleteMany(input) {
        return Promise.resolve(removeMatches(rows, input.model, input.where));
      },
      consumeOne(input) {
        const row = rows[input.model]?.find((candidate) =>
          matches(candidate, input.where),
        );
        if (!row) return Promise.resolve(null);
        removeMatches(
          rows,
          input.model,
          [{ field: "id", value: String(row.id) }],
          1,
        );
        return Promise.resolve(row as never);
      },
      incrementOne(input) {
        const row = rows[input.model]?.find((candidate) =>
          matches(candidate, input.where),
        );
        if (!row) return Promise.resolve(null);
        for (const [field, increment] of Object.entries(input.increment)) {
          row[field] = Number(row[field] ?? 0) + increment;
        }
        Object.assign(row, input.set);
        return Promise.resolve(row as never);
      },
      async transaction(callback) {
        return callback(adapter);
      },
    };
    return adapter;
  };

  return { factory, rows };
}

function matches(row: Record<string, unknown>, where: Where[]): boolean {
  return where.every((condition) => {
    const current = row[condition.field];
    switch (condition.operator ?? "eq") {
      case "eq":
        return current === condition.value;
      case "in":
        return (
          Array.isArray(condition.value) &&
          condition.value.includes(current as never)
        );
      case "gt":
        return current instanceof Date && condition.value instanceof Date
          ? current > condition.value
          : Number(current) > Number(condition.value);
      case "lt":
        return current instanceof Date && condition.value instanceof Date
          ? current < condition.value
          : Number(current) < Number(condition.value);
      default:
        return false;
    }
  });
}

function removeMatches(
  rows: Record<string, Array<Record<string, unknown>>>,
  model: string,
  where: Where[],
  limit = Number.POSITIVE_INFINITY,
): number {
  const source = rows[model] ?? [];
  let removed = 0;
  rows[model] = source.filter((row) => {
    if (removed < limit && matches(row, where)) {
      removed += 1;
      return false;
    }
    return true;
  });
  return removed;
}
