import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { uuidSchema } from "@open-excalidraw/contracts";

import { requestIdFor } from "../../http/request-context.js";

import type { IdentityService, RequestIdentity } from "../auth/identity.js";
import { TokenDomainError } from "./errors.js";
import type { TokenService } from "./service.js";

export interface CreateTokenRouterInput {
  service: TokenService;
  identity: IdentityService;
}

export function createTokenRouter(input: CreateTokenRouterInput): Router {
  const router = Router();

  router.get("/api/v1/tokens", (request, response) => {
    void handle(request, response, input, async (identity) => ({
      status: 200,
      body: await input.service.list(identity.userId),
    }));
  });

  router.post("/api/v1/tokens", (request, response) => {
    void handle(request, response, input, async (identity, requestId) => ({
      status: 201,
      body: await input.service.create({
        userId: identity.userId,
        requestId,
        body: request.body,
      }),
    }));
  });

  router.delete("/api/v1/tokens/:tokenId", (request, response) => {
    void handle(request, response, input, async (identity, requestId) => {
      await input.service.revoke({
        userId: identity.userId,
        tokenId: uuidSchema.parse(request.params.tokenId),
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
  input: CreateTokenRouterInput,
  action: (identity: RequestIdentity, requestId: string) => Promise<Result>,
) {
  const requestId = requestIdFor(request, response);
  try {
    const identity = await input.identity.resolve(request.headers);
    if (!identity) {
      throw new TokenDomainError(
        "AUTHENTICATION_REQUIRED",
        401,
        "Authentication is required",
      );
    }
    // Token management is session-only: a leaked personal access token must not
    // be able to mint or revoke tokens, only make ordinary REST calls.
    if (identity.authKind === "token") {
      throw new TokenDomainError(
        "TOKEN_MANAGEMENT_REQUIRES_SESSION",
        403,
        "Personal access tokens must be managed from a signed-in session",
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
    if (error instanceof TokenDomainError) {
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
