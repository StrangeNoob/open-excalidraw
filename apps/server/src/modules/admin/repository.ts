import type {
  AdminOverview,
  AdminUser,
  AdminUserList,
} from "@open-excalidraw/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { AdminDomainError } from "./errors.js";
import type { AdminRepository, PurgeDrawing } from "./types.js";

interface OverviewRow extends QueryResultRow {
  users: string;
  drawings: string;
  storage_bytes: string;
}

interface UserRow extends QueryResultRow {
  id: string;
  name: string;
  email: string;
  email_verified: boolean;
  created_at: Date;
  disabled_at: Date | null;
  drawing_count: string;
  total: string;
}

export class PostgresAdminRepository implements AdminRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly purgeDrawing: PurgeDrawing,
  ) {}

  public async overview(): Promise<AdminOverview> {
    const result = await this.pool.query<OverviewRow>(
      `SELECT
         (SELECT count(*) FROM "user") AS users,
         (SELECT count(*) FROM drawings WHERE deleted_at IS NULL) AS drawings,
         (SELECT coalesce(sum(byte_size), 0)
            FROM drawing_assets WHERE deleted_at IS NULL) AS storage_bytes`,
    );
    const row = result.rows[0];
    return {
      users: Number(row?.users ?? 0),
      drawings: Number(row?.drawings ?? 0),
      // ponytail: Number() caps at 2^53 bytes (~9 PB); fine for one instance.
      storageBytes: Number(row?.storage_bytes ?? 0),
    };
  }

  public async listUsers(input: {
    search?: string;
    limit: number;
  }): Promise<AdminUserList> {
    // Escape LIKE metacharacters so a searched %, _, or \ matches literally
    // (backslash is Postgres's default LIKE escape character).
    const search =
      input.search != null ? input.search.replace(/[\\%_]/g, "\\$&") : null;
    const result = await this.pool.query<UserRow>(
      `SELECT
         u.id, u.name, u.email, u.email_verified, u.created_at, u.disabled_at,
         (SELECT count(*) FROM drawings d
            WHERE d.owner_user_id = u.id AND d.deleted_at IS NULL)
           AS drawing_count,
         count(*) OVER () AS total
       FROM "user" u
       WHERE $1::text IS NULL
          OR u.email ILIKE '%' || $1 || '%'
          OR u.name ILIKE '%' || $1 || '%'
       ORDER BY u.created_at ASC, u.id ASC
       LIMIT $2`,
      [search, input.limit],
    );
    return {
      users: result.rows.map(toAdminUser),
      total: result.rows[0] ? Number(result.rows[0].total) : 0,
    };
  }

  public async userExists(userId: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM "user" WHERE id = $1`, [
      userId,
    ]);
    return result.rowCount === 1;
  }

  public async disableUser(input: {
    actorUserId: string;
    targetUserId: string;
    requestId: string;
  }): Promise<void> {
    await this.transaction(async (client) => {
      // COALESCE keeps the first-disable timestamp, so repeat calls are no-ops.
      const updated = await client.query(
        `UPDATE "user" SET disabled_at = COALESCE(disabled_at, now())
         WHERE id = $1`,
        [input.targetUserId],
      );
      // The row may have vanished after the service's existence check; a 0-row
      // mutation must not leave a phantom audit event behind.
      if (updated.rowCount === 0) {
        throw new AdminDomainError("USER_NOT_FOUND", 404, "User not found");
      }
      await client.query(`DELETE FROM "session" WHERE user_id = $1`, [
        input.targetUserId,
      ]);
      await insertAdminAudit(client, "admin.user_disabled", input);
    });
  }

  public async enableUser(input: {
    actorUserId: string;
    targetUserId: string;
    requestId: string;
  }): Promise<void> {
    await this.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE "user" SET disabled_at = NULL WHERE id = $1`,
        [input.targetUserId],
      );
      if (updated.rowCount === 0) {
        throw new AdminDomainError("USER_NOT_FOUND", 404, "User not found");
      }
      await insertAdminAudit(client, "admin.user_enabled", input);
    });
  }

  public async purgeOwnedDrawings(input: {
    ownerUserId: string;
    requestId: string;
  }): Promise<void> {
    // The owner purge guard requires deleted_at IS NOT NULL, so soft-delete
    // any still-active owned drawings before purging every one of them.
    await this.pool.query(
      `UPDATE drawings SET deleted_at = now(), updated_at = now()
       WHERE owner_user_id = $1 AND deleted_at IS NULL`,
      [input.ownerUserId],
    );
    const owned = await this.pool.query<{ id: string }>(
      `SELECT id FROM drawings WHERE owner_user_id = $1`,
      [input.ownerUserId],
    );
    for (const { id } of owned.rows) {
      await this.purgeDrawing({
        drawingId: id,
        ownerUserId: input.ownerUserId,
        auditRequestId: input.requestId,
      });
    }
  }

  public async deleteUser(input: {
    actorUserId: string;
    targetUserId: string;
    requestId: string;
  }): Promise<void> {
    await this.transaction(async (client) => {
      // Cascades sessions/accounts; the migration-0011 SET NULL FKs null out
      // content the target authored in other users' drawings.
      const deleted = await client.query(`DELETE FROM "user" WHERE id = $1`, [
        input.targetUserId,
      ]);
      if (deleted.rowCount === 0) {
        throw new AdminDomainError("USER_NOT_FOUND", 404, "User not found");
      }
      await insertAdminAudit(client, "admin.user_deleted", input);
    });
  }

  private async transaction(
    operation: (client: PoolClient) => Promise<void>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await operation(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function toAdminUser(row: UserRow): AdminUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.email_verified,
    createdAt: row.created_at.toISOString(),
    disabledAt: row.disabled_at ? row.disabled_at.toISOString() : null,
    drawingCount: Number(row.drawing_count),
  };
}

// The actor still exists (an admin acting on another user), so it carries the
// FK column; the target lives in metadata since its row may be deleted.
async function insertAdminAudit(
  client: Pick<PoolClient, "query">,
  eventType: string,
  input: { actorUserId: string; targetUserId: string; requestId: string },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (actor_user_id, drawing_id, event_type, request_id, metadata)
     VALUES ($1, NULL, $2, $3, $4::jsonb)`,
    [
      input.actorUserId,
      eventType,
      input.requestId,
      JSON.stringify({ targetUserId: input.targetUserId }),
    ],
  );
}
