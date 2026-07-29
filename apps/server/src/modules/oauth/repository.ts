import type { Pool } from "pg";

import type {
  RequestIdentity,
  TokenIdentityResolver,
} from "../auth/identity.js";
import { hashAuthToken } from "../auth/token-adapter.js";
import { grantedScope } from "./metadata.js";

/** What the consent screen needs to describe the client asking for access. */
export interface OauthClientSummary {
  name: string;
  icon: string | null;
  /** Hosts the grant can be sent to — the part the server actually verified. */
  redirectOrigins: string[];
}

export type OauthClientLookup = (
  clientId: string,
) => Promise<OauthClientSummary | null>;

export function createOauthClientLookup(pool: Pool): OauthClientLookup {
  return async (clientId) => {
    const result = await pool.query<{
      name: string;
      icon: string | null;
      redirect_urls: string;
    }>(
      `SELECT name, icon, redirect_urls FROM oauth_application
       WHERE client_id = $1 AND disabled = false
       LIMIT 1`,
      [clientId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      name: row.name,
      icon: row.icon,
      // The name is whatever the client called itself; the destination is what
      // the server actually verified, so the consent screen shows both.
      redirectOrigins: [
        ...new Set(
          row.redirect_urls
            .split(",")
            .map((url) => {
              try {
                return new URL(url).host;
              } catch {
                return null;
              }
            })
            .filter((host): host is string => host !== null),
        ),
      ],
    };
  };
}

/**
 * Resolves an OAuth bearer access token to its owner. Tokens are stored as the
 * same `sha256:` digest the auth adapter writes, so the presented value is
 * hashed the same way before the lookup — the plaintext never appears in a
 * query or a log.
 *
 * Expired tokens and disabled owners resolve to null, which the callers turn
 * into a 401 exactly as they do for an unknown personal access token.
 */
export class PostgresOauthTokenResolver implements TokenIdentityResolver {
  public constructor(private readonly pool: Pool) {}

  public async resolve(accessToken: string): Promise<RequestIdentity | null> {
    const result = await this.pool.query<{
      user_id: string;
      scopes: string;
      email: string;
      name: string;
      image: string | null;
      email_verified: boolean;
      two_factor_enabled: boolean;
      created_at: Date;
    }>(
      `SELECT u.id AS user_id, t.scopes, u.email, u.name, u.image,
              u.email_verified, u.two_factor_enabled, u.created_at
       FROM oauth_access_token t
       JOIN "user" u ON u.id = t.user_id
       WHERE t.access_token = $1
         AND t.access_token_expires_at > now()
         AND u.disabled_at IS NULL
       LIMIT 1`,
      [hashAuthToken(accessToken)],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      userId: row.user_id,
      email: row.email,
      name: row.name,
      image: row.image,
      emailVerified: row.email_verified,
      twoFactorEnabled: row.two_factor_enabled,
      createdAt: row.created_at,
      // A connector is a bearer credential without a session, like a personal
      // access token: barred from token management and realtime collaboration,
      // and limited to the scope it was granted.
      authKind: "token",
      tokenScope: grantedScope(row.scopes),
    };
  }
}
