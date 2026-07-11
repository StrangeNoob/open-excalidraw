import {
  createDrawingRequestSchema,
  updateDrawingRequestSchema,
  uuidSchema,
} from "@open-excalidraw/contracts";
import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { requestIdFor } from "../../http/request-context.js";

import type { IdentityService } from "../auth/identity.js";
import { DrawingDomainError } from "./errors.js";
import type { DrawingService } from "./service.js";

const transferOwnershipSchema = z
  .object({ newOwnerUserId: uuidSchema })
  .strict();

export interface CreateDrawingRouterInput {
  service: DrawingService;
  identity: IdentityService;
}

export function createDrawingRouter(input: CreateDrawingRouterInput): Router {
  const router = Router();

  router.get("/api/v1/drawings", async (request, response) => {
    await handle(request, response, input.identity, async (userId) => ({
      status: 200,
      body: await input.service.list(userId),
    }));
  });

  router.post("/api/v1/drawings", async (request, response) => {
    await handle(request, response, input.identity, async (userId) => ({
      status: 201,
      body: await input.service.create(
        userId,
        createDrawingRequestSchema.parse(request.body),
      ),
    }));
  });

  router.get("/api/v1/drawings/:drawingId", async (request, response) => {
    await handle(request, response, input.identity, async (userId) => ({
      status: 200,
      body: await input.service.get(userId, drawingId(request)),
    }));
  });

  router.patch("/api/v1/drawings/:drawingId", async (request, response) => {
    await handle(request, response, input.identity, async (userId) => ({
      status: 200,
      body: await input.service.rename(
        userId,
        drawingId(request),
        updateDrawingRequestSchema.parse(request.body),
      ),
    }));
  });

  router.delete("/api/v1/drawings/:drawingId", async (request, response) => {
    await handle(
      request,
      response,
      input.identity,
      async (userId, requestId) => {
        await input.service.delete(userId, drawingId(request), requestId);
        return { status: 204 };
      },
    );
  });

  router.delete(
    "/api/v1/drawings/:drawingId/members/me",
    async (request, response) => {
      await handle(request, response, input.identity, async (userId) => {
        await input.service.leave(userId, drawingId(request));
        return { status: 204 };
      });
    },
  );

  router.post(
    "/api/v1/drawings/:drawingId/transfer-ownership",
    async (request, response) => {
      await handle(
        request,
        response,
        input.identity,
        async (userId, requestId) => {
          const body = transferOwnershipSchema.parse(request.body);
          return {
            status: 200,
            body: await input.service.transferOwnership(
              userId,
              drawingId(request),
              body.newOwnerUserId,
              requestId,
            ),
          };
        },
      );
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
      throw new DrawingDomainError(
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
    if (error instanceof DrawingDomainError) {
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

function drawingId(request: Request): string {
  return uuidSchema.parse(request.params.drawingId);
}
