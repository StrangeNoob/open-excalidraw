import { Router } from "express";
import request from "supertest";

import { createApp } from "../../app.js";
import type { IdentityService, RequestIdentity } from "../auth/identity.js";
import { createOauthRouter } from "./router.js";

const BASE_URL = "https://draw.example.test";
const SESSION = "session-cookie";
const CONNECTOR_TOKEN = "Bearer connector-access-token";

// Reached only when the oauth router calls next(), which is the assertion for
// the authorize guard: a request that gets here would have hit Better Auth.
const downstream = Router().all(/.*/, (_request, response) => {
  response.status(200).json({ passedThrough: true });
});

const identity: IdentityService = {
  resolve: (headers) => {
    const raw = headers as Record<string, string>;
    if (raw.cookie === SESSION) {
      return Promise.resolve({
        userId: "user-1",
        authKind: "session",
      } as RequestIdentity);
    }
    if (raw.authorization === CONNECTOR_TOKEN) {
      return Promise.resolve({
        userId: "user-1",
        authKind: "token",
        tokenScope: "write",
      } as RequestIdentity);
    }
    return Promise.resolve(null);
  },
};

const app = createApp({
  allowedOrigins: [BASE_URL],
  routers: [
    createOauthRouter({
      identity,
      publicBaseUrl: BASE_URL,
      findClient: (clientId) =>
        Promise.resolve(
          clientId === "known"
            ? {
                name: "Claude",
                icon: null,
                redirectOrigins: ["claude.ai"],
              }
            : null,
        ),
    }),
    downstream,
  ],
});

const register = (body: unknown) =>
  request(app)
    .post("/api/auth/mcp/register")
    .set("content-type", "application/json")
    .send(body as object);

describe("oauth discovery routes", () => {
  it("serves the protected resource document at both well-known paths", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource/api/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        resource: `${BASE_URL}/api/mcp`,
        authorization_servers: [BASE_URL],
      });
      // A client may fetch discovery from another origin before it has any
      // credential, so neither CORS nor CORP may stand in the way.
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["cross-origin-resource-policy"]).toBe(
        "cross-origin",
      );
    }
  });

  it("serves authorization server metadata under both suffixes", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ]) {
      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(response.body.issuer).toBe(BASE_URL);
      expect(response.body.token_endpoint).toBe(
        `${BASE_URL}/api/auth/mcp/token`,
      );
    }
  });
});

describe("dynamic client registration guard", () => {
  it("passes a well-formed registration through to Better Auth", async () => {
    const response = await register({
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ passedThrough: true });
  });

  it("does not hold public OAuth endpoints to the cross-site rule", async () => {
    // A connector's backend is not a browser; if it sends an Origin at all it
    // is its own, and these two endpoints are public by specification.
    const registered = await register({
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    }).set("origin", "https://claude.ai");
    expect(registered.status).toBe(200);

    const token = await request(app)
      .post("/api/auth/mcp/token")
      .set("origin", "https://claude.ai")
      .type("form")
      .send({ grant_type: "refresh_token" });
    expect(token.status).toBe(200);

    // The consent endpoint runs on the user's session and stays protected.
    const consent = await request(app)
      .post("/api/auth/oauth2/consent")
      .set("origin", "https://claude.ai")
      .send({ accept: true });
    expect(consent.status).toBe(403);
    expect(consent.body).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
  });

  it("refuses a registration Better Auth would have accepted", async () => {
    const response = await register({
      client_name: "Evil",
      redirect_uris: ["http://evil.example/cb"],
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "invalid_client_metadata" });
  });
});

describe("authorize entry point", () => {
  const authorize = (search: string, headers: Record<string, string> = {}) => {
    const call = request(app).get(`/api/auth/mcp/authorize${search}`);
    for (const [name, value] of Object.entries(headers)) {
      call.set(name, value);
    }
    return call;
  };

  it("redirects until the request carries consent and one product scope", async () => {
    const response = await authorize("?client_id=abc&response_type=code", {
      cookie: SESSION,
    });

    expect(response.status).toBe(302);
    const location = new URL(response.headers.location as string, BASE_URL);
    expect(location.pathname).toBe("/api/auth/mcp/authorize");
    expect(location.searchParams.get("prompt")).toBe("consent");
    expect(location.searchParams.get("scope")).toBe("openid write");
    expect(location.searchParams.get("client_id")).toBe("abc");
  });

  it("hands a normalized, signed-in request to Better Auth", async () => {
    const response = await authorize(
      "?client_id=abc&response_type=code&prompt=consent&scope=openid+write",
      { cookie: SESSION },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ passedThrough: true });
  });

  it("sends a signed-out caller through the app's login flow", async () => {
    const response = await authorize(
      "?client_id=abc&response_type=code&prompt=consent&scope=openid+write",
    );

    // Never into Better Auth: its own login redirect would leave a cookie
    // whose hook rewrites the SPA's sign-in response into a redirect.
    expect(response.status).toBe(302);
    const location = new URL(response.headers.location as string, BASE_URL);
    expect(location.pathname).toBe("/login");
    const returnTo = new URL(
      location.searchParams.get("returnTo") ?? "",
      BASE_URL,
    );
    expect(returnTo.pathname).toBe("/oauth/authorize");
    expect(returnTo.searchParams.get("client_id")).toBe("abc");
  });
});

describe("consent screen client lookup", () => {
  it("names a registered client for a signed-in browser", async () => {
    const response = await request(app)
      .get("/api/v1/oauth/clients/known")
      .set("cookie", SESSION);

    expect(response.status).toBe(200);
    // The redirect host is the part the server verified, so the consent screen
    // can show where a grant actually goes rather than only what it calls
    // itself.
    expect(response.body).toEqual({
      name: "Claude",
      icon: null,
      redirectOrigins: ["claude.ai"],
    });
  });

  it("is session-only and reports unknown clients", async () => {
    expect((await request(app).get("/api/v1/oauth/clients/known")).status).toBe(
      401,
    );
    // A connector's own token must not be able to enumerate clients.
    expect(
      (
        await request(app)
          .get("/api/v1/oauth/clients/known")
          .set("authorization", CONNECTOR_TOKEN)
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .get("/api/v1/oauth/clients/unknown")
          .set("cookie", SESSION)
      ).status,
    ).toBe(404);
  });
});
