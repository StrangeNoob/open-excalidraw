import { createDatabase, runMigrations } from "@open-excalidraw/database";
import { DisabledMailer } from "@open-excalidraw/mail";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
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
      github: {
        clientId: "github-id",
        clientSecret: "github-secret",
        disableSignUp: false,
      },
    });
    expect(options.account).toMatchObject({
      encryptOAuthTokens: true,
      accountLinking: {
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
      },
    });
  });

  it("fails session creation closed when the auth context adapter is missing", async () => {
    const options = buildBetterAuthOptions({
      database: {} as never,
      mailer: new DisabledMailer(),
      baseUrl: BASE_URL,
      secret: SECRET,
      smtpEnabled: false,
    });
    const before = options.databaseHooks?.session?.create?.before;
    expect(before).toBeDefined();
    // A missing hook context must refuse the session, not skip the guard.
    await expect(
      before!({ userId: randomUUID() } as never, undefined as never),
    ).rejects.toThrow();
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
      signupsDisabled: false,
      smtp: false,
    });
  });

  it("threads DISABLE_SIGNUPS into every provider and the capabilities payload", () => {
    const options = buildBetterAuthOptions({
      database: {} as never,
      mailer: new DisabledMailer(),
      baseUrl: BASE_URL,
      secret: SECRET,
      smtpEnabled: false,
      disableSignups: true,
      github: { clientId: "github-id", clientSecret: "github-secret" },
      oidc: {
        issuerUrl: "https://idp.example.test",
        clientId: "oidc-id",
        clientSecret: "oidc-secret",
      },
    });

    expect(options.emailAndPassword?.disableSignUp).toBe(true);
    expect(options.socialProviders?.github).toMatchObject({
      disableSignUp: true,
    });
    const plugin = findGenericOAuth(options);
    expect(plugin?.options.config[0]?.disableSignUp).toBe(true);

    expect(
      authCapabilities({ smtpEnabled: false, disableSignups: true }),
    ).toMatchObject({ signupsDisabled: true });
  });

  it("leaves sign-up enabled by default", () => {
    const options = buildBetterAuthOptions({
      database: {} as never,
      mailer: new DisabledMailer(),
      baseUrl: BASE_URL,
      secret: SECRET,
      smtpEnabled: false,
    });
    expect(options.emailAndPassword?.disableSignUp).toBeFalsy();
    expect(authCapabilities({ smtpEnabled: false }).signupsDisabled).toBe(
      false,
    );
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

    expect(options.plugins?.map((plugin) => plugin.id)).toEqual([
      "two-factor",
      "generic-oauth",
    ]);
    const plugin = findGenericOAuth(options);
    expect(plugin?.options.config[0]).toMatchObject({
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
    const plugin = findGenericOAuth(options);
    expect(plugin?.options.config[0]?.discoveryUrl).toBe(discoveryUrl);

    // twoFactor is always registered; generic-oauth only with complete OIDC.
    expect(buildBetterAuthOptions(base).plugins?.map((p) => p.id)).toEqual([
      "two-factor",
    ]);
    expect(
      buildBetterAuthOptions({
        ...base,
        oidc: {
          issuerUrl: "https://idp.example.test",
          clientId: "oidc-id",
          clientSecret: "",
        },
      }).plugins?.map((p) => p.id),
    ).toEqual(["two-factor"]);
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
      const plugin = findGenericOAuth(options);
      expect(plugin?.options.config[0]?.discoveryUrl).toBe(issuerUrl);
    }
  });

  it("requires HTTPS issuer URLs except for loopback hosts", () => {
    const base = {
      database: {} as never,
      mailer: new DisabledMailer(),
      baseUrl: BASE_URL,
      secret: SECRET,
      smtpEnabled: false,
    };
    const oidc = { clientId: "oidc-id", clientSecret: "oidc-secret" };

    expect(() =>
      buildBetterAuthOptions({
        ...base,
        oidc: { ...oidc, issuerUrl: "http://idp.example.test/realms/main" },
      }),
    ).toThrow("OIDC_ISSUER_URL must use HTTPS");

    const options = buildBetterAuthOptions({
      ...base,
      oidc: { ...oidc, issuerUrl: "http://localhost:8080/realms/main" },
    });
    const plugin = findGenericOAuth(options);
    expect(plugin?.options.config[0]?.discoveryUrl).toBe(
      "http://localhost:8080/realms/main/.well-known/openid-configuration",
    );
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
      signupsDisabled: false,
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
        identity: createIdentityService(auth, {
          resolve: () => Promise.resolve(null),
        }),
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
        identity: createIdentityService(auth, {
          resolve: () => Promise.resolve(null),
        }),
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

  it("rejects email sign-up and creates no session when signups are disabled", async () => {
    const memory = createMemoryAdapter();
    const auth = createOpenExcalidrawAuth({
      database: {} as never,
      databaseAdapter: memory.factory,
      mailer: new DisabledMailer(),
      baseUrl: BASE_URL,
      secret: SECRET,
      smtpEnabled: false,
      secureCookies: false,
      disableSignups: true,
    });
    const app = express();
    app.use(express.json());
    app.use(
      createAuthRouter({
        auth,
        identity: createIdentityService(auth, {
          resolve: () => Promise.resolve(null),
        }),
        capabilities: authCapabilities({
          smtpEnabled: false,
          disableSignups: true,
        }),
      }),
    );

    const signup = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", BASE_URL)
      .send({
        name: "Blocked User",
        email: "blocked@example.test",
        password: "correct-horse-battery-staple",
      });
    expect(signup.status).toBeGreaterThanOrEqual(400);
    expect(signup.status).toBeLessThan(500);
    expect(memory.rows.user).toHaveLength(0);
    expect(memory.rows.session).toHaveLength(0);
  });

  it("reports isAdmin on /v1/me only for a verified email on the ADMIN_EMAILS allowlist", async () => {
    const memory = createMemoryAdapter();
    const auth = createOpenExcalidrawAuth({
      database: {} as never,
      databaseAdapter: memory.factory,
      mailer: new DisabledMailer(),
      baseUrl: BASE_URL,
      secret: SECRET,
      smtpEnabled: false,
      secureCookies: false,
    });
    const identity = createIdentityService(auth, {
      resolve: () => Promise.resolve(null),
    });
    const email = "admin-me@example.test";
    const adminApp = express();
    adminApp.use(express.json());
    adminApp.use(
      createAuthRouter({
        auth,
        identity,
        capabilities: authCapabilities({ smtpEnabled: false }),
        adminEmails: new Set([email]),
      }),
    );
    const plainApp = express();
    plainApp.use(express.json());
    plainApp.use(
      createAuthRouter({
        auth,
        identity,
        capabilities: authCapabilities({ smtpEnabled: false }),
      }),
    );

    const signup = await request(adminApp)
      .post("/api/auth/sign-up/email")
      .set("origin", BASE_URL)
      // Distinct forwarded IP => own rate-limit bucket (the memory store is
      // process-global and keyed by IP+path), so sign-ups here don't share
      // the untrusted-IP bucket with the other tests in this file.
      .set("x-forwarded-for", "10.10.0.1")
      .send({ name: "Admin", email, password: "correct-horse-battery-staple" });
    expect(signup.status).toBe(200);
    const cookie = sessionCookie(signup.headers["set-cookie"]);

    // Email/password sign-up leaves the account unverified, so an allowlisted
    // but unverified admin email must not be treated as admin.
    const beforeVerification = await request(adminApp)
      .get("/api/v1/me")
      .set("cookie", cookie)
      .set("origin", BASE_URL);
    expect(beforeVerification.body.user).toMatchObject({
      email,
      emailVerified: false,
      isAdmin: false,
    });

    // Proving mailbox ownership (as an OAuth/OIDC or SMTP flow would) flips it.
    memory.rows.user!.find((user) => user.email === email)!.emailVerified =
      true;

    const asAdmin = await request(adminApp)
      .get("/api/v1/me")
      .set("cookie", cookie)
      .set("origin", BASE_URL);
    expect(asAdmin.body.user).toMatchObject({ email, isAdmin: true });

    const asPlain = await request(plainApp)
      .get("/api/v1/me")
      .set("cookie", cookie)
      .set("origin", BASE_URL);
    expect(asPlain.body.user.isAdmin).toBe(false);
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
        identity: createIdentityService(auth, {
          resolve: () => Promise.resolve(null),
        }),
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
        identity: createIdentityService(auth, {
          resolve: () => Promise.resolve(null),
        }),
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
        identity: createIdentityService(auth, {
          resolve: () => Promise.resolve(null),
        }),
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
        identity: createIdentityService(auth, {
          resolve: () => Promise.resolve(null),
        }),
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

describe("two-factor plugin surface", () => {
  it("registers the two-factor routes but leaves send-otp dead without sendOTP", async () => {
    const memory = createMemoryAdapter();
    const auth = createOpenExcalidrawAuth({
      database: {} as never,
      databaseAdapter: memory.factory,
      mailer: new DisabledMailer(),
      baseUrl: BASE_URL,
      secret: SECRET,
      smtpEnabled: false,
      secureCookies: false,
    });
    const app = express();
    app.use(express.json());
    app.use(
      createAuthRouter({
        auth,
        identity: createIdentityService(auth, {
          resolve: () => Promise.resolve(null),
        }),
        capabilities: authCapabilities({ smtpEnabled: false }),
      }),
    );

    // No otpOptions.sendOTP is configured, so the route exists (not 404) but
    // refuses every call: email OTP can never become a usable second factor.
    const res = await request(app)
      .post("/api/auth/two-factor/send-otp")
      .set("origin", BASE_URL)
      .set("x-forwarded-for", "10.30.0.1")
      .send({});
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/otp isn't configured/i);
  });
});

const databaseUrl = process.env.DATABASE_TEST_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("disabled account lockout", () => {
  const database = createDatabase(databaseUrl ?? "postgresql://unused");
  const emails: string[] = [];

  beforeAll(async () => {
    await runMigrations({ pool: database.pool });
  });

  afterAll(async () => {
    await database.pool.query(
      `DELETE FROM "user" WHERE email = ANY($1::text[])`,
      [emails],
    );
    await database.close();
  });

  it("blocks new sessions for a disabled user via the session hook", async () => {
    const auth = createOpenExcalidrawAuth({
      database: database.db,
      mailer: new DisabledMailer(),
      baseUrl: BASE_URL,
      secret: SECRET,
      smtpEnabled: false,
      secureCookies: false,
    });
    const app = express();
    app.use(express.json());
    app.use(
      createAuthRouter({
        auth,
        identity: createIdentityService(auth, {
          resolve: () => Promise.resolve(null),
        }),
        capabilities: authCapabilities({ smtpEnabled: false }),
      }),
    );

    const email = `disabled-${randomUUID()}@example.test`;
    emails.push(email);
    const password = "correct-horse-battery-staple";
    // Distinct forwarded IP => own rate-limit bucket (the memory store is
    // process-global and keyed by IP+path).
    const ip = "10.10.0.2";
    const signup = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", BASE_URL)
      .set("x-forwarded-for", ip)
      .send({ name: "Disabled", email, password });
    expect(signup.status).toBe(200);

    // Sign-in works while the account is active.
    const before = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", BASE_URL)
      .set("x-forwarded-for", ip)
      .send({ email, password });
    expect(before.status).toBe(200);

    await database.pool.query(
      `UPDATE "user" SET disabled_at = now() WHERE email = $1`,
      [email],
    );

    const after = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", BASE_URL)
      .set("x-forwarded-for", ip)
      .send({ email, password });
    expect(after.status).toBe(403);
    expect(after.body.code).toBe("ACCOUNT_DISABLED");
    expect(after.body.user).toBeUndefined();
  });
});

describeDatabase("two-factor authentication", () => {
  const database = createDatabase(databaseUrl ?? "postgresql://unused");
  const emails: string[] = [];
  const password = "correct-horse-battery-staple";
  let ipCounter = 0;

  // Every request gets a fresh forwarded IP so the plugin's 3-req/10s
  // /two-factor/* limit (and the sign-in limit) never bites: rate limiting is
  // keyed by IP + path, and the challenge state lives in a signed cookie plus
  // a verification row, not the request IP.
  const nextIp = () =>
    `10.40.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  beforeAll(async () => {
    await runMigrations({ pool: database.pool });
  });

  afterAll(async () => {
    await database.pool.query(
      `DELETE FROM "user" WHERE email = ANY($1::text[])`,
      [emails],
    );
    await database.close();
  });

  function createApp() {
    const auth = createOpenExcalidrawAuth({
      database: database.db,
      mailer: new DisabledMailer(),
      baseUrl: BASE_URL,
      secret: SECRET,
      smtpEnabled: false,
      secureCookies: false,
    });
    const app = express();
    app.use(express.json());
    app.use(
      createAuthRouter({
        auth,
        identity: createIdentityService(auth, {
          resolve: () => Promise.resolve(null),
        }),
        capabilities: authCapabilities({ smtpEnabled: false }),
      }),
    );
    return app;
  }

  // Mint a code the plugin will accept: the enable response only hands back the
  // otpauth URI, so recover the raw secret from its base32 param and drive the
  // same createOTP the plugin verifies against.
  async function totpCode(totpURI: string): Promise<string> {
    const secretParam = new URL(totpURI).searchParams.get("secret");
    if (!secretParam) throw new Error("totpURI is missing its secret");
    const rawSecret = new TextDecoder().decode(base32.decode(secretParam));
    return createOTP(rawSecret, { digits: 6, period: 30 }).totp();
  }

  async function signUp(app: express.Express, email: string): Promise<string> {
    emails.push(email);
    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", BASE_URL)
      .set("x-forwarded-for", nextIp())
      .send({ name: "Two Factor", email, password });
    expect(res.status).toBe(200);
    return sessionCookie(res.headers["set-cookie"]);
  }

  // Full enrollment: sign up, enable, then verify a code to flip the flag on.
  async function enroll(
    app: express.Express,
    email: string,
  ): Promise<{ totpURI: string; backupCodes: string[] }> {
    const cookie = await signUp(app, email);
    const enable = await request(app)
      .post("/api/auth/two-factor/enable")
      .set("origin", BASE_URL)
      .set("x-forwarded-for", nextIp())
      .set("cookie", cookie)
      .send({ password });
    expect(enable.status).toBe(200);
    const totpURI = enable.body.totpURI as string;
    const backupCodes = enable.body.backupCodes as string[];
    const verify = await request(app)
      .post("/api/auth/two-factor/verify-totp")
      .set("origin", BASE_URL)
      .set("x-forwarded-for", nextIp())
      .set("cookie", cookie)
      .send({ code: await totpCode(totpURI) });
    expect(verify.status).toBe(200);
    return { totpURI, backupCodes };
  }

  function signIn(app: express.Express, email: string, cookie?: string) {
    const req = request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", BASE_URL)
      .set("x-forwarded-for", nextIp());
    if (cookie) {
      req.set("cookie", cookie);
    }
    return req.send({ email, password });
  }

  it("enrolls a user only after a verify-totp confirms the secret", async () => {
    const app = createApp();
    const email = `2fa-enroll-${randomUUID()}@example.test`;
    const cookie = await signUp(app, email);

    const before = await request(app)
      .get("/api/v1/me")
      .set("x-forwarded-for", nextIp())
      .set("cookie", cookie);
    expect(before.body.user).toMatchObject({ twoFactorEnabled: false });

    const enable = await request(app)
      .post("/api/auth/two-factor/enable")
      .set("origin", BASE_URL)
      .set("x-forwarded-for", nextIp())
      .set("cookie", cookie)
      .send({ password });
    expect(enable.status).toBe(200);
    expect(typeof enable.body.totpURI).toBe("string");
    expect(Array.isArray(enable.body.backupCodes)).toBe(true);
    expect(enable.body.backupCodes.length).toBeGreaterThan(0);

    // Enrollment is incomplete until a code is verified (no skip-on-enable).
    const midway = await request(app)
      .get("/api/v1/me")
      .set("x-forwarded-for", nextIp())
      .set("cookie", cookie);
    expect(midway.body.user).toMatchObject({ twoFactorEnabled: false });

    const verify = await request(app)
      .post("/api/auth/two-factor/verify-totp")
      .set("origin", BASE_URL)
      .set("x-forwarded-for", nextIp())
      .set("cookie", cookie)
      .send({ code: await totpCode(String(enable.body.totpURI)) });
    expect(verify.status).toBe(200);

    const after = await request(app)
      .get("/api/v1/me")
      .set("x-forwarded-for", nextIp())
      .set("cookie", sessionCookie(verify.headers["set-cookie"]));
    expect(after.body.user).toMatchObject({ twoFactorEnabled: true });
  });

  it("challenges at password sign-in and completes via verify-totp", async () => {
    const app = createApp();
    const email = `2fa-challenge-${randomUUID()}@example.test`;
    const { totpURI } = await enroll(app, email);

    const challenge = await signIn(app, email);
    expect(challenge.status).toBe(200);
    expect(challenge.body).toMatchObject({ twoFactorRedirect: true });

    const challengeCookie = sessionCookie(challenge.headers["set-cookie"]);
    // The challenge response carries no authenticated session yet.
    const pending = await request(app)
      .get("/api/v1/me")
      .set("x-forwarded-for", nextIp())
      .set("cookie", challengeCookie);
    expect(pending.body.user).toBeNull();

    const verify = await request(app)
      .post("/api/auth/two-factor/verify-totp")
      .set("origin", BASE_URL)
      .set("x-forwarded-for", nextIp())
      .set("cookie", challengeCookie)
      .send({ code: await totpCode(totpURI) });
    expect(verify.status).toBe(200);

    const me = await request(app)
      .get("/api/v1/me")
      .set("x-forwarded-for", nextIp())
      .set("cookie", sessionCookie(verify.headers["set-cookie"]));
    expect(me.body.user).toMatchObject({ email, twoFactorEnabled: true });
  });

  it("rejects wrong codes and locks the account after ten sign-in failures", async () => {
    const app = createApp();
    const email = `2fa-lockout-${randomUUID()}@example.test`;
    const { totpURI } = await enroll(app, email);

    // verify-totp caps a single challenge at five attempts, and the account
    // locks at ten cumulative failures, so drive two challenges of five.
    for (let challenge = 0; challenge < 2; challenge += 1) {
      const signedIn = await signIn(app, email);
      expect(signedIn.body).toMatchObject({ twoFactorRedirect: true });
      const challengeCookie = sessionCookie(signedIn.headers["set-cookie"]);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await request(app)
          .post("/api/auth/two-factor/verify-totp")
          .set("origin", BASE_URL)
          .set("x-forwarded-for", nextIp())
          .set("cookie", challengeCookie)
          .send({ code: "000000" });
        expect(res.status).toBe(401);
      }
    }

    const locked = await database.pool.query<{
      failed_verification_count: number;
      locked_until: Date | null;
    }>(
      `SELECT failed_verification_count, locked_until
         FROM two_factor
        WHERE user_id = (SELECT id FROM "user" WHERE email = $1)`,
      [email],
    );
    const [lockRow] = locked.rows;
    expect(lockRow?.failed_verification_count).toBe(10);
    expect(lockRow?.locked_until).not.toBeNull();
    expect(lockRow?.locked_until?.getTime() ?? 0).toBeGreaterThan(Date.now());

    // The lock is enforced even against an otherwise valid code.
    const signedIn = await signIn(app, email);
    const blocked = await request(app)
      .post("/api/auth/two-factor/verify-totp")
      .set("origin", BASE_URL)
      .set("x-forwarded-for", nextIp())
      .set("cookie", sessionCookie(signedIn.headers["set-cookie"]))
      .send({ code: await totpCode(totpURI) });
    expect(blocked.status).toBe(429);
  });

  it("signs in with a backup code once and rejects its reuse", async () => {
    const app = createApp();
    const email = `2fa-backup-${randomUUID()}@example.test`;
    const { backupCodes } = await enroll(app, email);
    const code = backupCodes[0];

    const first = await signIn(app, email);
    const accept = await request(app)
      .post("/api/auth/two-factor/verify-backup-code")
      .set("origin", BASE_URL)
      .set("x-forwarded-for", nextIp())
      .set("cookie", sessionCookie(first.headers["set-cookie"]))
      .send({ code });
    expect(accept.status).toBe(200);
    const me = await request(app)
      .get("/api/v1/me")
      .set("x-forwarded-for", nextIp())
      .set("cookie", sessionCookie(accept.headers["set-cookie"]));
    expect(me.body.user).toMatchObject({ email });

    const second = await signIn(app, email);
    const reuse = await request(app)
      .post("/api/auth/two-factor/verify-backup-code")
      .set("origin", BASE_URL)
      .set("x-forwarded-for", nextIp())
      .set("cookie", sessionCookie(second.headers["set-cookie"]))
      .send({ code });
    expect(reuse.status).toBe(401);
  });

  it("skips the challenge on later sign-ins from a trusted device", async () => {
    const app = createApp();
    const email = `2fa-trust-${randomUUID()}@example.test`;
    const { totpURI } = await enroll(app, email);

    const challenge = await signIn(app, email);
    const verify = await request(app)
      .post("/api/auth/two-factor/verify-totp")
      .set("origin", BASE_URL)
      .set("x-forwarded-for", nextIp())
      .set("cookie", sessionCookie(challenge.headers["set-cookie"]))
      .send({ code: await totpCode(totpURI), trustDevice: true });
    expect(verify.status).toBe(200);
    const trusted = sessionCookie(verify.headers["set-cookie"]);

    await request(app)
      .post("/api/auth/sign-out")
      .set("origin", BASE_URL)
      .set("x-forwarded-for", nextIp())
      .set("cookie", trusted);

    // The trust-device cookie survives sign-out and bypasses the challenge.
    const second = await signIn(app, email, trusted);
    expect(second.status).toBe(200);
    expect(second.body.twoFactorRedirect).toBeUndefined();

    const me = await request(app)
      .get("/api/v1/me")
      .set("x-forwarded-for", nextIp())
      .set("cookie", sessionCookie(second.headers["set-cookie"]));
    expect(me.body.user).toMatchObject({ email, twoFactorEnabled: true });
  });

  it("refuses a post-challenge session for an account disabled mid-flow", async () => {
    const app = createApp();
    const email = `2fa-disabled-${randomUUID()}@example.test`;
    const { totpURI } = await enroll(app, email);

    const challenge = await signIn(app, email);
    expect(challenge.body).toMatchObject({ twoFactorRedirect: true });
    const challengeCookie = sessionCookie(challenge.headers["set-cookie"]);

    await database.pool.query(
      `UPDATE "user" SET disabled_at = now() WHERE email = $1`,
      [email],
    );

    // A valid code still cannot mint a session: the session.create.before hook
    // fires on the post-challenge createSession and refuses the disabled user.
    const verify = await request(app)
      .post("/api/auth/two-factor/verify-totp")
      .set("origin", BASE_URL)
      .set("x-forwarded-for", nextIp())
      .set("cookie", challengeCookie)
      .send({ code: await totpCode(totpURI) });
    expect(verify.status).toBe(403);
    expect(verify.body.code).toBe("ACCOUNT_DISABLED");

    const me = await request(app)
      .get("/api/v1/me")
      .set("x-forwarded-for", nextIp())
      .set("cookie", sessionCookie(verify.headers["set-cookie"]));
    expect(me.body.user).toBeNull();
  });
});

function findGenericOAuth(options: {
  plugins?: ReadonlyArray<{ id: string }>;
}) {
  return options.plugins?.find((plugin) => plugin.id === "generic-oauth") as
    { options: { config: Array<Record<string, unknown>> } } | undefined;
}

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
