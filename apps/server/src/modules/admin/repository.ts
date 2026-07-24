import type {
  AdminOverview,
  AdminUser,
  AdminUserList,
} from "@open-excalidraw/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { AdminDomainError } from "./errors.js";
import type {
  AdminRepository,
  AdminStorageSettings,
  PurgeDrawing,
} from "./types.js";

// Shared user projection: identity columns plus the two owner-scoped
// aggregates (active drawing count and active asset bytes across every drawing
// the user owns, trashed drawings included) and the per-user quota override.
const ADMIN_USER_COLUMNS = `
  u.id, u.name, u.email, u.email_verified, u.created_at, u.disabled_at,
  u.two_factor_enabled, u.storage_quota_bytes,
  (SELECT count(*) FROM drawings d
     WHERE d.owner_user_id = u.id AND d.deleted_at IS NULL)
    AS drawing_count,
  (SELECT coalesce(sum(a.byte_size), 0)
     FROM drawing_assets a
     JOIN drawings d2 ON d2.id = a.drawing_id
     WHERE d2.owner_user_id = u.id AND a.deleted_at IS NULL)
    AS storage_bytes`;

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
  two_factor_enabled: boolean;
  storage_quota_bytes: string | null;
  drawing_count: string;
  storage_bytes: string;
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
    const result = await this.pool.query<UserRow & { total: string }>(
      `SELECT ${ADMIN_USER_COLUMNS},
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

  public async getSettings(): Promise<AdminStorageSettings> {
    const result = await this.pool.query<{
      storage_quota_per_user_bytes: string | null;
    }>(`SELECT storage_quota_per_user_bytes FROM app_settings WHERE id = true`);
    return {
      storageQuotaPerUserBytes: numericOrNull(
        result.rows[0]?.storage_quota_per_user_bytes ?? null,
      ),
    };
  }

  public async updateSettings(input: {
    actorUserId: string;
    requestId: string;
    storageQuotaPerUserBytes: number | null;
  }): Promise<AdminStorageSettings> {
    return this.transaction(async (client) => {
      const before = await client.query<{
        storage_quota_per_user_bytes: string | null;
      }>(
        `SELECT storage_quota_per_user_bytes FROM app_settings
         WHERE id = true FOR UPDATE`,
      );
      const beforeValue = numericOrNull(
        before.rows[0]?.storage_quota_per_user_bytes ?? null,
      );
      // Upsert so a missing settings row (should not happen; the migration seeds
      // it) still writes rather than silently updating zero rows.
      const updated = await client.query<{
        storage_quota_per_user_bytes: string | null;
      }>(
        `INSERT INTO app_settings (id, storage_quota_per_user_bytes, updated_at)
         VALUES (true, $1, now())
         ON CONFLICT (id) DO UPDATE
           SET storage_quota_per_user_bytes = EXCLUDED.storage_quota_per_user_bytes,
               updated_at = now()
         RETURNING storage_quota_per_user_bytes`,
        [input.storageQuotaPerUserBytes],
      );
      const afterValue = numericOrNull(
        updated.rows[0]?.storage_quota_per_user_bytes ?? null,
      );
      await insertAdminAudit(client, "admin.settings.updated", {
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        metadata: {
          storageQuotaPerUserBytes: { before: beforeValue, after: afterValue },
        },
      });
      return { storageQuotaPerUserBytes: afterValue };
    });
  }

  public async setUserQuota(input: {
    actorUserId: string;
    targetUserId: string;
    requestId: string;
    storageQuotaBytes: number | null;
  }): Promise<AdminUser> {
    return this.transaction(async (client) => {
      const before = await client.query<{ storage_quota_bytes: string | null }>(
        `SELECT storage_quota_bytes FROM "user" WHERE id = $1 FOR UPDATE`,
        [input.targetUserId],
      );
      if (before.rowCount === 0) {
        throw new AdminDomainError("USER_NOT_FOUND", 404, "User not found");
      }
      const beforeValue = numericOrNull(
        before.rows[0]?.storage_quota_bytes ?? null,
      );
      await client.query(
        `UPDATE "user" SET storage_quota_bytes = $2 WHERE id = $1`,
        [input.targetUserId, input.storageQuotaBytes],
      );
      await insertAdminAudit(client, "admin.user.quota_updated", {
        actorUserId: input.actorUserId,
        targetUserId: input.targetUserId,
        requestId: input.requestId,
        metadata: {
          storageQuotaBytes: {
            before: beforeValue,
            after: input.storageQuotaBytes,
          },
        },
      });
      const row = await client.query<UserRow>(
        `SELECT ${ADMIN_USER_COLUMNS} FROM "user" u WHERE u.id = $1`,
        [input.targetUserId],
      );
      // The FOR UPDATE lock above guarantees the row still exists here.
      return toAdminUser(row.rows[0]!);
    });
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

  public async resetTwoFactor(input: {
    actorUserId: string;
    targetUserId: string;
    requestId: string;
  }): Promise<void> {
    await this.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE "user" SET two_factor_enabled = false WHERE id = $1`,
        [input.targetUserId],
      );
      if (updated.rowCount === 0) {
        throw new AdminDomainError("USER_NOT_FOUND", 404, "User not found");
      }
      // No enrollment => 0 rows deleted; the reset stays idempotent.
      await client.query(`DELETE FROM two_factor WHERE user_id = $1`, [
        input.targetUserId,
      ]);
      await insertAdminAudit(client, "admin.user_two_factor_reset", input);
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

function toAdminUser(row: UserRow): AdminUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.email_verified,
    createdAt: row.created_at.toISOString(),
    disabledAt: row.disabled_at ? row.disabled_at.toISOString() : null,
    twoFactorEnabled: row.two_factor_enabled,
    drawingCount: Number(row.drawing_count),
    // ponytail: Number() caps at 2^53 bytes (~9 PB) per user; fine for one instance.
    storageBytes: Number(row.storage_bytes),
    storageQuotaBytes: numericOrNull(row.storage_quota_bytes),
  };
}

// pg returns bigint columns as strings; NULL stays NULL (unlimited).
function numericOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

// The actor still exists (an admin acting on another user or the instance), so
// it carries the FK column; the target and any before/after values live in
// metadata since a target row may later be deleted.
async function insertAdminAudit(
  client: Pick<PoolClient, "query">,
  eventType: string,
  input: {
    actorUserId: string;
    requestId: string;
    targetUserId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (actor_user_id, drawing_id, event_type, request_id, metadata)
     VALUES ($1, NULL, $2, $3, $4::jsonb)`,
    [
      input.actorUserId,
      eventType,
      input.requestId,
      JSON.stringify({
        ...(input.targetUserId ? { targetUserId: input.targetUserId } : {}),
        ...(input.metadata ?? {}),
      }),
    ],
  );
}
