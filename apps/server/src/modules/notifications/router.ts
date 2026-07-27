import { notificationSettingsSchema } from "@open-excalidraw/contracts";
import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { requestIdFor } from "../../http/request-context.js";

import type { IdentityService } from "../auth/identity.js";
import type { NotificationSettingsRepository } from "./repository.js";

export function createNotificationRouter(input: {
  repository: NotificationSettingsRepository;
  identity: IdentityService;
}): Router {
  const router = Router();

  router.get("/api/v1/notification-settings", async (request, response) => {
    await handle(request, response, input.identity, (userId) =>
      input.repository.get(userId),
    );
  });

  router.put("/api/v1/notification-settings", async (request, response) => {
    await handle(request, response, input.identity, (userId) =>
      input.repository.put(
        userId,
        notificationSettingsSchema.parse(request.body),
      ),
    );
  });

  return router;
}

// ponytail: settings have a single failure mode besides validation, so the
// problem bodies are written here instead of behind a module-local error class.
function problem(
  response: Response,
  requestId: string,
  body: { code: string; status: number; title: string },
  extra: Record<string, unknown> = {},
): void {
  response.setHeader("x-request-id", requestId);
  response.type("application/problem+json");
  response.status(body.status).json({ ...body, requestId, ...extra });
}

async function handle(
  request: Request,
  response: Response,
  identityService: IdentityService,
  action: (userId: string) => Promise<unknown>,
) {
  const requestId = requestIdFor(request, response);
  try {
    const identity = await identityService.resolve(request.headers);
    if (!identity) {
      problem(response, requestId, {
        code: "AUTHENTICATION_REQUIRED",
        status: 401,
        title: "Authentication is required",
      });
      return;
    }
    const body = await action(identity.userId);
    response.setHeader("x-request-id", requestId);
    response.setHeader("cache-control", "no-store");
    response.status(200).json(body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      problem(
        response,
        requestId,
        {
          code: "INVALID_REQUEST",
          status: 400,
          title: "Request validation failed",
        },
        { errors: z.flattenError(error).fieldErrors },
      );
      return;
    }
    problem(response, requestId, {
      code: "INTERNAL_ERROR",
      status: 500,
      title: "The request could not be completed",
    });
  }
}
