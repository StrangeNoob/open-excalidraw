import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Router } from "express";
import request from "supertest";

import { createApp } from "../../src/app";

describe("health endpoint", () => {
  it("reports the process as live", async () => {
    const response = await request(createApp()).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["content-security-policy"]).toContain(
      "worker-src 'self' blob:",
    );
    // Guards the public-library import flow: the web bundle fetches
    // .excalidrawlib JSON from libraries.excalidraw.com under this CSP.
    expect(response.headers["content-security-policy"]).toContain(
      "connect-src 'self' https://libraries.excalidraw.com",
    );
    expect(response.headers["x-request-id"]).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it("scopes WebSocket CSP sources to the trusted origins", async () => {
    const app = createApp({
      allowedOrigins: ["https://draw.example.test", "http://localhost:5173"],
    });

    const response = await request(app).get("/health/live").expect(200);
    const csp = response.headers["content-security-policy"] ?? "";

    expect(csp).toContain(
      "connect-src 'self' wss://draw.example.test ws://localhost:5173 https://libraries.excalidraw.com",
    );
    // Bare schemes match any host and must not reappear: they would let
    // injected script open a socket to an attacker-controlled server.
    expect(csp).not.toMatch(/connect-src[^;]*\sws:\s/);
    expect(csp).not.toMatch(/connect-src[^;]*\swss:\s/);
  });

  it("preserves a safe caller request ID on success and errors", async () => {
    const app = createApp();

    await request(app)
      .get("/health/live")
      .set("x-request-id", "edge:request-123")
      .expect("x-request-id", "edge:request-123")
      .expect(200);
    const missing = await request(app)
      .get("/api/v1/missing")
      .set("x-request-id", "edge:request-456")
      .expect("x-request-id", "edge:request-456")
      .expect(404);
    expect(missing.body.requestId).toBe("edge:request-456");

    const rejectedId = await request(app)
      .get("/api/v1/missing")
      .set("x-request-id", "not a safe request id")
      .expect(404);
    expect(rejectedId.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/,
    );
    expect(rejectedId.body.requestId).toBe(rejectedId.headers["x-request-id"]);
  });

  it("rejects unsafe browser requests from untrusted origins", async () => {
    const router = Router()
      .post("/api/v1/change", (_request, response) =>
        response.status(204).end(),
      )
      .get("/api/auth/callback/provider", (_request, response) =>
        response.status(204).end(),
      );
    const app = createApp({
      allowedOrigins: ["https://draw.example.test"],
      routers: [router],
    });

    await request(app)
      .post("/api/v1/change")
      .set("origin", "https://draw.example.test")
      .expect(204);
    await request(app).post("/api/v1/change").expect(204);
    const rejected = await request(app)
      .post("/api/v1/change")
      .set("origin", "https://evil.example.test")
      .expect(403);
    expect(rejected.body).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    await request(app)
      .post("/api/v1/change")
      .set("sec-fetch-site", "cross-site")
      .expect(403);
    await request(app)
      .get("/api/auth/callback/provider")
      .set("origin", "https://accounts.example.test")
      .expect(204);
  });

  it("discards spoofable forwarded headers unless a proxy is trusted", async () => {
    const seen: Array<Record<string, string | undefined>> = [];
    const probe = Router().get("/api/v1/probe", (request, response) => {
      seen.push({
        forwardedFor: request.headers["x-forwarded-for"] as string | undefined,
        realIp: request.headers["x-real-ip"] as string | undefined,
      });
      response.status(204).end();
    });

    // Default: no proxy in front, so a caller cannot dictate its own IP.
    // Better Auth reads these headers to key per-IP auth throttling, so a
    // preserved value would let a client rotate it to evade the limit.
    await request(createApp({ routers: [probe] }))
      .get("/api/v1/probe")
      .set("x-forwarded-for", "203.0.113.9")
      .set("x-real-ip", "203.0.113.9")
      .expect(204);
    expect(seen[0]?.forwardedFor).toBeUndefined();
    expect(seen[0]?.realIp).not.toBe("203.0.113.9");
    expect(seen[0]?.realIp).toBeDefined();

    // Behind a proxy that overwrites them, the forwarded values are authoritative.
    await request(createApp({ routers: [probe], trustProxy: true }))
      .get("/api/v1/probe")
      .set("x-forwarded-for", "203.0.113.9")
      .set("x-real-ip", "203.0.113.9")
      .expect(204);
    expect(seen[1]).toEqual({
      forwardedFor: "203.0.113.9",
      realIp: "203.0.113.9",
    });
  });

  it("reports readiness failures without changing liveness", async () => {
    const app = createApp({
      readiness: () => Promise.reject(new Error("database unavailable")),
    });

    await request(app).get("/health/ready").expect(503, {
      status: "unavailable",
    });
    await request(app).get("/health/live").expect(200, { status: "ok" });
  });

  it("serves public brand assets with CORP cross-origin", async () => {
    const staticDirectory = await mkdtemp(
      join(tmpdir(), "open-excalidraw-web-"),
    );
    try {
      await writeFile(join(staticDirectory, "index.html"), "<!doctype html>");
      await writeFile(join(staticDirectory, "icon-512.png"), "png");
      await writeFile(join(staticDirectory, "favicon.svg"), "<svg/>");
      const app = createApp({ staticDirectory });

      const icon = await request(app).get("/icon-512.png").expect(200);
      expect(icon.headers["cross-origin-resource-policy"]).toBe("cross-origin");
      const favicon = await request(app).get("/favicon.svg").expect(200);
      expect(favicon.headers["cross-origin-resource-policy"]).toBe(
        "cross-origin",
      );
      const spa = await request(app).get("/drawings/example").expect(200);
      expect(spa.headers["cross-origin-resource-policy"]).toBe("same-origin");
      const api = await request(app).get("/api/v1/missing").expect(404);
      expect(api.headers["cross-origin-resource-policy"]).toBe("same-origin");
    } finally {
      await rm(staticDirectory, { force: true, recursive: true });
    }
  });

  it("mounts API routers and serves the SPA fallback", async () => {
    const staticDirectory = await mkdtemp(
      join(tmpdir(), "open-excalidraw-web-"),
    );
    await writeFile(
      join(staticDirectory, "index.html"),
      "<!doctype html><title>Open Excalidraw</title>",
    );
    const router = Router().get("/api/v1/example", (_request, response) => {
      response.json({ mounted: true });
    });
    const app = createApp({ routers: [router], staticDirectory });

    await request(app).get("/api/v1/example").expect(200, { mounted: true });
    await request(app).get("/api/v1/missing").expect(404);
    const spa = await request(app).get("/drawings/example").expect(200);
    expect(spa.text).toContain("Open Excalidraw");

    await rm(staticDirectory, { force: true, recursive: true });
  });
});
