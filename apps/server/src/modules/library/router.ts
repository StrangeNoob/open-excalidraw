import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { requestIdFor } from "../../http/request-context.js";

import type { IdentityService } from "../auth/identity.js";
import { LibraryDomainError } from "./errors.js";
import type { LibraryService } from "./service.js";

export function createLibraryRouter(input: {
  service: LibraryService;
  identity: IdentityService;
}): Router {
  const router = Router();

  router.get("/api/v1/library", async (request, response) => {
    await handle(request, response, input.identity, async (userId) => ({
      status: 200,
      body: await input.service.load(userId),
    }));
  });

  router.put("/api/v1/library", async (request, response) => {
    await handle(request, response, input.identity, async (userId) => ({
      status: 200,
      body: await input.service.save(userId, request.body),
    }));
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
  identityService: IdentityService,
  action: (userId: string) => Promise<Result>,
) {
  const requestId = requestIdFor(request, response);
  try {
    const identity = await identityService.resolve(request.headers);
    if (!identity) {
      throw new LibraryDomainError(
        "AUTHENTICATION_REQUIRED",
        401,
        "Authentication is required",
      );
    }
    const result = await action(identity.userId);
    response.setHeader("x-request-id", requestId);
    response.setHeader("cache-control", "no-store");
    response.status(result.status).json(result.body);
  } catch (error) {
    response.setHeader("x-request-id", requestId);
    response.type("application/problem+json");
    if (error instanceof LibraryDomainError) {
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
