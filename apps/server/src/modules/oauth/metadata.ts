import type { TokenScope } from "@open-excalidraw/contracts";

/** The MCP endpoint, which is the OAuth protected resource. */
export const MCP_RESOURCE_PATH = "/api/mcp";
/** Web route that resumes an authorize request after the app's login flow. */
export const OAUTH_LOGIN_PATH = "/oauth/authorize";
/** Web route that renders the consent screen. */
export const OAUTH_CONSENT_PATH = "/oauth/consent";
/** Better Auth's authorization endpoint for the MCP plugin. */
export const OAUTH_AUTHORIZE_ENDPOINT = "/api/auth/mcp/authorize";
/** Better Auth's token endpoint for the MCP plugin. */
export const OAUTH_TOKEN_ENDPOINT = "/api/auth/mcp/token";
/** Better Auth's dynamic client registration endpoint. */
export const OAUTH_REGISTER_ENDPOINT = "/api/auth/mcp/register";

const PROTECTED_RESOURCE_WELL_KNOWN = "/.well-known/oauth-protected-resource";

/**
 * The only scopes a connector may be granted. `full` is deliberately absent:
 * an OAuth grant must never reach `/api/v1/admin` or token management.
 */
export const OAUTH_SCOPES = ["read", "write"] as const;

/** Scopes the plugin defines itself; they carry no product permission. */
const OIDC_SCOPES = ["openid", "profile", "email", "offline_access"];

export function mcpResourceUrl(baseUrl: string): string {
  return new URL(MCP_RESOURCE_PATH, baseUrl).toString();
}

/**
 * RFC 9728 locates the document by inserting the resource's path into the
 * well-known path, so a resource at `/api/mcp` is described at
 * `/.well-known/oauth-protected-resource/api/mcp`. Clients fall back to the
 * root document; the router serves both.
 */
export function resourceMetadataUrl(baseUrl: string): string {
  return new URL(
    `${PROTECTED_RESOURCE_WELL_KNOWN}${MCP_RESOURCE_PATH}`,
    baseUrl,
  ).toString();
}

/**
 * The RFC 6750 challenge that makes a client start the flow. `scope` names what
 * the resource wants rather than everything the server can issue; per the MCP
 * spec `offline_access` stays out of it because it is not a resource
 * requirement.
 */
export function bearerChallenge(baseUrl: string): string {
  return `Bearer resource_metadata="${resourceMetadataUrl(baseUrl)}", scope="${OAUTH_SCOPES.join(" ")}"`;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
}

export function protectedResourceMetadata(
  baseUrl: string,
): ProtectedResourceMetadata {
  return {
    resource: mcpResourceUrl(baseUrl),
    // The same deployment is both resource and authorization server; a client
    // must be able to build the RFC 8414 well-known URL from this value.
    authorization_servers: [authorizationServerMetadata(baseUrl).issuer],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
  };
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  response_modes_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
}

/**
 * RFC 8414 metadata for the endpoints Better Auth's MCP plugin mounts. It is
 * written out here rather than proxied from the plugin because the plugin's own
 * document advertises a `/mcp/userinfo` and a `/mcp/jwks` it never registers —
 * our tokens are opaque, so there is no JWKS to publish. A test compares the
 * endpoints below against the plugin's document so an upstream route rename
 * cannot pass unnoticed.
 */
export function authorizationServerMetadata(
  baseUrl: string,
): AuthorizationServerMetadata {
  const endpoint = (path: string) => new URL(path, baseUrl).toString();
  return {
    issuer: new URL(baseUrl).origin,
    authorization_endpoint: endpoint(OAUTH_AUTHORIZE_ENDPOINT),
    token_endpoint: endpoint(OAUTH_TOKEN_ENDPOINT),
    registration_endpoint: endpoint(OAUTH_REGISTER_ENDPOINT),
    scopes_supported: [...OIDC_SCOPES, ...OAUTH_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
      "none",
    ],
    code_challenge_methods_supported: ["S256"],
  };
}

/**
 * The product scope an issued grant carries. Requests that name neither scope
 * fall back to the plugin's `defaultScope`, which already contains one, so this
 * only decides between the two.
 */
export function grantedScope(scopes: string): TokenScope {
  return scopes.split(" ").includes("write") ? "write" : "read";
}

/**
 * Forces every authorization request through the consent screen and pins the
 * product scope to exactly one of read/write.
 *
 * Without `prompt=consent` the plugin hands a code straight back to the
 * client's redirect URI, so any site could navigate a signed-in user's browser
 * to the authorize endpoint and collect a code for a client it registered.
 *
 * Returns true when it changed something and the caller must redirect.
 */
export function normalizeAuthorizeQuery(query: URLSearchParams): boolean {
  const requested = (query.get("scope") ?? "").split(" ").filter(Boolean);
  const product = requested.includes("write")
    ? "write"
    : requested.includes("read")
      ? "read"
      : null;
  const scope = [
    ...requested.filter((value) => OIDC_SCOPES.includes(value)),
    // A connector that names no product scope is asking to draw; the consent
    // screen says so in words before anything is granted.
    product ?? "write",
  ];
  if (!scope.includes("openid")) {
    scope.unshift("openid");
  }
  const normalized = scope.join(" ");

  if (query.get("prompt") === "consent" && query.get("scope") === normalized) {
    return false;
  }
  query.set("prompt", "consent");
  query.set("scope", normalized);
  return true;
}

const MAX_REDIRECT_URIS = 5;
const MAX_CLIENT_NAME_LENGTH = 80;

/**
 * What a dynamic registration may ask for. Anyone on the internet can call the
 * registration endpoint, so a redirect URI must be an exact HTTPS URL (loopback
 * excepted for local development) and the client must name itself, because the
 * consent screen shows that name to the user.
 *
 * Returns an error description, or null when the body may be registered.
 */
export function clientRegistrationError(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return "A JSON registration body is required";
  }
  const {
    redirect_uris: redirectUris,
    client_name: clientName,
    grant_types: grantTypes,
    response_types: responseTypes,
  } = body as Record<string, unknown>;

  if (typeof clientName !== "string" || !clientName.trim()) {
    return "client_name is required";
  }
  // Registration is open to the internet and this name is what the consent
  // screen shows, so cap it rather than let it push the rest off the page.
  if (clientName.length > MAX_CLIENT_NAME_LENGTH) {
    return `client_name must be at most ${MAX_CLIENT_NAME_LENGTH} characters`;
  }
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return "redirect_uris is required";
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    return `At most ${MAX_REDIRECT_URIS} redirect_uris may be registered`;
  }
  for (const candidate of redirectUris) {
    const error = redirectUriError(candidate);
    if (error) {
      return error;
    }
  }
  // Only the authorization code flow is served; the implicit flow would put a
  // token in a URL fragment, which OAuth 2.1 removed. A present-but-not-array
  // value is refused rather than skipped, or `grant_types: "implicit"` would
  // sail past this check into the plugin.
  if (grantTypes !== undefined && !Array.isArray(grantTypes)) {
    return "grant_types must be an array";
  }
  if (
    Array.isArray(grantTypes) &&
    !grantTypes.every(
      (value) => value === "authorization_code" || value === "refresh_token",
    )
  ) {
    return "Only the authorization_code and refresh_token grant types are supported";
  }
  if (responseTypes !== undefined && !Array.isArray(responseTypes)) {
    return "response_types must be an array";
  }
  if (
    Array.isArray(responseTypes) &&
    !responseTypes.every((v) => v === "code")
  ) {
    return "Only the code response type is supported";
  }
  return null;
}

function redirectUriError(candidate: unknown): string | null {
  if (typeof candidate !== "string") {
    return "Each redirect_uri must be a string";
  }
  // Wildcards never match: the plugin compares redirect URIs literally, so a
  // pattern would either be dead or, if a client sent it back verbatim, an
  // open redirect. Reject them outright rather than silently accept.
  if (candidate.includes("*")) {
    return "redirect_uris must not contain wildcards";
  }
  // The plugin stores the array comma-joined and splits it again at authorize
  // time, so a comma inside one entry smuggles a second, unvalidated URI past
  // every check below.
  if (candidate.includes(",")) {
    return "redirect_uris must not contain a comma";
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return "Each redirect_uri must be an absolute URL";
  }
  if (url.hash) {
    return "redirect_uris must not contain a fragment";
  }
  if (url.protocol === "https:") {
    return null;
  }
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) {
    return null;
  }
  return "redirect_uris must use HTTPS (except http on localhost)";
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}
