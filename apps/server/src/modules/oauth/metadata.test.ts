import {
  authorizationServerMetadata,
  bearerChallenge,
  clientRegistrationError,
  grantedScope,
  normalizeAuthorizeQuery,
  protectedResourceMetadata,
  resourceMetadataUrl,
} from "./metadata.js";

const BASE_URL = "https://draw.example.test";

describe("discovery documents", () => {
  it("describes the MCP endpoint as the protected resource (RFC 9728)", () => {
    expect(protectedResourceMetadata(BASE_URL)).toEqual({
      resource: "https://draw.example.test/api/mcp",
      authorization_servers: ["https://draw.example.test"],
      // offline_access stays out: the MCP spec says a refresh token is not a
      // resource requirement, and `full` is not grantable over OAuth at all.
      scopes_supported: ["read", "write"],
      bearer_methods_supported: ["header"],
    });
  });

  it("advertises only the authorization server endpoints that exist", () => {
    const metadata = authorizationServerMetadata(BASE_URL);

    expect(metadata).toMatchObject({
      issuer: "https://draw.example.test",
      authorization_endpoint:
        "https://draw.example.test/api/auth/mcp/authorize",
      token_endpoint: "https://draw.example.test/api/auth/mcp/token",
      registration_endpoint: "https://draw.example.test/api/auth/mcp/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
    });
    // Tokens are opaque, so there is no JWKS and no userinfo to publish.
    expect(metadata).not.toHaveProperty("jwks_uri");
    expect(metadata).not.toHaveProperty("userinfo_endpoint");
    // A client validates that the issuer matches the URL it built.
    expect(metadata.issuer).toBe(
      protectedResourceMetadata(BASE_URL).authorization_servers[0],
    );
  });

  it("points the bearer challenge at the path-inserted metadata URL", () => {
    expect(resourceMetadataUrl(BASE_URL)).toBe(
      "https://draw.example.test/.well-known/oauth-protected-resource/api/mcp",
    );
    expect(bearerChallenge(BASE_URL)).toBe(
      `Bearer resource_metadata="${resourceMetadataUrl(BASE_URL)}", scope="read write"`,
    );
  });
});

describe("authorize query normalization", () => {
  const normalize = (search: string) => {
    const query = new URLSearchParams(search);
    const changed = normalizeAuthorizeQuery(query);
    return { changed, query };
  };

  it("forces every request through the consent screen", () => {
    const { changed, query } = normalize(
      "client_id=abc&response_type=code&scope=openid%20write",
    );

    expect(changed).toBe(true);
    expect(query.get("prompt")).toBe("consent");
    expect(query.get("client_id")).toBe("abc");
  });

  it("is idempotent so the redirect cannot loop", () => {
    const first = normalize("client_id=abc&scope=openid%20read");
    expect(normalizeAuthorizeQuery(first.query)).toBe(false);
  });

  it("keeps at most one product scope and defaults to write", () => {
    expect(normalize("client_id=a").query.get("scope")).toBe("openid write");
    expect(normalize("client_id=a&scope=read").query.get("scope")).toBe(
      "openid read",
    );
    // A request for both is a request to draw; the consent screen says so.
    expect(normalize("client_id=a&scope=read%20write").query.get("scope")).toBe(
      "openid write",
    );
  });

  it("drops scopes this server does not grant", () => {
    // `full` would be account-wide; admin is not a scope at all.
    const { query } = normalize(
      "client_id=a&scope=openid%20email%20full%20admin%20read",
    );

    expect(query.get("scope")).toBe("openid email read");
  });
});

describe("granted scope", () => {
  it("maps an issued grant onto the token scope model", () => {
    expect(grantedScope("openid offline_access write")).toBe("write");
    expect(grantedScope("openid read")).toBe("read");
    // Never `full`, whatever the grant claims to carry.
    expect(grantedScope("openid full")).toBe("read");
  });
});

describe("dynamic client registration guard", () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    client_name: "Claude",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    ...overrides,
  });

  it("accepts claude.ai's callback", () => {
    expect(clientRegistrationError(body())).toBeNull();
  });

  it("requires a name, because the consent screen shows it", () => {
    expect(clientRegistrationError(body({ client_name: " " }))).toContain(
      "client_name",
    );
  });

  it("refuses anything but exact HTTPS redirect URIs", () => {
    const refused = [
      ["http://evil.example/cb"],
      ["https://*.example.com/cb"],
      ["https://example.com/cb#frag"],
      ["not-a-url"],
      [],
    ];
    for (const redirectUris of refused) {
      expect(
        clientRegistrationError(body({ redirect_uris: redirectUris })),
      ).not.toBeNull();
    }
    // Loopback HTTP stays usable for local development.
    expect(
      clientRegistrationError(
        body({ redirect_uris: ["http://localhost:5173/callback"] }),
      ),
    ).toBeNull();
  });

  it("refuses a comma, which would smuggle a second redirect URI", () => {
    // The plugin stores these comma-joined and splits them again at authorize
    // time, so everything after a comma would never be validated.
    const smuggled = [
      "https://claude.ai/cb?x=1,http://evil.example/cb",
      "https://claude.ai/cb?x=1,javascript:alert(1)",
    ];
    for (const uri of smuggled) {
      expect(
        clientRegistrationError(body({ redirect_uris: [uri] })),
      ).not.toBeNull();
    }
  });

  it("caps the client name the consent screen has to show", () => {
    expect(
      clientRegistrationError(body({ client_name: "a".repeat(200) })),
    ).not.toBeNull();
  });

  it("refuses the implicit flow", () => {
    expect(
      clientRegistrationError(body({ grant_types: ["implicit"] })),
    ).not.toBeNull();
    expect(
      clientRegistrationError(body({ response_types: ["token"] })),
    ).not.toBeNull();
    expect(
      clientRegistrationError(
        body({
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      ),
    ).toBeNull();
  });

  it("caps how many redirect URIs one client may register", () => {
    expect(
      clientRegistrationError(
        body({
          redirect_uris: Array.from(
            { length: 6 },
            (_value, index) => `https://example.com/cb${index}`,
          ),
        }),
      ),
    ).not.toBeNull();
  });

  it("rejects a body that is not an object", () => {
    expect(clientRegistrationError(undefined)).not.toBeNull();
    expect(clientRegistrationError("redirect_uris=x")).not.toBeNull();
  });
});
