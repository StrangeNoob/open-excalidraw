import { uuidSchema } from "@open-excalidraw/contracts";
import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { requestIdFor } from "../../http/request-context.js";

import type { IdentityService } from "../auth/identity.js";
import { ChatDomainError } from "./errors.js";
import type { ChatService } from "./service.js";

export interface CreateChatRouterInput {
  service: ChatService;
  identity: IdentityService;
}

export function createChatRouter(input: CreateChatRouterInput): Router {
  const router = Router();

  router.get(
    "/api/v1/drawings/:drawingId/messages",
    async (request, response) => {
      await handle(request, response, input.identity, async (userId) => ({
        status: 200,
        body: await input.service.history(
          userId,
          uuidSchema.parse(request.params.drawingId),
          typeof request.query.before === "string"
            ? request.query.before
            : undefined,
        ),
      }));
    },
  );

  return router;
}

interface RouteResult {
  status: number;
  body?: unknown;
}

async function handle(
  request: Request,
  response: Response,
  identityService: IdentityService,
  action: (userId: string, requestId: string) => Promise<RouteResult>,
): Promise<void> {
  const requestId = requestIdFor(request, response);
  try {
    const identity = await identityService.resolve(request.headers);
    if (!identity) {
      throw new ChatDomainError(
        "AUTHENTICATION_REQUIRED",
        401,
        "Authentication is required",
      );
    }
    const result = await action(identity.userId, requestId);
    response.setHeader("x-request-id", requestId);
    if (result.body === undefined) {
      response.sendStatus(result.status);
    } else {
      response.status(result.status).json(result.body);
    }
  } catch (error) {
    response.setHeader("x-request-id", requestId);
    response.type("application/problem+json");
    if (error instanceof ChatDomainError) {
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
