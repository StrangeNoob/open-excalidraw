import type { PersonalAccessToken } from "@open-excalidraw/contracts";
import type { Pool, PoolClient } from "pg";

import { TokenDomainError } from "./errors.js";
import type { TokenOwner, TokenRepository } from "./types.js";

interface TokenRow {
  id: string;
  name: string;
  last_four: string;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
}

const TOKEN_COLUMNS = `id, name, last_four, created_at, expires_at, last_used_at`;

export class PostgresTokenRepository implements TokenRepository {
  public constructor(private readonly pool: Pool) {}

  public async insert(input: {
    userId: string;
    name: string;
    tokenHash: Buffer;
    lastFour: string;
    expiresInDays: number | null;
    requestId: string;
    maxTokens: number;
  }): Promise<PersonalAccessToken> {
    return this.transaction(async (client) => {
      // ponytail: lock the user row so a user's concurrent creates serialize and
      // cannot race past the cap; per-user token creation is rare (settings UI).
      await client.query(`SELECT 1 FROM "user" WHERE id = $1 FOR UPDATE`, [
        input.userId,
      ]);
      const count = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM personal_access_tokens WHERE user_id = $1`,
        [input.userId],
      );
      if (Number(count.rows[0]?.n ?? 0) >= input.maxTokens) {
        throw new TokenDomainError(
          "TOKEN_LIMIT_REACHED",
          400,
          `You can have at most ${input.maxTokens} personal access tokens`,
        );
      }
      const inserted = await client.query<TokenRow>(
        `INSERT INTO personal_access_tokens
           (user_id, name, token_hash, last_four, expires_at)
         VALUES (
           $1, $2, $3, $4,
           CASE WHEN $5::int IS NULL THEN NULL
                ELSE now() + ($5::int * interval '1 day') END
         )
         RETURNING ${TOKEN_COLUMNS}`,
        [
          input.userId,
          input.name,
          input.tokenHash,
          input.lastFour,
          input.expiresInDays,
        ],
      );
      const row = inserted.rows[0]!;
      await insertTokenAudit(client, "token.created", {
        userId: input.userId,
        requestId: input.requestId,
        tokenId: row.id,
        name: row.name,
      });
      return toToken(row);
    });
  }

  public async list(userId: string): Promise<PersonalAccessToken[]> {
    const result = await this.pool.query<TokenRow>(
      `SELECT ${TOKEN_COLUMNS} FROM personal_access_tokens
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC`,
      [userId],
    );
    return result.rows.map(toToken);
  }

  public async revoke(input: {
    userId: string;
    tokenId: string;
    requestId: string;
  }): Promise<boolean> {
    return this.transaction(async (client) => {
      const deleted = await client.query<{ id: string; name: string }>(
        `DELETE FROM personal_access_tokens
         WHERE id = $1 AND user_id = $2
         RETURNING id, name`,
        [input.tokenId, input.userId],
      );
      const row = deleted.rows[0];
      if (!row) {
        return false;
      }
      await insertTokenAudit(client, "token.revoked", {
        userId: input.userId,
        requestId: input.requestId,
        tokenId: row.id,
        name: row.name,
      });
      return true;
    });
  }

  public async resolveOwner(tokenHash: Buffer): Promise<TokenOwner | null> {
    const result = await this.pool.query<{
      user_id: string;
      email: string;
      name: string;
      image: string | null;
      email_verified: boolean;
      two_factor_enabled: boolean;
      created_at: Date;
    }>(
      `SELECT u.id AS user_id, u.email, u.name, u.image,
              u.email_verified, u.two_factor_enabled, u.created_at
       FROM personal_access_tokens t
       JOIN "user" u ON u.id = t.user_id
       WHERE t.token_hash = $1
         AND (t.expires_at IS NULL OR t.expires_at > now())
         AND u.disabled_at IS NULL
       LIMIT 1`,
      [tokenHash],
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
    };
  }

  public async touchLastUsed(tokenHash: Buffer): Promise<void> {
    await this.pool.query(
      `UPDATE personal_access_tokens
       SET last_used_at = now()
       WHERE token_hash = $1
         AND (last_used_at IS NULL OR last_used_at < now() - interval '1 hour')`,
      [tokenHash],
    );
  }

  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function toToken(row: TokenRow): PersonalAccessToken {
  return {
    id: row.id,
    name: row.name,
    lastFour: row.last_four,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
  };
}

// The secret and its hash are NEVER audited; only the token id and name go into
// metadata. actor_user_id is the token's owner; there is no associated drawing.
async function insertTokenAudit(
  client: Pick<PoolClient, "query">,
  eventType: "token.created" | "token.revoked",
  input: { userId: string; requestId: string; tokenId: string; name: string },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (actor_user_id, drawing_id, event_type, request_id, metadata)
     VALUES ($1, NULL, $2, $3, $4::jsonb)`,
    [
      input.userId,
      eventType,
      input.requestId,
      JSON.stringify({ tokenId: input.tokenId, name: input.name }),
    ],
  );
}
