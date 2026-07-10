import { randomUUID } from "node:crypto";

import { revisionSchema, uuidSchema } from "@open-excalidraw/contracts";
import { Router, type Request, type Response } from "express";
import { z } from "zod";

import type { IdentityService } from "../auth/identity.js";
import { ContentDomainError } from "./errors.js";
import type { ContentService } from "./service.js";

const MAX_BIGINT = 9_223_372_036_854_775_807n;

export function createContentRouter(input: {
  service: ContentService;
  identity: IdentityService;
}): Router {
  const router = Router();

  router.get(
    "/api/v1/drawings/:drawingId/content",
    async (request, response) => {
      await handle(request, response, input.identity, async (userId) => {
        const body = await input.service.load(userId, drawingId(request));
        return { status: 200, body, etag: body.revision };
      });
    },
  );

  router.put(
    "/api/v1/drawings/:drawingId/content",
    async (request, response) => {
      await handle(request, response, input.identity, async (userId) => {
        const body = await input.service.save(
          userId,
          drawingId(request),
          parseIfMatch(request),
          parseIdempotencyKey(request),
          request.body,
        );
        return { status: 200, body, etag: body.revision };
      });
    },
  );

  router.get(
    "/api/v1/drawings/:drawingId/revisions",
    async (request, response) => {
      await handle(request, response, input.identity, async (userId) => ({
        status: 200,
        body: await input.service.listRevisions(userId, drawingId(request)),
      }));
    },
  );

  router.post(
    "/api/v1/drawings/:drawingId/revisions/:revision/restore",
    async (request, response) => {
      await handle(request, response, input.identity, async (userId) => {
        const body = await input.service.restore(
          userId,
          drawingId(request),
          parseRevision(request.params.revision),
        );
        return { status: 200, body, etag: body.revision };
      });
    },
  );
  return router;
}

interface Result {
  status: number;
  body?: unknown;
  etag?: string;
}

async function handle(
  request: Request,
  response: Response,
  identityService: IdentityService,
  action: (userId: string) => Promise<Result>,
) {
  const requestId = requestIdFor(request);
  try {
    const identity = await identityService.resolve(request.headers);
    if (!identity) {
      throw new ContentDomainError(
        "AUTHENTICATION_REQUIRED",
        401,
        "Authentication is required",
      );
    }
    const result = await action(identity.userId);
    response.setHeader("x-request-id", requestId);
    response.setHeader("cache-control", "no-store");
    if (result.etag) response.setHeader("etag", `"${result.etag}"`);
    response.status(result.status).json(result.body);
  } catch (error) {
    response.setHeader("x-request-id", requestId);
    response.type("application/problem+json");
    if (error instanceof ContentDomainError) {
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

function drawingId(request: Request) {
  return uuidSchema.parse(request.params.drawingId);
}

function parseIfMatch(request: Request): bigint {
  const value = request.header("if-match")?.trim();
  if (!value) {
    throw new ContentDomainError(
      "PRECONDITION_REQUIRED",
      428,
      "If-Match is required",
    );
  }
  if (value === "*") {
    throw new ContentDomainError(
      "INVALID_REVISION",
      400,
      "A specific revision is required",
    );
  }
  const unquoted =
    value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  return parseRevision(unquoted);
}

function parseRevision(value: string | undefined) {
  const parsed = BigInt(revisionSchema.parse(value));
  if (parsed > MAX_BIGINT) {
    throw new ContentDomainError(
      "INVALID_REVISION",
      400,
      "Revision is out of range",
    );
  }
  return parsed;
}

function parseIdempotencyKey(request: Request) {
  const value = request.header("idempotency-key")?.trim();
  if (!value) {
    throw new ContentDomainError(
      "IDEMPOTENCY_KEY_REQUIRED",
      400,
      "Idempotency-Key is required",
    );
  }
  return uuidSchema.parse(value);
}

function requestIdFor(request: Request) {
  const supplied = request.header("x-request-id")?.trim();
  return supplied && supplied.length <= 128 ? supplied : randomUUID();
}
