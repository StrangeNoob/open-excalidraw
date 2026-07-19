import request from "supertest";

import { createApp } from "../../src/app";
import {
  createMetricsRouter,
  type CreateMetricsRouterInput,
} from "../../src/http/metrics";
import type { MaintenanceResult } from "../../src/jobs/index.js";

const sources = {
  overview: () =>
    Promise.resolve({ users: 7, drawings: 3, storageBytes: 4096 }),
  activeSessions: () => Promise.resolve(2),
  collabConnections: () => 5,
  lastMaintenance: () => null,
} satisfies Omit<CreateMetricsRouterInput, "token">;

const maintenanceResult: MaintenanceResult = {
  revisionsPruned: 4,
  orphanAssetsDeleted: 1,
  expiredInvitationsDeleted: 0,
  expiredSessionsDeleted: 6,
  expiredVerificationsDeleted: 0,
  auditEventsDeleted: 9,
  mutationsDeleted: 2,
  drawingsPurged: 1,
  failures: [{ id: "a", errorType: "StorageError", stage: "asset-delete" }],
};

function app(input: CreateMetricsRouterInput) {
  return createApp({ routers: [createMetricsRouter(input)] });
}

describe("metrics endpoint", () => {
  it("answers 404 while no token is configured", async () => {
    const response = await request(app({ ...sources })).get("/metrics");
    expect(response.status).toBe(404);
  });

  it("rejects missing and wrong bearer tokens", async () => {
    const fixture = app({ ...sources, token: "scrape-token" });

    const missing = await request(fixture).get("/metrics");
    expect(missing.status).toBe(401);
    expect(missing.headers["www-authenticate"]).toContain("Bearer");

    const wrong = await request(fixture)
      .get("/metrics")
      .set("authorization", "Bearer nope");
    expect(wrong.status).toBe(401);
  });

  it("serves instance gauges in Prometheus text format", async () => {
    const response = await request(app({ ...sources, token: "scrape-token" }))
      .get("/metrics")
      .set("authorization", "Bearer scrape-token");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.text).toContain("# TYPE openexcalidraw_users gauge");
    expect(response.text).toContain("openexcalidraw_users 7");
    expect(response.text).toContain("openexcalidraw_drawings 3");
    expect(response.text).toContain("openexcalidraw_storage_bytes 4096");
    expect(response.text).toContain("openexcalidraw_active_sessions 2");
    expect(response.text).toContain("openexcalidraw_collab_connections 5");
    // No maintenance run has completed yet, so its gauges are absent.
    expect(response.text).not.toContain("openexcalidraw_maintenance");
  });

  it("reports the most recent maintenance run", async () => {
    const response = await request(
      app({
        ...sources,
        token: "scrape-token",
        lastMaintenance: () => ({
          finishedAt: new Date(1_700_000_000_000),
          result: maintenanceResult,
        }),
      }),
    )
      .get("/metrics")
      .set("authorization", "Bearer scrape-token");

    expect(response.status).toBe(200);
    expect(response.text).toContain(
      "openexcalidraw_maintenance_last_run_timestamp_seconds 1700000000",
    );
    expect(response.text).toContain("openexcalidraw_maintenance_failures 1");
    expect(response.text).toContain(
      "openexcalidraw_maintenance_revisions_pruned 4",
    );
    expect(response.text).toContain(
      "openexcalidraw_maintenance_expired_sessions_deleted 6",
    );
    expect(response.text).toContain(
      "openexcalidraw_maintenance_drawings_purged 1",
    );
  });
});
