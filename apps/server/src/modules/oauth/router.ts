import { Router, type RequestHandler } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

import { requestIdFor } from "../../http/request-context.js";

import type { IdentityService } from "../auth/identity.js";
import type { OauthClientLookup } from "./repository.js";
import {
  authorizationServerMetadata,
  clientRegistrationError,
  MCP_RESOURCE_PATH,
  normalizeAuthorizeQuery,
  OAUTH_AUTHORIZE_ENDPOINT,
  OAUTH_LOGIN_PATH,
  OAUTH_REGISTER_ENDPOINT,
  OAUTH_TOKEN_ENDPOINT,
  protectedResourceMetadata,
} from "./metadata.js";

export interface CreateOauthRouterInput {
  identity: IdentityService;
  /** Public base URL of this deployment; also the OAuth issuer. */
  publicBaseUrl: string;
  findClient: OauthClientLookup;
}

const PROTECTED_RESOURCE_WELL_KNOWN = "/.well-known/oauth-protected-resource";

/**
 * The OAuth seams Better Auth's MCP plugin does not cover: discovery at the
 * well-known paths clients probe, a guard on dynamic client registration, and
 * an authorize entry point that forces consent and keeps the plugin from ever
 * seeing a signed-out request.
 */
export function createOauthRouter(input: CreateOauthRouterInput): Router {
  const router = Router();

  // Public, cacheable documents: an MCP client fetches them before it can
  // authenticate at all, and a browser-based client needs them cross-origin.
  const discovery =
    (body: () => unknown): RequestHandler =>
    (_request, response) => {
      response
        .set("access-control-allow-origin", "*")
        .set("cross-origin-resource-policy", "cross-origin")
        .set("cache-control", "public, max-age=300")
        .json(body());
    };

  router.get(
    [
      // RFC 9728 path insertion for the resource at /api/mcp, plus the root
      // document clients fall back to.
      `${PROTECTED_RESOURCE_WELL_KNOWN}${MCP_RESOURCE_PATH}`,
      PROTECTED_RESOURCE_WELL_KNOWN,
    ],
    discovery(() => protectedResourceMetadata(input.publicBaseUrl)),
  );
  router.get(
    // Clients must support both suffixes; the issuer has no path component, so
    // both documents live at the root.
    [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ],
    discovery(() => authorizationServerMetadata(input.publicBaseUrl)),
  );

  // Registration is unauthenticated by design (a connector registers before any
  // user is involved), so it gets its own per-address budget on top of Better
  // Auth's limiter to bound how many client rows one caller can create.
  const registrationLimiter = rateLimit({
    windowMs: 60 * 60 * 1_000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (request) => {
      const realIp = request.headers["x-real-ip"];
      return ipKeyGenerator(
        typeof realIp === "string" ? realIp : (request.ip ?? ""),
      );
    },
  });

  // RFC 6749 requires the token response to be uncacheable. The plugin asks
  // for the header on its endpoint's router response, which does not survive
  // to the wire, so it is set here where nothing can drop it.
  router.post(OAUTH_TOKEN_ENDPOINT, (_request, response, next) => {
    response.set("cache-control", "no-store");
    next();
  });

  router.post(
    OAUTH_REGISTER_ENDPOINT,
    registrationLimiter,
    (request, response, next) => {
      const error = clientRegistrationError(request.body);
      if (!error) {
        next();
        return;
      }
      // RFC 7591's error shape rather than this API's problem+json: the caller
      // is an OAuth client, not a browser talking to /api/v1.
      response.status(400).json({
        error: "invalid_client_metadata",
        error_description: error,
      });
    },
  );

  // The consent screen names the client asking for access, and only a
  // signed-in browser may ask: client ids are not secret, but nothing else
  // needs to enumerate them.
  router.get("/api/v1/oauth/clients/:clientId", (request, response, next) => {
    const requestId = requestIdFor(request, response);
    void input.identity
      .resolve(request.headers)
      .then(async (identity) => {
        if (identity?.authKind !== "session") {
          response.status(401).type("application/problem+json").json({
            code: "AUTHENTICATION_REQUIRED",
            status: 401,
            title: "Authentication is required",
            requestId,
          });
          return;
        }
        const client = await input.findClient(request.params.clientId);
        if (!client) {
          response.status(404).type("application/problem+json").json({
            code: "OAUTH_CLIENT_NOT_FOUND",
            status: 404,
            title: "No such OAuth client",
            requestId,
          });
          return;
        }
        response.set("cache-control", "no-store").json(client);
      })
      .catch(next);
  });

  router.get(OAUTH_AUTHORIZE_ENDPOINT, (request, response, next) => {
    const query = new URL(request.originalUrl, input.publicBaseUrl)
      .searchParams;
    if (normalizeAuthorizeQuery(query)) {
      response.redirect(302, `${OAUTH_AUTHORIZE_ENDPOINT}?${query.toString()}`);
      return;
    }

    void input.identity
      .resolve(request.headers)
      .then((identity) => {
        // Only a browser session counts as signed in here: a bearer token has
        // no session for the plugin to resume, so it would land in exactly the
        // path this guard exists to avoid.
        if (identity?.authKind === "session") {
          next();
          return;
        }
        // Sending a signed-out caller through the app's own login flow keeps
        // the plugin from stashing its resume-after-login cookie, whose hook
        // would turn the SPA's sign-in fetch into a redirect it cannot follow.
        const returnTo = `${OAUTH_LOGIN_PATH}?${query.toString()}`;
        response.redirect(
          302,
          `/login?returnTo=${encodeURIComponent(returnTo)}`,
        );
      })
      .catch(next);
  });

  return router;
}
