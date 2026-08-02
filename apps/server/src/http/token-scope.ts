import type { RequestHandler } from "express";

import type { TokenIdentityResolver } from "../modules/auth/identity.js";
import { requestIdFor } from "./request-context.js";

const BEARER_PREFIX = "Bearer ";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The single enforcement seam for bearer-token scopes, mounted ahead of the
 * routers. It speaks for any request that presents a bearer token — an `oepat_`
 * personal access token or an OAuth access token from a connector; anything
 * else (session cookie, no credentials, a foreign Authorization scheme) passes
 * through and the routes answer as they always have, including the 401 for an
 * invalid token.
 *
 * `/api/mcp` is deliberately not covered: it is POST-only JSON-RPC whatever the
 * tool does, so the method rule would say nothing useful there. The MCP layer
 * enforces the same scopes by only registering write tools a scope allows.
 */
export function enforceTokenScope(
  tokenResolver: TokenIdentityResolver,
): RequestHandler {
  return (request, response, next) => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith(BEARER_PREFIX)) {
      next();
      return;
    }
    // Express routes case-insensitively, so /API/V1/... reaches the same
    // handler and must face the same gate.
    const path = request.path.toLowerCase();
    // The bare path has no handler today; matching it anyway means adding one
    // later cannot quietly land outside the gate.
    const admin = path === "/api/v1/admin" || path.startsWith("/api/v1/admin/");
    const unsafe =
      path.startsWith("/api/v1/") && !SAFE_METHODS.has(request.method);
    if (!admin && !unsafe) {
      next();
      return;
    }

    // A second resolution of the same token: a SHA-256 and one indexed select,
    // cheaper than threading the identity through every router's own resolve.
    void tokenResolver
      .resolve(authorization.slice(BEARER_PREFIX.length))
      .then((identity) => {
        if (!identity) {
          next();
          return;
        }
        // A token minted before scopes existed keeps its old reach, exactly as
        // the repository reports it. An OAuth grant is only ever read or write,
        // so the admin branch always refuses it.
        const scope = identity.tokenScope ?? "full";
        if (admin ? scope === "full" : scope !== "read") {
          next();
          return;
        }
        const requestId = requestIdFor(request, response);
        response.setHeader("x-request-id", requestId);
        response.status(403).type("application/problem+json").json({
          code: "INSUFFICIENT_SCOPE",
          status: 403,
          title: "This token's scope does not allow this request",
          requestId,
        });
      })
      .catch(next);
  };
}
