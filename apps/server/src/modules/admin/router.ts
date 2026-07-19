import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { requestIdFor } from "../../http/request-context.js";

import { isInstanceAdmin } from "../auth/identity.js";
import type { IdentityService, RequestIdentity } from "../auth/identity.js";
import { AdminDomainError } from "./errors.js";
import type { AdminService } from "./service.js";

export interface CreateAdminRouterInput {
  service: AdminService;
  identity: IdentityService;
  /** Lowercased admin emails; empty set means no one is an admin. */
  adminEmails: ReadonlySet<string>;
}

export function createAdminRouter(input: CreateAdminRouterInput): Router {
  const router = Router();

  router.get("/api/v1/admin/overview", (request, response) => {
    void handle(request, response, input, async () => ({
      status: 200,
      body: await input.service.getOverview(),
    }));
  });

  router.get("/api/v1/admin/users", (request, response) => {
    void handle(request, response, input, async () => ({
      status: 200,
      body: await input.service.listUsers({
        search: stringParam(request.query.search),
        limit: stringParam(request.query.limit),
      }),
    }));
  });

  router.post("/api/v1/admin/users/:userId/disable", (request, response) => {
    void handle(request, response, input, async (identity, requestId) => {
      await input.service.disableUser({
        actorUserId: identity.userId,
        targetUserId: request.params.userId,
        requestId,
      });
      return { status: 204 };
    });
  });

  router.post("/api/v1/admin/users/:userId/enable", (request, response) => {
    void handle(request, response, input, async (identity, requestId) => {
      await input.service.enableUser({
        actorUserId: identity.userId,
        targetUserId: request.params.userId,
        requestId,
      });
      return { status: 204 };
    });
  });

  router.post(
    "/api/v1/admin/users/:userId/two-factor/disable",
    (request, response) => {
      void handle(request, response, input, async (identity, requestId) => {
        await input.service.resetTwoFactor({
          actorUserId: identity.userId,
          targetUserId: request.params.userId,
          requestId,
        });
        return { status: 204 };
      });
    },
  );

  router.delete("/api/v1/admin/users/:userId", (request, response) => {
    void handle(request, response, input, async (identity, requestId) => {
      await input.service.deleteUser({
        actorUserId: identity.userId,
        targetUserId: request.params.userId,
        requestId,
      });
      return { status: 204 };
    });
  });

  return router;
}

interface Result {
  status: number;
  body?: unknown;
}

async function handle(
  request: Request,
  response: Response,
  input: CreateAdminRouterInput,
  action: (identity: RequestIdentity, requestId: string) => Promise<Result>,
) {
  const requestId = requestIdFor(request, response);
  try {
    const identity = await input.identity.resolve(request.headers);
    if (!identity) {
      throw new AdminDomainError(
        "AUTHENTICATION_REQUIRED",
        401,
        "Authentication is required",
      );
    }
    if (!isInstanceAdmin(identity, input.adminEmails)) {
      throw new AdminDomainError(
        "ADMIN_ACCESS_REQUIRED",
        403,
        "Administrator access is required",
      );
    }
    const result = await action(identity, requestId);
    response.setHeader("x-request-id", requestId);
    response.setHeader("cache-control", "no-store");
    if (result.body === undefined) {
      response.status(result.status).end();
    } else {
      response.status(result.status).json(result.body);
    }
  } catch (error) {
    response.setHeader("x-request-id", requestId);
    response.type("application/problem+json");
    if (error instanceof AdminDomainError) {
      response.status(error.status).json(error.toProblem(requestId));
      return;
    }
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
    response.status(500).json({
      code: "INTERNAL_ERROR",
      status: 500,
      title: "The request could not be completed",
      requestId,
    });
  }
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Parse the comma-separated ADMIN_EMAILS env value into a lowercased, trimmed
 * allowlist. Empty/unset => empty set, so every admin endpoint answers 403 and
 * `/v1/me` reports `isAdmin: false`.
 */
export function parseAdminEmails(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}
