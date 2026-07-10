import type {
  AuthCapabilities,
  SessionResponse,
} from "@open-excalidraw/contracts";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { toNodeHandler } from "better-auth/node";

import type { OpenExcalidrawAuth } from "./config.js";
import type { IdentityService } from "./identity.js";
import type { ManualResetLinkSource } from "./manual-reset.js";

export interface CreateAuthRouterInput {
  auth: OpenExcalidrawAuth;
  identity: IdentityService;
  capabilities: AuthCapabilities;
  adminResetToken?: string;
  manualResetLinks?: ManualResetLinkSource;
}

export function createAuthRouter(input: CreateAuthRouterInput): Router {
  const router = Router();
  const authHandler = toNodeHandler(input.auth) as RequestHandler;

  if (input.adminResetToken && input.manualResetLinks) {
    router.post(
      "/api/admin/manual-reset-links/consume",
      (request, response) => {
        if (
          !hasAdminToken(
            request.header("authorization"),
            input.adminResetToken!,
          )
        ) {
          response.status(401).json({ error: "Unauthorized" });
          return;
        }

        const email = readEmail(request.body as unknown);
        if (!email.trim()) {
          response.status(400).json({ error: "Email is required" });
          return;
        }

        const link = input.manualResetLinks!.consume(email);
        if (!link) {
          response.status(404).json({ error: "No reset link is available" });
          return;
        }

        response.status(200).json({
          email: link.email,
          expiresAt: link.expiresAt.toISOString(),
          reason: link.reason,
          url: link.url,
        });
      },
    );
  }

  router.get("/api/v1/me", async (request, response, next) => {
    try {
      const identity = await input.identity.resolve(request.headers);
      const body: SessionResponse = {
        user: identity
          ? {
              id: identity.userId,
              email: identity.email,
              name: identity.name,
              image: identity.image,
              emailVerified: identity.emailVerified,
              createdAt: identity.createdAt.toISOString(),
            }
          : null,
        capabilities: input.capabilities,
      };
      response.status(200).json(body);
    } catch (error) {
      next(error);
    }
  });

  router.all(
    [
      "/api/auth/list-sessions",
      "/api/auth/revoke-session",
      "/api/auth/revoke-sessions",
      "/api/auth/revoke-other-sessions",
    ],
    (_request, response) => {
      response.status(404).type("application/problem+json").json({
        code: "SESSION_MANAGEMENT_UNAVAILABLE",
        status: 404,
        title: "Session management is not available",
        requestId: randomUUID(),
      });
    },
  );

  router.all(["/api/auth", "/api/auth/{*path}"], authHandler);
  return router;
}

function hasAdminToken(header: string | undefined, expectedToken: string) {
  const actual = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${expectedToken}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readEmail(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    return "";
  }
  const email = (body as Record<string, unknown>).email;
  return typeof email === "string" ? email : "";
}
