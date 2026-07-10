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
