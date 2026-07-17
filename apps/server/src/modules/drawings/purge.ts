import type { Pool, PoolClient } from "pg";

import { thumbnailStorageKey } from "../assets/service.js";

/**
 * Guard deciding which trashed drawings a purge may touch: the maintenance
 * job's retention cutoff, or the owner of a user-initiated "delete forever".
 *
 * Callers run prepare → delete blobs → finalize. Prepare durably marks the
 * row with purge_started_at inside its transaction, which blocks restore and
 * hides the drawing from the trash before any blob is deleted — a restore
 * can never resurrect a drawing with partially deleted assets. A purge that
 * dies before finalize leaves the marker behind; the retention guard accepts
 * marked rows regardless of age, so the next maintenance run completes it.
 */
export type DrawingPurgeGuard =
  { deletedBefore: Date } | { ownerUserId: string };

const guardClause = (guard: DrawingPurgeGuard) =>
  "deletedBefore" in guard
    ? {
        sql: "(deleted_at < $2 OR purge_started_at IS NOT NULL)",
        param: guard.deletedBefore,
      }
    : {
        sql: "owner_user_id = $2 AND deleted_at IS NOT NULL",
        param: guard.ownerUserId,
      };

/**
 * Phase 1: mark the row as purge-in-progress and collect every blob key.
 * Null when the guard misses.
 */
export async function prepareDrawingPurge(
  pool: Pool,
  drawingId: string,
  guard: DrawingPurgeGuard,
): Promise<{ storageKeys: string[] } | null> {
  const clause = guardClause(guard);
  return transaction(pool, async (client) => {
    const locked = await client.query<{ id: string }>(
      `UPDATE drawings SET purge_started_at = now()
       WHERE id = $1 AND ${clause.sql}
       RETURNING id`,
      [drawingId, clause.param],
    );
    if (!locked.rows[0]) return null;

    const assets = await client.query<{ storage_key: string }>(
      `SELECT storage_key FROM drawing_assets
       WHERE drawing_id = $1
       ORDER BY id
       FOR UPDATE`,
      [drawingId],
    );
    return {
      // The dashboard thumbnail has no drawing_assets row; delete its
      // fixed key alongside the asset blobs (a missing key is a no-op).
      storageKeys: [
        ...assets.rows.map((asset) => asset.storage_key),
        thumbnailStorageKey(drawingId),
      ],
    };
  });
}

/**
 * Phase 3: hard-delete the row (children cascade). True when it deleted.
 * Accepts a client so a caller can finalize inside its own transaction
 * (e.g. atomically with an audit event).
 */
export async function finalizeDrawingPurge(
  db: Pick<Pool | PoolClient, "query">,
  drawingId: string,
  guard: DrawingPurgeGuard,
): Promise<boolean> {
  const clause = guardClause(guard);
  const removed = await db.query(
    `DELETE FROM drawings WHERE id = $1 AND ${clause.sql}`,
    [drawingId, clause.param],
  );
  return (removed.rowCount ?? 0) === 1;
}

async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
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
