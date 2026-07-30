import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createDatabase, runMigrations } from "@open-excalidraw/database";
import { DisabledMailer } from "@open-excalidraw/mail";
import request from "supertest";

import { createApp } from "../src/app.js";
import { enforceTokenScope } from "../src/http/token-scope.js";
import {
  authCapabilities,
  createAuthRouter,
  createBearerResolver,
  createIdentityService,
  createOpenExcalidrawAuth,
  hashAuthToken,
} from "../src/modules/auth/index.js";
import type { AssetService } from "../src/modules/assets/service.js";
import type { ContentService } from "../src/modules/content/service.js";
import type { DrawingService } from "../src/modules/drawings/service.js";
import type { ExportService } from "../src/modules/export/service.js";
import { createMcpRouter } from "../src/modules/mcp/index.js";
import {
  createOauthClientLookup,
  createOauthRouter,
  PostgresOauthTokenResolver,
} from "../src/modules/oauth/index.js";
import type { SharingService } from "../src/modules/sharing/service.js";
import {
  createTokenRouter,
  PostgresTokenRepository,
  TokenService,
} from "../src/modules/tokens/index.js";

const databaseUrl = process.env.DATABASE_TEST_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const BASE_URL = "https://draw.example.test";
const SECRET = "test-secret-that-is-at-least-thirty-two-characters-long";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

const base64url = (value: Buffer) => value.toString("base64url");

/** RFC 7636 S256: challenge = BASE64URL(SHA256(ASCII(verifier))). */
function pkce() {
  const verifier = base64url(randomBytes(32));
  return {
    verifier,
    challenge: base64url(createHash("sha256").update(verifier).digest()),
  };
}

describeDatabase("OAuth connector flow", () => {
  const database = createDatabase(databaseUrl ?? "postgresql://unused");
  const auth = createOpenExcalidrawAuth({
    database: database.db,
    mailer: new DisabledMailer(),
    baseUrl: BASE_URL,
    secret: SECRET,
    smtpEnabled: false,
    secureCookies: false,
  });
  const tokenService = new TokenService(
    new PostgresTokenRepository(database.pool),
  );
  const bearerTokens = createBearerResolver({
    personalAccessTokens: {
      resolve: (secret) => tokenService.resolveIdentity(secret),
    },
    oauthAccessTokens: new PostgresOauthTokenResolver(database.pool),
  });
  const identity = createIdentityService(auth, bearerTokens);
  const drawings = {
    list: vi.fn().mockResolvedValue({ owned: [], shared: [] }),
  };

  const app = createApp({
    allowedOrigins: [BASE_URL],
    routers: [
      enforceTokenScope(bearerTokens),
      createOauthRouter({
        identity,
        publicBaseUrl: BASE_URL,
        findClient: createOauthClientLookup(database.pool),
      }),
      createAuthRouter({
        auth,
        identity,
        capabilities: authCapabilities({ smtpEnabled: false }),
      }),
      createTokenRouter({ service: tokenService, identity }),
      createMcpRouter({
        identity,
        publicBaseUrl: BASE_URL,
        drawings: drawings as unknown as DrawingService,
        content: {} as ContentService,
        sharing: {} as SharingService,
        export: {} as ExportService,
        assets: {} as AssetService,
      }),
    ],
  });

  const createdUsers: string[] = [];
  let sessionCookie = "";
  let userId = "";

  const createdClients: string[] = [];

  /** Registers a public (PKCE-only) client, which is what a connector is. */
  async function registerClient(): Promise<string> {
    const response = await request(app)
      .post("/api/auth/mcp/register")
      .send({
        client_name: "Claude",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    expect(response.status).toBe(201);
    expect(response.body.client_secret).toBeUndefined();
    createdClients.push(response.body.client_id as string);
    return response.body.client_id as string;
  }

  /** Drives authorize -> consent -> code exactly as the browser would. */
  async function authorizeAndConsent(input: {
    clientId: string;
    challenge: string;
    state: string;
    scope?: string;
  }): Promise<URL> {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: input.clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: input.challenge,
      code_challenge_method: "S256",
      state: input.state,
      scope: input.scope ?? "openid offline_access write",
    });
    const normalized = await request(app)
      .get(`/api/auth/mcp/authorize?${query.toString()}`)
      .set("cookie", sessionCookie);
    expect(normalized.status).toBe(302);

    const authorized = await request(app)
      .get(normalized.headers.location as string)
      .set("cookie", sessionCookie);
    expect(authorized.status).toBe(302);
    const consentPage = new URL(
      authorized.headers.location as string,
      BASE_URL,
    );
    expect(consentPage.pathname).toBe("/oauth/consent");

    const decided = await request(app)
      .post("/api/auth/oauth2/consent")
      .set("cookie", sessionCookie)
      .set("origin", BASE_URL)
      .send({
        accept: true,
        consent_code: consentPage.searchParams.get("consent_code"),
      });
    expect(decided.status).toBe(200);
    return new URL(decided.body.redirectURI as string);
  }

  const exchange = (body: Record<string, string>) =>
    request(app).post("/api/auth/mcp/token").type("form").send(body);

  async function grant(): Promise<{
    accessToken: string;
    refreshToken: string;
    clientId: string;
  }> {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const callback = await authorizeAndConsent({
      clientId,
      challenge,
      state: randomUUID(),
    });
    const token = await exchange({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(token.status).toBe(200);
    return {
      accessToken: token.body.access_token as string,
      refreshToken: token.body.refresh_token as string,
      clientId,
    };
  }

  const mcp = (accessToken: string, method: string, params?: unknown) =>
    request(app)
      .post("/api/mcp")
      .set("accept", "application/json, text/event-stream")
      .set("content-type", "application/json")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });

  beforeAll(async () => {
    await runMigrations({ pool: database.pool });
    const email = `${randomUUID()}@example.test`;
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", BASE_URL)
      .send({ name: "Connector User", email, password: "correct-horse-1234" });
    expect(signUp.status).toBe(200);
    sessionCookie = (signUp.headers["set-cookie"] as unknown as string[])
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    const stored = await database.pool.query<{ id: string }>(
      `SELECT id FROM "user" WHERE email = $1`,
      [email],
    );
    userId = stored.rows[0]!.id;
    createdUsers.push(userId);
  });

  afterAll(async () => {
    await database.pool.query(`DELETE FROM "user" WHERE id = ANY($1::uuid[])`, [
      createdUsers,
    ]);
    await database.pool.query(
      `DELETE FROM oauth_application WHERE client_id = ANY($1::text[])`,
      [createdClients],
    );
    await database.close();
  });

  it("completes an authorization code + PKCE round trip", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const state = randomUUID();

    const callback = await authorizeAndConsent({ clientId, challenge, state });

    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe(state);
    const code = callback.searchParams.get("code") ?? "";
    expect(code).not.toBe("");

    const token = await exchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    });

    expect(token.status).toBe(200);
    expect(token.body).toMatchObject({
      token_type: "Bearer",
      expires_in: 15 * 60,
      scope: "openid offline_access write",
    });
    expect(token.body.refresh_token).toBeTruthy();
    expect(token.headers["cache-control"]).toBe("no-store");

    // Stored like a personal access token: only the digest reaches the table.
    const stored = await database.pool.query<{
      access_token: string;
      refresh_token: string;
      scopes: string;
    }>(
      `SELECT access_token, refresh_token, scopes FROM oauth_access_token
       WHERE client_id = $1`,
      [clientId],
    );
    expect(stored.rows[0]?.access_token).toBe(
      hashAuthToken(token.body.access_token as string),
    );
    expect(stored.rows[0]?.refresh_token).toBe(
      hashAuthToken(token.body.refresh_token as string),
    );
    expect(stored.rows[0]?.access_token).not.toContain(
      token.body.access_token as string,
    );

    // The digest must not be a credential in its own right: a database read
    // would otherwise be equivalent to stealing every connector's token.
    const passTheHash = await request(app)
      .post("/api/mcp")
      .set("authorization", `Bearer ${stored.rows[0]?.access_token ?? ""}`)
      .set("content-type", "application/json")
      .set("accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(passTheHash.status).toBe(401);

    // And nothing hands the refresh digest out to an access-token holder.
    const grant = await request(app)
      .get("/api/auth/mcp/get-session")
      .set("authorization", `Bearer ${token.body.access_token as string}`);
    expect(grant.status).toBe(404);
  });

  it("refuses a code without proof of possession", async () => {
    const clientId = await registerClient();
    // Each attempt consumes the code, so each needs its own authorization.
    const withoutVerifier = await authorizeAndConsent({
      clientId,
      challenge: pkce().challenge,
      state: randomUUID(),
    });
    expect(
      (
        await exchange({
          grant_type: "authorization_code",
          code: withoutVerifier.searchParams.get("code") ?? "",
          redirect_uri: REDIRECT_URI,
          client_id: clientId,
        })
      ).status,
    ).toBe(400);

    const wrongVerifier = await authorizeAndConsent({
      clientId,
      challenge: pkce().challenge,
      state: randomUUID(),
    });
    expect(
      (
        await exchange({
          grant_type: "authorization_code",
          code: wrongVerifier.searchParams.get("code") ?? "",
          redirect_uri: REDIRECT_URI,
          client_id: clientId,
          code_verifier: base64url(randomBytes(32)),
        })
      ).status,
    ).toBe(401);
  });

  it("refuses a code replay and an unregistered redirect URI", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const callback = await authorizeAndConsent({
      clientId,
      challenge,
      state: randomUUID(),
    });
    const code = callback.searchParams.get("code") ?? "";
    const body = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    };

    expect((await exchange(body)).status).toBe(200);
    // The code is consumed by the first exchange.
    expect((await exchange(body)).status).toBe(401);

    const wrongRedirect = await request(app)
      .get(
        `/api/auth/mcp/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: "https://evil.example/cb",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "s",
          prompt: "consent",
          scope: "openid write",
        }).toString()}`,
      )
      .set("cookie", sessionCookie);
    expect(wrongRedirect.status).toBe(400);
  });

  it("resolves an access token to its user with the granted scope", async () => {
    const { accessToken } = await grant();

    const tools = await mcp(accessToken, "tools/list");
    expect(tools.status).toBe(200);
    const names = (tools.body.result.tools as { name: string }[]).map(
      (tool) => tool.name,
    );
    expect(names).toContain("create_drawing");

    drawings.list.mockClear();
    const listed = await mcp(accessToken, "tools/call", {
      name: "list_drawings",
      arguments: {},
    });
    expect(listed.status).toBe(200);
    expect(drawings.list).toHaveBeenCalledWith(userId);
  });

  it("issues a read-only grant when the client asks for one", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const callback = await authorizeAndConsent({
      clientId,
      challenge,
      state: randomUUID(),
      scope: "openid read",
    });
    const token = await exchange({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(token.body.scope).toBe("openid read");

    const tools = await mcp(token.body.access_token as string, "tools/list");
    const names = (tools.body.result.tools as { name: string }[]).map(
      (tool) => tool.name,
    );
    expect(names).toContain("list_drawings");
    expect(names).not.toContain("create_drawing");
    expect(names).not.toContain("edit_scene");
  });

  it("rotates refresh tokens and retires the one it consumed", async () => {
    const { refreshToken, clientId } = await grant();

    const refreshed = await exchange({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(refreshToken);

    // The consumed token is gone, so a stolen copy dies on first legitimate use.
    expect(
      (
        await exchange({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
        })
      ).status,
    ).toBe(401);
    const next = await mcp(refreshed.body.access_token as string, "tools/list");
    expect(next.status).toBe(200);
  });

  it("answers 401 with a challenge for an expired or revoked token", async () => {
    const { accessToken } = await grant();

    await database.pool.query(
      `UPDATE oauth_access_token
       SET access_token_expires_at = now() - interval '1 hour'
       WHERE access_token = $1`,
      [hashAuthToken(accessToken)],
    );
    const expired = await mcp(accessToken, "tools/list");
    expect(expired.status).toBe(401);
    expect(expired.headers["www-authenticate"]).toContain(
      `resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/api/mcp"`,
    );

    await database.pool.query(
      `DELETE FROM oauth_access_token WHERE access_token = $1`,
      [hashAuthToken(accessToken)],
    );
    expect((await mcp(accessToken, "tools/list")).status).toBe(401);
  });

  it("keeps a connector out of admin routes and token management", async () => {
    const { accessToken } = await grant();
    const bearer = (test: request.Test) =>
      test.set("authorization", `Bearer ${accessToken}`);

    const admin = await bearer(request(app).get("/api/v1/admin/overview"));
    expect(admin.status).toBe(403);
    expect(admin.body).toMatchObject({ code: "INSUFFICIENT_SCOPE" });

    const tokens = await bearer(request(app).get("/api/v1/tokens"));
    expect(tokens.status).toBe(403);
    expect(tokens.body).toMatchObject({
      code: "TOKEN_MANAGEMENT_REQUIRES_SESSION",
    });
    const minted = await bearer(
      request(app)
        .post("/api/v1/tokens")
        .set("origin", BASE_URL)
        .send({ name: "escalation", expiresInDays: null, scope: "full" }),
    );
    expect(minted.status).toBe(403);
  });

  it("refuses a registration the guard forbids", async () => {
    const response = await request(app)
      .post("/api/auth/mcp/register")
      .send({ client_name: "Evil", redirect_uris: ["http://evil.example/cb"] });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "invalid_client_metadata" });
  });

  it("publishes discovery documents matching the plugin's own endpoints", async () => {
    const resource = await request(app).get(
      "/.well-known/oauth-protected-resource/api/mcp",
    );
    expect(resource.status).toBe(200);
    expect(resource.body.resource).toBe(`${BASE_URL}/api/mcp`);

    const server = await request(app).get(
      "/.well-known/oauth-authorization-server",
    );
    expect(server.status).toBe(200);
    expect(server.body.issuer).toBe(resource.body.authorization_servers[0]);

    // Drift canary: the published endpoints are written by hand, so compare
    // them with the document Better Auth's plugin generates for itself.
    const plugin = await request(app).get(
      "/api/auth/.well-known/oauth-authorization-server",
    );
    expect(plugin.status).toBe(200);
    expect({
      authorization_endpoint: server.body.authorization_endpoint,
      token_endpoint: server.body.token_endpoint,
      registration_endpoint: server.body.registration_endpoint,
    }).toEqual({
      authorization_endpoint: plugin.body.authorization_endpoint,
      token_endpoint: plugin.body.token_endpoint,
      registration_endpoint: plugin.body.registration_endpoint,
    });
  });
});
