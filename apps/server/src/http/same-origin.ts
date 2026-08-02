import type { RequestHandler } from "express";

import {
  OAUTH_REGISTER_ENDPOINT,
  OAUTH_TOKEN_ENDPOINT,
} from "../modules/oauth/metadata.js";
import { requestIdFor } from "./request-context.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * OAuth endpoints that any client may call by specification. They carry no
 * cookie — the token endpoint is proved by a PKCE verifier or a refresh token,
 * and registration is unauthenticated and reachable directly anyway — so the
 * cross-site rule protects nothing here and would only turn a connector that
 * happens to send an `Origin` into an unexplainable 403. The consent endpoint
 * is NOT exempt: that one runs on the user's session.
 */
const PUBLIC_OAUTH_ENDPOINTS = new Set([
  OAUTH_TOKEN_ENDPOINT,
  OAUTH_REGISTER_ENDPOINT,
]);

export function requireSameOrigin(
  configuredOrigins: readonly string[],
): RequestHandler {
  const allowedOrigins = new Set(configuredOrigins.map(normalizeOrigin));

  return (request, response, next) => {
    // Lowercased because Express routes case-insensitively: /API/... reaches
    // the same handler and must face the same gate.
    const path = request.path.toLowerCase();
    if (
      SAFE_METHODS.has(request.method.toUpperCase()) ||
      !path.startsWith("/api/") ||
      PUBLIC_OAUTH_ENDPOINTS.has(path)
    ) {
      next();
      return;
    }

    const suppliedOrigin = request.get("origin");
    if (!suppliedOrigin) {
      // Non-browser API clients commonly omit Origin. Browsers send either
      // Origin or Sec-Fetch-Site for unsafe cross-origin requests.
      const fetchSite = request.get("sec-fetch-site")?.toLowerCase();
      if (!fetchSite || fetchSite === "same-origin" || fetchSite === "none") {
        next();
        return;
      }
      reject(request, response);
      return;
    }

    let origin: string;
    try {
      origin = new URL(suppliedOrigin).origin;
    } catch {
      reject(request, response);
      return;
    }
    if (origin === "null" || !allowedOrigins.has(origin)) {
      reject(request, response);
      return;
    }
    next();
  };
}

function normalizeOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(
      `Trusted browser origin must use HTTP or HTTPS: ${value}`,
    );
  }
  if (parsed.origin === "null" || parsed.username || parsed.password) {
    throw new TypeError(`Invalid trusted browser origin: ${value}`);
  }
  return parsed.origin;
}

function reject(
  request: Parameters<RequestHandler>[0],
  response: Parameters<RequestHandler>[1],
) {
  const requestId = requestIdFor(request, response);
  response.status(403).type("application/problem+json").json({
    code: "ORIGIN_NOT_ALLOWED",
    status: 403,
    title: "Request origin is not trusted",
    requestId,
  });
}
