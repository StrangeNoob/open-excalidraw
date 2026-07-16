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
      oidc: false,
      oidcProviderName: "SSO",
      smtp: false,
    });
  });

  it("registers the generic OAuth plugin when OIDC is fully configured", () => {
    const options = buildBetterAuthOptions({
      database: {} as never,
      mailer: new DisabledMailer(),
      baseUrl: BASE_URL,
      secret: SECRET,
      smtpEnabled: false,
      oidc: {
        issuerUrl: "https://idp.example.test/realms/main/",
        clientId: "oidc-id",
        clientSecret: "oidc-secret",
      },
    });

    expect(options.plugins).toHaveLength(1);
    const plugin = options.plugins?.[0] as unknown as {
      id: string;
      options: { config: Array<Record<string, unknown>> };
    };
    expect(plugin.id).toBe("generic-oauth");
    expect(plugin.options.config[0]).toMatchObject({
      providerId: "oidc",
      discoveryUrl:
        "https://idp.example.test/realms/main/.well-known/openid-configuration",
      clientId: "oidc-id",
      clientSecret: "oidc-secret",
      scopes: ["openid", "profile", "email"],
      pkce: true,
    });
  });

  it("accepts a full discovery URL and omits the plugin without complete OIDC config", () => {
    const base = {
      database: {} as never,
      mailer: new DisabledMailer(),
      baseUrl: BASE_URL,
      secret: SECRET,
      smtpEnabled: false,
    };
    const discoveryUrl =
      "https://idp.example.test/.well-known/openid-configuration";
    const options = buildBetterAuthOptions({
      ...base,
      oidc: {
        issuerUrl: discoveryUrl,
        clientId: "oidc-id",
        clientSecret: "oidc-secret",
      },
    });
    const plugin = options.plugins?.[0] as unknown as {
      options: { config: Array<Record<string, unknown>> };
    };
    expect(plugin.options.config[0]?.discoveryUrl).toBe(discoveryUrl);

    expect(buildBetterAuthOptions(base).plugins).toBeUndefined();
    expect(
      buildBetterAuthOptions({
        ...base,
        oidc: {
          issuerUrl: "https://idp.example.test",
          clientId: "oidc-id",
          clientSecret: "",
        },
      }).plugins,
    ).toBeUndefined();
  });

  it("passes through discovery URLs with query strings or trailing slashes", () => {
    for (const issuerUrl of [
      "https://idp.example.test/tenant/.well-known/openid-configuration?appid=xyz",
      "https://idp.example.test/.well-known/openid-configuration/",
    ]) {
      const options = buildBetterAuthOptions({
        database: {} as never,
        mailer: new DisabledMailer(),
        baseUrl: BASE_URL,
        secret: SECRET,
        smtpEnabled: false,
        oidc: { issuerUrl, clientId: "oidc-id", clientSecret: "oidc-secret" },
      });
      const plugin = options.plugins?.[0] as unknown as {
        options: { config: Array<Record<string, unknown>> };
      };
      expect(plugin.options.config[0]?.discoveryUrl).toBe(issuerUrl);
    }
  });

  it("reports OIDC capability with the configured or default provider name", () => {
    const oidc = {
      issuerUrl: "https://idp.example.test",
      clientId: "oidc-id",
      clientSecret: "oidc-secret",
    };
    expect(
      authCapabilities({
        smtpEnabled: false,
        oidc: { ...oidc, providerName: "Keycloak" },
      }),
    ).toEqual({
      emailPassword: true,
      google: false,
      github: false,
      oidc: true,
      oidcProviderName: "Keycloak",
      smtp: false,
    });
    expect(authCapabilities({ smtpEnabled: false, oidc })).toMatchObject({
      oidc: true,
      oidcProviderName: "SSO",
    });
    expect(
      authCapabilities({
        smtpEnabled: false,
        oidc: { ...oidc, clientSecret: "" },
      }),
    ).toMatchObject({ oidc: false, oidcProviderName: "SSO" });
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

  it("signs unverified users in immediately while still issuing a verification token", async () => {
    const memory = createMemoryAdapter();
    const auth = createOpenExcalidrawAuth({
      database: {} as never,
      databaseAdapter: memory.factory,
      mailer: new DisabledMailer(),
      baseUrl: BASE_URL,
      secret: SECRET,
      smtpEnabled: true,
      secureCookies: false,
    });
    const app = express();
    app.use(express.json());
    app.use(
      createAuthRouter({
        auth,
        identity: createIdentityService(auth),
        capabilities: authCapabilities({ smtpEnabled: true }),
      }),
    );

    const signup = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", BASE_URL)
      .send({
        name: "Unverified User",
        email: "unverified@example.test",
        password: "correct-horse-battery-staple",
      });
    expect(signup.status).toBe(200);
    expect(signup.body.token).not.toBeNull();

    const me = await request(app)
      .get("/api/v1/me")
      .set("cookie", sessionCookie(signup.headers["set-cookie"]))
      .set("origin", BASE_URL);
    expect(me.body.user).toMatchObject({
      email: "unverified@example.test",
      emailVerified: false,
    });
  });

  it("guards the set-password proxy with authentication and validation", async () => {
    const memory = createMemoryAdapter();
    const auth = createOpenExcalidrawAuth({
      database: {} as never,
      databaseAdapter: memory.factory,
      mailer: new DisabledMailer(),
      baseUrl: BASE_URL,
      secret: SECRET,
      smtpEnabled: false,
      // Plain cookies keep the round-trip simple over supertest's http.
      secureCookies: false,
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

    await request(app)
      .post("/api/v1/me/password")
      .send({ newPassword: "long-enough-password" })
      .expect(401);

    const signup = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", BASE_URL)
      .send({
        name: "New User",
        email: "proxy@example.test",
        password: "correct-horse-battery-staple",
      });
    expect(signup.status).toBe(200);
    const cookie = sessionCookie(signup.headers["set-cookie"]);

    const invalid = await request(app)
      .post("/api/v1/me/password")
      .set("cookie", cookie)
      .set("origin", BASE_URL)
      .send({ newPassword: "short" })
      .expect(400);
    expect(invalid.body.code).toBe("INVALID_REQUEST");

    // Credential accounts already have a password, so better-auth rejects
    // the server-only setPassword call; the proxy maps it to problem+json.
    const alreadySet = await request(app)
      .post("/api/v1/me/password")
      .set("cookie", cookie)
      .set("origin", BASE_URL)
      .send({ newPassword: "another-long-password" });
    expect(alreadySet.status).toBeGreaterThanOrEqual(400);
    expect(alreadySet.body.code).toBe("SET_PASSWORD_FAILED");
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

    const oidcSignIn = await request(app)
      .post("/api/auth/sign-in/oauth2")
      .set("origin", BASE_URL)
      .send({ providerId: "oidc", callbackURL: "/dashboard" });
    expect(oidcSignIn.status).toBe(404);
  });

  it("starts OIDC sign-in through the discovery document without network access", async () => {
    const memory = createMemoryAdapter();
    const auth = createOpenExcalidrawAuth({
      database: {} as never,
      databaseAdapter: memory.factory,
      mailer: new DisabledMailer(),
      baseUrl: BASE_URL,
      secret: SECRET,
      smtpEnabled: false,
      secureCookies: true,
      oidc: {
        issuerUrl: "https://idp.example.test",
        clientId: "oidc-id",
        clientSecret: "oidc-secret",
      },
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
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              issuer: "https://idp.example.test",
              authorization_endpoint: "https://idp.example.test/authorize",
              token_endpoint: "https://idp.example.test/token",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );

    try {
      const signIn = await request(app)
        .post("/api/auth/sign-in/oauth2")
        .set("origin", BASE_URL)
        .send({ providerId: "oidc", callbackURL: "/dashboard" });
      expect(signIn.status).toBe(200);
      const authorizeUrl = new URL(signIn.body.url as string);
      expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
        "https://idp.example.test/authorize",
      );
      expect(authorizeUrl.searchParams.get("client_id")).toBe("oidc-id");
      expect(authorizeUrl.searchParams.get("code_challenge")).toBeTruthy();
      expect(authorizeUrl.searchParams.get("redirect_uri")).toContain(
        "/api/auth/oauth2/callback/oidc",
      );

      const unknown = await request(app)
        .post("/api/auth/sign-in/oauth2")
        .set("origin", BASE_URL)
        .send({ providerId: "unknown", callbackURL: "/dashboard" });
      expect(unknown.status).toBe(400);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("gates OIDC account linking on session and email verification", async () => {
    const memory = createMemoryAdapter();
    const auth = createOpenExcalidrawAuth({
      database: {} as never,
      databaseAdapter: memory.factory,
      mailer: new DisabledMailer(),
      baseUrl: BASE_URL,
      secret: SECRET,
      smtpEnabled: false,
      secureCookies: false,
      oidc: {
        issuerUrl: "https://idp.example.test",
        clientId: "oidc-id",
        clientSecret: "oidc-secret",
      },
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

    const anonymous = await request(app)
      .post("/api/auth/oauth2/link")
      .set("origin", BASE_URL)
      .send({ providerId: "oidc", callbackURL: "/dashboard" });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe("AUTHENTICATION_REQUIRED");

    const signup = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", BASE_URL)
      .send({
        name: "Linking User",
        email: "linker@example.test",
        password: "correct-horse-battery-staple",
      });
    expect(signup.status).toBe(200);
    const cookie = sessionCookie(signup.headers["set-cookie"]);

    const unverified = await request(app)
      .post("/api/auth/oauth2/link")
      .set("cookie", cookie)
      .set("origin", BASE_URL)
      .send({ providerId: "oidc", callbackURL: "/dashboard" });
    expect(unverified.status).toBe(403);
    expect(unverified.body.code).toBe("EMAIL_VERIFICATION_REQUIRED");

    memory.rows.user!.find(
      (user) => user.email === "linker@example.test",
    )!.emailVerified = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              issuer: "https://idp.example.test",
              authorization_endpoint: "https://idp.example.test/authorize",
              token_endpoint: "https://idp.example.test/token",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );

    try {
      const verified = await request(app)
        .post("/api/auth/oauth2/link")
        .set("cookie", cookie)
        .set("origin", BASE_URL)
        .send({ providerId: "oidc", callbackURL: "/dashboard" });
      expect(verified.status).toBe(200);
      const authorizeUrl = new URL(verified.body.url as string);
      expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
        "https://idp.example.test/authorize",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function sessionCookie(header: string | string[] | undefined): string {
  const lines =
    header === undefined ? [] : Array.isArray(header) ? header : [header];
  return lines.map((line) => line.split(";")[0]).join("; ");
}

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
        if (input.model === "session" && input.join?.user) {
          return Promise.resolve({
            ...row,
            user: rows.user!.find((user) => user.id === row.userId) ?? null,
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
