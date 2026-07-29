import { uuidSchema } from "@open-excalidraw/contracts";
import { Router } from "express";
import { z } from "zod";

import { requestIdFor } from "../../http/request-context.js";

import type { IdentityService } from "../auth/identity.js";
import { ContentDomainError } from "../content/errors.js";
import { ExportDomainError } from "./errors.js";
import type { ExportService } from "./service.js";

const querySchema = z.object({
  format: z.enum(["svg", "png"]).default("svg"),
  scale: z.coerce.number().int().min(1).max(2).default(1),
});

export interface CreateExportRouterInput {
  service: ExportService;
  identity: IdentityService;
  /** Receives the render failures the response cannot describe. */
  logError?: (
    event: string,
    error: unknown,
    context?: Record<string, unknown>,
  ) => void;
}

export function createExportRouter(input: CreateExportRouterInput): Router {
  const router = Router();

  router.get("/api/v1/drawings/:drawingId/export", (request, response) => {
    const requestId = requestIdFor(request, response);
    void (async () => {
      try {
        const identity = await input.identity.resolve(request.headers);
        if (!identity) {
          throw new ExportDomainError(
            "AUTHENTICATION_REQUIRED",
            401,
            "Authentication is required",
          );
        }
        const drawingId = uuidSchema.parse(request.params.drawingId);
        const { format, scale } = querySchema.parse(request.query);

        // The content revision already identifies the scene exactly, so it
        // plus the rendering parameters is the whole cache key — nothing is
        // stored, and reading the revision first means an unchanged drawing
        // never pays for the render its 304 would throw away.
        const tagFor = (revision: string) =>
          `"${revision}-${format}-${scale}x"`;
        const conditional = request.header("if-none-match");
        response.setHeader("cache-control", "private, no-cache");
        response.setHeader("x-request-id", requestId);
        if (conditional) {
          const etag = tagFor(
            await input.service.revision(identity.userId, drawingId),
          );
          if (ifNoneMatch(conditional, etag)) {
            response.setHeader("etag", etag);
            response.status(304).end();
            return;
          }
        }

        const result = await input.service.render(identity.userId, drawingId, {
          format,
          scale,
        });
        response.setHeader("etag", tagFor(result.revision));
        // Same hardening the asset route gives user-supplied bytes: an SVG is
        // a document, and this one carries element links.
        response.setHeader("content-security-policy", "sandbox");
        response.setHeader("cross-origin-resource-policy", "same-origin");
        response.setHeader("x-content-type-options", "nosniff");
        response.setHeader("content-type", result.contentType);
        response.status(200).send(result.body);
      } catch (error) {
        if (error instanceof ExportDomainError && error.status >= 500) {
          input.logError?.("export.render_failed", error.cause ?? error, {
            requestId,
          });
        }
        response.setHeader("x-request-id", requestId);
        response.type("application/problem+json");
        if (
          error instanceof ExportDomainError ||
          error instanceof ContentDomainError
        ) {
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
        input.logError?.("export.request_failed", error, { requestId });
        response.status(500).json({
          code: "INTERNAL_ERROR",
          status: 500,
          title: "The request could not be completed",
          requestId,
        });
      }
    })();
  });

  return router;
}

function ifNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .includes(etag);
}
