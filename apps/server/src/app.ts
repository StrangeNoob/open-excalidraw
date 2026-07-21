import { join } from "node:path";

import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from "express";
import helmet from "helmet";

import { safeRequestId } from "./http/request-context.js";
import { requireSameOrigin } from "./http/same-origin.js";

// Brand assets that third-party sites (template galleries, link previews)
// must be able to embed; everything else stays CORP same-origin.
const PUBLIC_BRAND_ASSET =
  /^\/(?:favicon\.svg|icon-\d+\.png|apple-touch-icon\.png)$/;

export interface CreateAppOptions {
  allowedOrigins?: readonly string[];
  readiness?: () => Promise<void>;
  routers?: readonly RequestHandler[];
  staticDirectory?: string;
  /**
   * Set only when a reverse proxy that overwrites `x-forwarded-for` and
   * `x-real-ip` sits in front. Defaults to false: without such a proxy those
   * headers are attacker-controlled, and trusting them would let a client
   * rotate them to evade per-IP throttling on authentication routes.
   */
  trustProxy?: boolean;
}

/**
 * WebSocket CSP sources for the trusted browser origins. Socket.IO connects to
 * the same origin as the page, so each HTTP(S) origin maps to its ws(s)
 * equivalent. Invalid entries are skipped; `requireSameOrigin` validates the
 * same list and is the authority on rejecting them.
 */
function websocketSources(origins: readonly string[]): string[] {
  const sources = new Set<string>();
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      const scheme = url.protocol === "https:" ? "wss:" : "ws:";
      sources.add(`${scheme}//${url.host}`);
    } catch {
      continue;
    }
  }
  return [...sources];
}

export const createApp = ({
  allowedOrigins = [],
  readiness,
  routers = [],
  staticDirectory,
  trustProxy = false,
}: CreateAppOptions = {}): Express => {
  const app = express();

  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          baseUri: ["'self'"],
          childSrc: ["'self'", "blob:"],
          connectSrc: [
            "'self'",
            // Scoped to the configured origins rather than bare ws:/wss:,
            // which match any host and would leave CSP unable to contain
            // WebSocket exfiltration if script injection ever occurred.
            ...websocketSources(allowedOrigins),
            "https://libraries.excalidraw.com",
          ],
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
    if (PUBLIC_BRAND_ASSET.test(request.path)) {
      response.set("cross-origin-resource-policy", "cross-origin");
    }
    next();
  });
  app.use((request, response, next) => {
    const requestId = safeRequestId(request.get("x-request-id"));
    response.locals.requestId = requestId;
    response.set("x-request-id", requestId);
    next();
  });
  app.use((request, _response, next) => {
    if (!trustProxy) {
      // Nothing trustworthy sits in front, so these are just client input.
      // Discarding them before anything downstream reads them stops a caller
      // from rotating the header to look like a new IP each request and so
      // slipping past the per-IP limits on the authentication routes.
      delete request.headers["x-forwarded-for"];
      delete request.headers["x-real-ip"];
    }
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
