import { randomUUID } from "node:crypto";

import {
  createInvitationRequestSchema,
  updateMemberRoleRequestSchema,
  uuidSchema,
} from "@open-excalidraw/contracts";
import { Router, type Request, type Response } from "express";
import { z } from "zod";

import type { IdentityService, RequestIdentity } from "../auth/identity.js";
import { SharingDomainError } from "./errors.js";
import type { SharingService } from "./service.js";

const invitationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export function createSharingRouter(input: {
  service: SharingService;
  identity: IdentityService;
}): Router {
  const router = Router();

  router.get(
    "/api/v1/drawings/:drawingId/members",
    async (request, response) => {
      await authenticated(
        request,
        response,
        input.identity,
        async (identity) => ({
          status: 200,
          body: await input.service.list(identity.userId, drawingId(request)),
        }),
      );
    },
  );

  router.post(
    "/api/v1/drawings/:drawingId/invitations",
    async (request, response) => {
      await authenticated(
        request,
        response,
        input.identity,
        async (identity) => ({
          status: 201,
          body: await input.service.invite(
            identity.userId,
            drawingId(request),
            createInvitationRequestSchema.parse(request.body),
          ),
        }),
      );
    },
  );

  router.patch(
    "/api/v1/drawings/:drawingId/members/:userId",
    async (request, response) => {
      await authenticated(
        request,
        response,
        input.identity,
        async (identity) => {
          const body = updateMemberRoleRequestSchema.parse(request.body);
          await input.service.updateMember(
            identity.userId,
            drawingId(request),
            uuidSchema.parse(request.params.userId),
            body.role,
          );
          return { status: 204 };
        },
      );
    },
  );

  router.delete(
    "/api/v1/drawings/:drawingId/members/:userId",
    async (request, response) => {
      await authenticated(
        request,
        response,
        input.identity,
        async (identity) => {
          await input.service.removeMember(
            identity.userId,
            drawingId(request),
            uuidSchema.parse(request.params.userId),
          );
          return { status: 204 };
        },
      );
    },
  );

  router.delete(
    "/api/v1/drawings/:drawingId/invitations/:invitationId",
    async (request, response) => {
      await authenticated(
        request,
        response,
        input.identity,
        async (identity) => {
          await input.service.revokeInvitation(
            identity.userId,
            drawingId(request),
            uuidSchema.parse(request.params.invitationId),
          );
          return { status: 204 };
        },
      );
    },
  );

  router.get("/api/v1/invitations/:token", async (request, response) => {
    await route(request, response, async () => ({
      status: 200,
      body: await input.service.inspect(token(request)),
    }));
  });

  router.post(
    "/api/v1/invitations/:token/accept",
    async (request, response) => {
      await authenticated(
        request,
        response,
        input.identity,
        async (identity) => ({
          status: 200,
          body: await input.service.accept(identity, token(request)),
        }),
      );
    },
  );
  return router;
}

interface RouteResult {
  status: number;
  body?: unknown;
}

async function authenticated(
  request: Request,
  response: Response,
  identityService: IdentityService,
  action: (identity: RequestIdentity) => Promise<RouteResult>,
) {
  await route(request, response, async () => {
    const identity = await identityService.resolve(request.headers);
    if (!identity) {
      throw new SharingDomainError(
        "AUTHENTICATION_REQUIRED",
        401,
        "Authentication is required",
      );
    }
    return action(identity);
  });
}

async function route(
  request: Request,
  response: Response,
  action: () => Promise<RouteResult>,
) {
  const requestId = requestIdFor(request);
  try {
    const result = await action();
    response.setHeader("x-request-id", requestId);
    response.setHeader("cache-control", "no-store");
    if (result.body === undefined) response.sendStatus(result.status);
    else response.status(result.status).json(result.body);
  } catch (error) {
    response.setHeader("x-request-id", requestId);
    response.type("application/problem+json");
    if (error instanceof SharingDomainError) {
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

function token(request: Request) {
  return invitationTokenSchema.parse(request.params.token);
}

function requestIdFor(request: Request) {
  const supplied = request.header("x-request-id")?.trim();
  return supplied && supplied.length <= 128 ? supplied : randomUUID();
}
