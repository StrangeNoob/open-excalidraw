import type {
  AuthCapabilities,
  SessionResponse,
} from "@open-excalidraw/contracts";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { APIError } from "better-auth/api";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { z } from "zod";

import type { OpenExcalidrawAuth } from "./config.js";
import { isInstanceAdmin } from "./identity.js";
import type { IdentityService } from "./identity.js";
import type { ManualResetLinkSource } from "./manual-reset.js";

const setPasswordRequestSchema = z
  .object({ newPassword: z.string().min(12).max(128) })
  .strict();

export interface CreateAuthRouterInput {
  auth: OpenExcalidrawAuth;
  identity: IdentityService;
  capabilities: AuthCapabilities;
  /** Lowercased admin emails; drives the `isAdmin` flag on `/v1/me`. */
  adminEmails?: ReadonlySet<string>;
  adminResetToken?: string;
  manualResetLinks?: ManualResetLinkSource;
}

const NO_ADMINS: ReadonlySet<string> = new Set();

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
              isAdmin: isInstanceAdmin(
                identity,
                input.adminEmails ?? NO_ADMINS,
              ),
              twoFactorEnabled: identity.twoFactorEnabled,
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

  // better-auth's set-password endpoint is server-only, so OAuth-only users
  // need this proxy to add a password to their account.
  router.post("/api/v1/me/password", async (request, response) => {
    const requestId = randomUUID();
    response.setHeader("x-request-id", requestId);
    try {
      const identity = await input.identity.resolve(request.headers);
      if (!identity) {
        response.status(401).type("application/problem+json").json({
          code: "AUTHENTICATION_REQUIRED",
          status: 401,
          title: "Authentication is required",
          requestId,
        });
        return;
      }
      const body = setPasswordRequestSchema.parse(request.body);
      await input.auth.api.setPassword({
        body: { newPassword: body.newPassword },
        headers: fromNodeHeaders(request.headers),
      });
      response.sendStatus(204);
    } catch (error) {
      response.type("application/problem+json");
      if (error instanceof z.ZodError) {
        response.status(400).json({
          code: "INVALID_REQUEST",
          status: 400,
          title: "Request validation failed",
          requestId,
          errors: z.flattenError(error).fieldErrors,
        });
        return;
      }
      if (error instanceof APIError) {
        response.status(error.statusCode).json({
          code: "SET_PASSWORD_FAILED",
          status: error.statusCode,
          title: error.body?.message ?? "The password could not be set",
          requestId,
        });
        return;
      }
      response.status(500).json({
        code: "INTERNAL_ERROR",
        status: 500,
        title: "The request could not be completed",
        requestId,
      });
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

  // better-auth's generic OAuth link route has no email-verification gate of
  // its own, so enforce the same invariant as core social linking here.
  router.post("/api/auth/oauth2/link", async (request, response, next) => {
    try {
      const identity = await input.identity.resolve(request.headers);
      if (!identity) {
        response.status(401).type("application/problem+json").json({
          code: "AUTHENTICATION_REQUIRED",
          status: 401,
          title: "Authentication is required",
          requestId: randomUUID(),
        });
        return;
      }
      if (!identity.emailVerified) {
        response.status(403).type("application/problem+json").json({
          code: "EMAIL_VERIFICATION_REQUIRED",
          status: 403,
          title: "Verify your email before linking an account",
          requestId: randomUUID(),
        });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  });

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
