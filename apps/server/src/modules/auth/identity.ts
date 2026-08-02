import {
  PERSONAL_ACCESS_TOKEN_PREFIX,
  type TokenScope,
} from "@open-excalidraw/contracts";
import { fromNodeHeaders } from "better-auth/node";
import type { IncomingHttpHeaders } from "node:http";

import type { OpenExcalidrawAuth } from "./config.js";

export interface RequestIdentity {
  userId: string;
  email: string;
  name: string;
  image: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  createdAt: Date;
  /**
   * How the caller authenticated. "token" identities come from a personal
   * access token and carry no session; they are barred from managing tokens and
   * from realtime collaboration.
   */
  authKind: "session" | "token";
  /**
   * What the presented token may do. Present only for `authKind: "token"`;
   * a session identity is never scope-limited.
   */
  tokenScope?: TokenScope;
  /** Present only for `authKind: "session"`. */
  sessionId?: string;
  /** Present only for `authKind: "session"`. */
  sessionExpiresAt?: Date;
}

/** A session-authenticated identity, narrowed so session fields are present. */
export type SessionIdentity = RequestIdentity & {
  authKind: "session";
  sessionId: string;
  sessionExpiresAt: Date;
};

export interface IdentityService {
  resolve(
    headers: IncomingHttpHeaders | Headers,
  ): Promise<RequestIdentity | null>;
}

/**
 * Resolves a full personal access token secret to its owner's identity, or null
 * when the token is unknown, expired, revoked, or the owner is disabled.
 */
export interface TokenIdentityResolver {
  resolve(secret: string): Promise<RequestIdentity | null>;
}

// Any bearer credential resolves through the token path: `oepat_` values are
// personal access tokens, everything else is offered to the OAuth resolver.
// A non-bearer Authorization value still falls through to session resolution.
const BEARER_SCHEME = /^Bearer +(.+)$/i;

/**
 * The secret from an `Authorization: Bearer` header, or null for anything else.
 * RFC 7235 makes the scheme case-insensitive, so `bearer` and `BEARER` are the
 * same credential — shared with the scope gate so a request cannot be a token
 * to one and a stranger to the other.
 */
export function bearerSecret(
  authorization: string | null | undefined,
): string | null {
  return BEARER_SCHEME.exec(authorization ?? "")?.[1]?.trim() || null;
}

/**
 * Routes a presented bearer secret to the resolver that owns it. Composed once
 * and shared by the identity seam and the scope gate so both agree on which
 * credential a request carries.
 */
export function createBearerResolver(input: {
  personalAccessTokens: TokenIdentityResolver;
  oauthAccessTokens: TokenIdentityResolver;
}): TokenIdentityResolver {
  return {
    resolve(secret) {
      return secret.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX)
        ? input.personalAccessTokens.resolve(secret)
        : input.oauthAccessTokens.resolve(secret);
    },
  };
}

/**
 * An identity is an instance admin only when its email is on the allowlist AND
 * verified. Registration does not require verification, so an unverified match
 * could be an attacker who signed up under a configured-but-unregistered admin
 * email; requiring verification proves mailbox ownership (OAuth/OIDC sign-ins
 * carry emailVerified from the provider).
 */
export function isInstanceAdmin(
  identity: RequestIdentity,
  adminEmails: ReadonlySet<string>,
): boolean {
  return (
    identity.emailVerified && adminEmails.has(identity.email.toLowerCase())
  );
}

export function createIdentityService(
  auth: OpenExcalidrawAuth,
  tokenResolver: TokenIdentityResolver,
): IdentityService {
  return {
    async resolve(headers) {
      const webHeaders =
        headers instanceof Headers ? headers : fromNodeHeaders(headers);

      // An explicit bearer token attempt resolves through the token path only.
      // On failure it returns null WITHOUT falling back to the session cookie,
      // so a leaked/expired token can never ride a valid session alongside it.
      const secret = bearerSecret(webHeaders.get("authorization"));
      if (secret) {
        return tokenResolver.resolve(secret);
      }

      const result = await auth.api.getSession({ headers: webHeaders });
      if (!result) {
        return null;
      }

      return {
        userId: result.user.id,
        email: result.user.email,
        name: result.user.name,
        image: result.user.image ?? null,
        emailVerified: result.user.emailVerified,
        // The twoFactor plugin adds this field through the adapter; the
        // widened BetterAuthOptions return type erases it from getSession's
        // inferred user, so read it defensively like the session hook reads
        // disabledAt.
        twoFactorEnabled: Boolean(
          (result.user as { twoFactorEnabled?: boolean }).twoFactorEnabled,
        ),
        createdAt: result.user.createdAt,
        authKind: "session",
        sessionId: result.session.id,
        sessionExpiresAt: result.session.expiresAt,
      };
    },
  };
}
