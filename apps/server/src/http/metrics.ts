import { createHash, timingSafeEqual } from "node:crypto";

import type { AdminOverview } from "@open-excalidraw/contracts";
import { Router } from "express";

import type { MaintenanceResult } from "../jobs/index.js";

export interface LastMaintenanceRun {
  finishedAt: Date;
  result: MaintenanceResult;
}

export interface CreateMetricsRouterInput {
  /** Unset disables the endpoint entirely (404). */
  token?: string;
  overview(): Promise<AdminOverview>;
  activeSessions(): Promise<number>;
  collabConnections(): number;
  lastMaintenance(): LastMaintenanceRun | null;
}

/**
 * Prometheus text-format scrape endpoint. Bearer-token auth (METRICS_TOKEN)
 * rather than the admin session gate: scrape configs speak `authorization`
 * headers, not browser cookies.
 */
export function createMetricsRouter(input: CreateMetricsRouterInput): Router {
  const router = Router();

  router.get("/metrics", (request, response) => {
    void (async () => {
      if (!input.token) {
        response.status(404).type("text/plain").send("metrics are disabled\n");
        return;
      }
      if (!bearerMatches(request.get("authorization"), input.token)) {
        response
          .status(401)
          .set("www-authenticate", 'Bearer realm="metrics"')
          .type("text/plain")
          .send("a valid metrics bearer token is required\n");
        return;
      }

      const [overview, activeSessions] = await Promise.all([
        input.overview(),
        input.activeSessions(),
      ]);

      const lines: string[] = [];
      const gauge = (name: string, help: string, value: number) => {
        lines.push(
          `# HELP ${name} ${help}`,
          `# TYPE ${name} gauge`,
          `${name} ${value}`,
        );
      };

      gauge(
        "openexcalidraw_users",
        "Registered user accounts.",
        overview.users,
      );
      gauge(
        "openexcalidraw_drawings",
        "Drawings that are not soft-deleted.",
        overview.drawings,
      );
      gauge(
        "openexcalidraw_storage_bytes",
        "Bytes of stored drawing assets.",
        overview.storageBytes,
      );
      gauge(
        "openexcalidraw_active_sessions",
        "Authentication sessions that have not expired.",
        activeSessions,
      );
      gauge(
        "openexcalidraw_collab_connections",
        "Live collaboration socket connections.",
        input.collabConnections(),
      );

      const maintenance = input.lastMaintenance();
      if (maintenance) {
        gauge(
          "openexcalidraw_maintenance_last_run_timestamp_seconds",
          "Unix time the most recent maintenance run finished.",
          maintenance.finishedAt.getTime() / 1000,
        );
        gauge(
          "openexcalidraw_maintenance_failures",
          "Failed cleanup operations in the most recent maintenance run.",
          maintenance.result.failures.length,
        );
        for (const [field, value] of Object.entries(maintenance.result)) {
          if (typeof value !== "number") continue;
          gauge(
            `openexcalidraw_maintenance_${snakeCase(field)}`,
            `Records removed (${field}) by the most recent maintenance run.`,
            value,
          );
        }
      }

      response
        .status(200)
        .set("cache-control", "no-store")
        .type("text/plain; version=0.0.4; charset=utf-8")
        .send(`${lines.join("\n")}\n`);
    })().catch(() => {
      if (!response.headersSent) {
        response
          .status(500)
          .type("text/plain")
          .send("metrics collection failed\n");
      }
    });
  });

  return router;
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const supplied = /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1];
  if (!supplied) return false;
  // Hash both sides so timingSafeEqual always gets equal-length buffers.
  return timingSafeEqual(sha256(supplied), sha256(token));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function snakeCase(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
