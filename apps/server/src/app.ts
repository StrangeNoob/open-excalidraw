import { join } from "node:path";

import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from "express";
import helmet from "helmet";

import { safeRequestId } from "./http/request-context.js";
import { requireSameOrigin } from "./http/same-origin.js";

export interface CreateAppOptions {
  allowedOrigins?: readonly string[];
  readiness?: () => Promise<void>;
  routers?: readonly RequestHandler[];
  staticDirectory?: string;
}

export const createApp = ({
  allowedOrigins = [],
  readiness,
  routers = [],
  staticDirectory,
}: CreateAppOptions = {}): Express => {
  const app = express();

  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          baseUri: ["'self'"],
          childSrc: ["'self'", "blob:"],
          connectSrc: ["'self'", "ws:", "wss:"],
          defaultSrc: ["'self'"],
          fontSrc: ["'self'", "data:"],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
          imgSrc: ["'self'", "blob:", "data:"],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          workerSrc: ["'self'", "blob:"],
        },
      },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: false,
    }),
  );
  app.use((request, response, next) => {
    const requestId = safeRequestId(request.get("x-request-id"));
    response.locals.requestId = requestId;
    response.set("x-request-id", requestId);
    next();
  });
  app.use((request, _response, next) => {
    if (!request.headers["x-real-ip"] && request.socket.remoteAddress) {
      request.headers["x-real-ip"] = request.socket.remoteAddress;
    }
    next();
  });
  app.use(requireSameOrigin(allowedOrigins));
  app.use(express.json({ limit: "10mb" }));
  app.get("/health/live", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });
  app.get("/health/ready", async (_request, response) => {
    try {
      await readiness?.();
      response.status(200).json({ status: "ready" });
    } catch {
      response.status(503).json({ status: "unavailable" });
    }
  });

  routers.forEach((router) => app.use(router));

  app.use("/api", (_request, response) => {
    const requestId = response.locals.requestId as string;
    response.status(404).type("application/problem+json").json({
      code: "NOT_FOUND",
      status: 404,
      title: "API route not found",
      requestId,
    });
  });

  if (staticDirectory) {
    app.use(express.static(staticDirectory, { index: false }));
    app.get(/^(?!\/api(?:\/|$)).*/, (_request, response, next) => {
      response.sendFile(join(staticDirectory, "index.html"), (error) => {
        if (error) {
          next(error);
        }
      });
    });
  }

  const errorHandler: ErrorRequestHandler = (
    _error,
    _request,
    response,
    _next,
  ) => {
    void _next;
    const requestId = response.locals.requestId as string;
    response.status(500).type("application/problem+json").json({
      code: "INTERNAL_ERROR",
      status: 500,
      title: "The request could not be completed",
      requestId,
    });
  };
  app.use(errorHandler);

  return app;
};
