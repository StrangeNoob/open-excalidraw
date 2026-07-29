import type { TokenScope } from "@open-excalidraw/contracts";
import { Router } from "express";
import request from "supertest";

import { createApp } from "../app.js";
import type { RequestIdentity } from "../modules/auth/identity.js";
import { enforceTokenScope } from "./token-scope.js";

const SECRETS: Record<string, TokenScope> = {
  oepat_read: "read",
  oepat_write: "write",
  oepat_full: "full",
};

// Every route answers 200, so any non-200 came from the scope middleware.
const echo = Router().all(/.*/, (_request, response) => {
  response.status(200).json({ ok: true });
});

const app = createApp({
  routers: [
    enforceTokenScope({
      resolve: (secret) => {
        const scope = SECRETS[secret];
        return Promise.resolve(
          scope
            ? ({ authKind: "token", tokenScope: scope } as RequestIdentity)
            : null,
        );
      },
    }),
    echo,
  ],
});

const call = (
  method: "get" | "post" | "put",
  path: string,
  secret?: string,
) => {
  const test = request(app)[method](path);
  return secret ? test.set("authorization", `Bearer ${secret}`) : test;
};

describe("token scope enforcement", () => {
  it("refuses an unsafe method for a read-scoped token", async () => {
    const response = await call("put", "/api/v1/drawings/x", "oepat_read");

    expect(response.status).toBe(403);
    expect(response.type).toBe("application/problem+json");
    expect(response.body).toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      status: 403,
    });
    expect(response.body.requestId).toBe(response.headers["x-request-id"]);
  });

  it("refuses unsafe methods whatever the case of the path", async () => {
    // Express routes case-insensitively, so these all reach the same handler.
    for (const path of [
      "/API/V1/drawings/x",
      "/Api/v1/drawings/x",
      "/api/V1/drawings/x",
    ]) {
      expect((await call("put", path, "oepat_read")).status).toBe(403);
    }
    expect(
      (await call("post", "/api/v1/ADMIN/users", "oepat_write")).status,
    ).toBe(403);
  });

  it("allows reads for a read-scoped token", async () => {
    const response = await call("get", "/api/v1/drawings", "oepat_read");

    expect(response.status).toBe(200);
  });

  it("refuses admin routes below full scope, whatever the method", async () => {
    for (const secret of ["oepat_read", "oepat_write"]) {
      expect((await call("post", "/api/v1/admin/users", secret)).status).toBe(
        403,
      );
      expect((await call("get", "/api/v1/admin/overview", secret)).status).toBe(
        403,
      );
    }
  });

  it("lets a full-scope token through everywhere", async () => {
    expect(
      (await call("post", "/api/v1/admin/users", "oepat_full")).status,
    ).toBe(200);
    expect((await call("put", "/api/v1/drawings/x", "oepat_full")).status).toBe(
      200,
    );
    expect((await call("post", "/api/v1/drawings", "oepat_write")).status).toBe(
      200,
    );
  });

  it("leaves session and unauthenticated requests alone", async () => {
    expect((await call("put", "/api/v1/drawings/x")).status).toBe(200);
    const cookie = await request(app)
      .put("/api/v1/drawings/x")
      .set("cookie", "session=abc");
    expect(cookie.status).toBe(200);
  });

  it("passes an unknown token through so the route answers 401", async () => {
    expect((await call("put", "/api/v1/drawings/x", "oepat_gone")).status).toBe(
      200,
    );
  });

  it("does not apply the method rule to the MCP endpoint", async () => {
    // /api/mcp is POST-only JSON-RPC whatever the tool does; the MCP layer
    // gates writes by only registering the tools a scope allows.
    expect((await call("post", "/api/mcp", "oepat_read")).status).toBe(200);
  });
});
