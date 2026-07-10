import { randomUUID } from "node:crypto";
import { join } from "node:path";

import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from "express";

export interface CreateAppOptions {
  readiness?: () => Promise<void>;
  routers?: readonly RequestHandler[];
  staticDirectory?: string;
}

export const createApp = ({
  readiness,
  routers = [],
  staticDirectory,
}: CreateAppOptions = {}): Express => {
  const app = express();

  app.disable("x-powered-by");
  app.use((request, _response, next) => {
    if (!request.headers["x-real-ip"] && request.socket.remoteAddress) {
      request.headers["x-real-ip"] = request.socket.remoteAddress;
    }
    next();
  });
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

  app.use("/api", (request, response) => {
    const requestId =
      request.get("x-request-id")?.slice(0, 128) || randomUUID();
    response
      .status(404)
      .set("x-request-id", requestId)
      .type("application/problem+json")
      .json({
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
    request,
    response,
    _next,
  ) => {
    void _next;
    const requestId =
      request.get("x-request-id")?.slice(0, 128) || randomUUID();
    response
      .status(500)
      .set("x-request-id", requestId)
      .type("application/problem+json")
      .json({
        code: "INTERNAL_ERROR",
        status: 500,
        title: "The request could not be completed",
        requestId,
      });
  };
  app.use(errorHandler);

  return app;
};
