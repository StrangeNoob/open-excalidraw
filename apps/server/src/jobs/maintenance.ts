import type { ObjectStorage } from "@open-excalidraw/storage";
import type { Pool, PoolClient } from "pg";

import { thumbnailStorageKey } from "../modules/assets/service.js";

export const DEFAULT_REVISION_RETENTION = 20;
export const DEFAULT_ASSET_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_DELETED_DRAWING_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const DEFAULT_MUTATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEFAULT_CANDIDATE_BATCH_SIZE = 500;

export interface MaintenanceJobOptions {
  now?: () => Date;
  revisionRetention?: number;
  assetRetentionMs?: number;
  deletedDrawingRetentionMs?: number;
  auditRetentionMs?: number;
  mutationRetentionMs?: number;
  candidateBatchSize?: number;
}

export interface MaintenanceFailure {
  id: string;
  errorType: string;
  stage:
    | "asset-tombstone"
    | "asset-delete"
    | "asset-finalize"
    | "drawing-delete"
    | "drawing-finalize";
}

export interface MaintenanceResult {
  revisionsPruned: number;
  orphanAssetsDeleted: number;
  expiredInvitationsDeleted: number;
  expiredSessionsDeleted: number;
  expiredVerificationsDeleted: number;
  auditEventsDeleted: number;
  mutationsDeleted: number;
  drawingsPurged: number;
  failures: MaintenanceFailure[];
}

interface AssetCandidate {
  id: string;
  drawing_id: string;
  storage_key: string;
  deleted_at: Date | null;
  storage_deleted_at: Date | null;
}

interface DrawingCandidate {
  id: string;
}

/**
 * PostgreSQL-backed retention jobs. An orphan asset is first made inaccessible
 * with a committed database tombstone. Object deletion happens only after that
 * commit, and metadata finalization happens last. Every phase is idempotent, so
 * a process exit or storage/database failure can be completed by a later run
 * without exposing metadata that points at bytes already removed.
 */
export class MaintenanceJobs {
  readonly #now: () => Date;
  readonly #revisionRetention: number;
  readonly #assetRetentionMs: number;
  readonly #deletedDrawingRetentionMs: number;
  readonly #auditRetentionMs: number;
  readonly #mutationRetentionMs: number;
  readonly #candidateBatchSize: number;

  public constructor(
    private readonly pool: Pool,
    private readonly storage: ObjectStorage,
    options: MaintenanceJobOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#revisionRetention = positiveInteger(
      "revisionRetention",
      options.revisionRetention ?? DEFAULT_REVISION_RETENTION,
    );
    this.#assetRetentionMs = nonnegativeInteger(
      "assetRetentionMs",
      options.assetRetentionMs ?? DEFAULT_ASSET_RETENTION_MS,
    );
    this.#deletedDrawingRetentionMs = nonnegativeInteger(
      "deletedDrawingRetentionMs",
      options.deletedDrawingRetentionMs ?? DEFAULT_DELETED_DRAWING_RETENTION_MS,
    );
    this.#auditRetentionMs = nonnegativeInteger(
      "auditRetentionMs",
      options.auditRetentionMs ?? DEFAULT_AUDIT_RETENTION_MS,
    );
    this.#mutationRetentionMs = nonnegativeInteger(
      "mutationRetentionMs",
      options.mutationRetentionMs ?? DEFAULT_MUTATION_RETENTION_MS,
    );
    this.#candidateBatchSize = positiveInteger(
      "candidateBatchSize",
      options.candidateBatchSize ?? DEFAULT_CANDIDATE_BATCH_SIZE,
    );
  }

  public async run(signal?: AbortSignal): Promise<MaintenanceResult> {
    const now = this.#now();
    if (Number.isNaN(now.getTime())) throw new RangeError("now must be valid");

    throwIfAborted(signal);
    const revisionsPruned = await this.pruneRevisions();
    throwIfAborted(signal);
    const mutationsDeleted = await this.cleanupExpiredMutations(now);
    throwIfAborted(signal);
    const orphanAssets = await this.cleanupOrphanAssets(now, signal);
    throwIfAborted(signal);
    const expiredInvitationsDeleted = await this.cleanupExpiredInvitations(now);
    throwIfAborted(signal);
    const security = await this.cleanupExpiredSecurityRecords(now);
    throwIfAborted(signal);
    const auditEventsDeleted = await this.cleanupAuditEvents(now);
    throwIfAborted(signal);
    const purgedDrawings = await this.purgeDeletedDrawings(now, signal);

    return {
      revisionsPruned,
      orphanAssetsDeleted: orphanAssets.deleted,
      expiredInvitationsDeleted,
      expiredSessionsDeleted: security.sessions,
      expiredVerificationsDeleted: security.verifications,
      auditEventsDeleted,
      mutationsDeleted,
      drawingsPurged: purgedDrawings.deleted,
      failures: [...orphanAssets.failures, ...purgedDrawings.failures],
    };
  }

  public async pruneRevisions(): Promise<number> {
    const result = await this.pool.query(
      `WITH ranked AS (
         SELECT id,
                row_number() OVER (
                  PARTITION BY drawing_id
                  ORDER BY content_revision DESC, id DESC
                ) AS retention_rank
         FROM drawing_revisions
       )
       DELETE FROM drawing_revisions revision
       USING ranked
       WHERE revision.id = ranked.id
         AND ranked.retention_rank > $1`,
      [this.#revisionRetention],
    );
    return result.rowCount ?? 0;
  }

  public async cleanupOrphanAssets(
    now = this.#now(),
    signal?: AbortSignal,
  ): Promise<{
    deleted: number;
    failures: MaintenanceFailure[];
  }> {
    const cutoff = before(now, this.#assetRetentionMs);
    const candidates = await this.pool.query<AssetCandidate>(
      `SELECT asset.id, asset.drawing_id, asset.storage_key, asset.deleted_at,
              asset.storage_deleted_at
       FROM drawing_assets asset
       JOIN drawings drawing ON drawing.id = asset.drawing_id
       WHERE drawing.deleted_at IS NULL
         AND (
           (asset.deleted_at IS NOT NULL AND asset.storage_deleted_at IS NULL)
           OR (
             asset.created_at < $1
             AND (asset.last_referenced_at IS NULL OR asset.last_referenced_at < $1)
             AND NOT (${CURRENT_SCENE_REFERENCE})
             AND NOT (${REVISION_SCENE_REFERENCE})
           )
         )
       ORDER BY COALESCE(asset.deleted_at, asset.created_at), asset.id
       LIMIT $2`,
      [cutoff, this.#candidateBatchSize],
    );

    let deleted = 0;
    const failures: MaintenanceFailure[] = [];
    for (const candidate of candidates.rows) {
      throwIfAborted(signal);
      try {
        const tombstoned = await this.#tombstoneOrphanAsset(
          candidate.id,
          cutoff,
          now,
        );
        if (!tombstoned) continue;
        try {
          await this.storage.delete(tombstoned.storage_key);
        } catch (error) {
          failures.push(failure(tombstoned.id, "asset-delete", error));
          continue;
        }
        try {
          if (await this.#finalizeOrphanAsset(tombstoned.id, now)) deleted += 1;
        } catch (error) {
          failures.push(failure(tombstoned.id, "asset-finalize", error));
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        failures.push(failure(candidate.id, "asset-tombstone", error));
      }
    }
    return { deleted, failures };
  }

  public async cleanupExpiredInvitations(now = this.#now()): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM drawing_invitations WHERE expires_at < $1`,
      [now],
    );
    return result.rowCount ?? 0;
  }

  public async cleanupExpiredMutations(now = this.#now()): Promise<number> {
    const cutoff = before(now, this.#mutationRetentionMs);
    const result = await this.pool.query(
      `DELETE FROM drawing_mutations WHERE created_at < $1`,
      [cutoff],
    );
    return result.rowCount ?? 0;
  }

  public async cleanupExpiredSecurityRecords(now = this.#now()): Promise<{
    sessions: number;
    verifications: number;
  }> {
    return transaction(this.pool, async (client) => {
      const sessions = await client.query(
        `DELETE FROM "session" WHERE expires_at < $1`,
        [now],
      );
      const verifications = await client.query(
        `DELETE FROM verification WHERE expires_at < $1`,
        [now],
      );
      return {
        sessions: sessions.rowCount ?? 0,
        verifications: verifications.rowCount ?? 0,
      };
    });
  }

  public async cleanupAuditEvents(now = this.#now()): Promise<number> {
    const cutoff = before(now, this.#auditRetentionMs);
    const result = await this.pool.query(
      `DELETE FROM audit_events WHERE created_at < $1`,
      [cutoff],
    );
    return result.rowCount ?? 0;
  }

  public async purgeDeletedDrawings(
    now = this.#now(),
    signal?: AbortSignal,
  ): Promise<{
    deleted: number;
    failures: MaintenanceFailure[];
  }> {
    const cutoff = before(now, this.#deletedDrawingRetentionMs);
    const candidates = await this.pool.query<DrawingCandidate>(
      `SELECT id FROM drawings
       WHERE deleted_at < $1
       ORDER BY deleted_at, id
       LIMIT $2`,
      [cutoff, this.#candidateBatchSize],
    );

    let deleted = 0;
    const failures: MaintenanceFailure[] = [];
    for (const candidate of candidates.rows) {
      throwIfAborted(signal);
      try {
        const prepared = await this.#prepareDrawingPurge(candidate.id, cutoff);
        if (!prepared) continue;
        let objectFailure = false;
        for (const storageKey of prepared.storageKeys) {
          throwIfAborted(signal);
          try {
            await this.storage.delete(storageKey);
          } catch (error) {
            if (isAbortError(error)) throw error;
            failures.push(failure(candidate.id, "drawing-delete", error));
            objectFailure = true;
            break;
          }
        }
        if (objectFailure) continue;
        try {
          if (await this.#finalizeDrawingPurge(candidate.id, cutoff))
            deleted += 1;
        } catch (error) {
          failures.push(failure(candidate.id, "drawing-finalize", error));
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        failures.push(failure(candidate.id, "drawing-finalize", error));
      }
    }
    return { deleted, failures };
  }

  async #tombstoneOrphanAsset(
    assetId: string,
    cutoff: Date,
    now: Date,
  ): Promise<AssetCandidate | null> {
    return transaction(this.pool, async (client) => {
      const identity = await client.query<AssetCandidate>(
        `SELECT id, drawing_id, storage_key, deleted_at, storage_deleted_at
         FROM drawing_assets WHERE id = $1`,
        [assetId],
      );
      const candidate = identity.rows[0];
      if (!candidate) return null;

      const drawing = await client.query<{ deleted_at: Date | null }>(
        `SELECT deleted_at FROM drawings WHERE id = $1 FOR UPDATE`,
        [candidate.drawing_id],
      );
      if (!drawing.rows[0] || drawing.rows[0].deleted_at) return null;

      if (candidate.deleted_at) return candidate;

      const asset = await client.query<AssetCandidate>(
        `SELECT asset.id, asset.drawing_id, asset.storage_key, asset.deleted_at,
                asset.storage_deleted_at
         FROM drawing_assets asset
         JOIN drawings drawing ON drawing.id = asset.drawing_id
         WHERE asset.id = $1
           AND asset.deleted_at IS NULL
           AND asset.created_at < $2
           AND (asset.last_referenced_at IS NULL OR asset.last_referenced_at < $2)
           AND NOT (${CURRENT_SCENE_REFERENCE})
           AND NOT (${REVISION_SCENE_REFERENCE})
         FOR UPDATE OF asset`,
        [assetId, cutoff],
      );
      const locked = asset.rows[0];
      if (!locked) return null;

      const tombstoned = await client.query<AssetCandidate>(
        `UPDATE drawing_assets SET deleted_at = $2
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, drawing_id, storage_key, deleted_at, storage_deleted_at`,
        [locked.id, now],
      );
      return tombstoned.rows[0] ?? null;
    });
  }

  async #finalizeOrphanAsset(assetId: string, now: Date): Promise<boolean> {
    const finalized = await this.pool.query(
      `UPDATE drawing_assets SET storage_deleted_at = $2
       WHERE id = $1 AND deleted_at IS NOT NULL AND storage_deleted_at IS NULL`,
      [assetId, now],
    );
    return (finalized.rowCount ?? 0) === 1;
  }

  async #prepareDrawingPurge(
    drawingId: string,
    cutoff: Date,
  ): Promise<{ storageKeys: string[] } | null> {
    return transaction(this.pool, async (client) => {
      const locked = await client.query<{ id: string }>(
        `SELECT id FROM drawings
         WHERE id = $1 AND deleted_at < $2
         FOR UPDATE`,
        [drawingId, cutoff],
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

  async #finalizeDrawingPurge(
    drawingId: string,
    cutoff: Date,
  ): Promise<boolean> {
    const removed = await this.pool.query(
      `DELETE FROM drawings WHERE id = $1 AND deleted_at < $2`,
      [drawingId, cutoff],
    );
    return (removed.rowCount ?? 0) === 1;
  }
}

// An asset remains live while any non-deleted element in the canonical scene
// or a retained revision names its fileId. This deliberately mirrors Excalidraw
// image references without trusting last_referenced_at as the source of truth.
const CURRENT_SCENE_REFERENCE = `EXISTS (
  SELECT 1
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(drawing.scene -> 'elements') = 'array'
      THEN drawing.scene -> 'elements' ELSE '[]'::jsonb END
  ) element
  WHERE element ->> 'fileId' = asset.file_id
    AND element ->> 'isDeleted' IS DISTINCT FROM 'true'
)`;

const REVISION_SCENE_REFERENCE = `EXISTS (
  SELECT 1
  FROM drawing_revisions revision
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(revision.scene -> 'elements') = 'array'
      THEN revision.scene -> 'elements' ELSE '[]'::jsonb END
  ) element
  WHERE revision.drawing_id = asset.drawing_id
    AND element ->> 'fileId' = asset.file_id
    AND element ->> 'isDeleted' IS DISTINCT FROM 'true'
)`;

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

function before(now: Date, milliseconds: number): Date {
  const cutoff = new Date(now.getTime() - milliseconds);
  if (Number.isNaN(cutoff.getTime())) throw new RangeError("invalid cutoff");
  return cutoff;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonnegativeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function failure(
  id: string,
  stage: MaintenanceFailure["stage"],
  error: unknown,
): MaintenanceFailure {
  return { id, stage, errorType: safeErrorType(error) };
}

function safeErrorType(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
  ) {
    return error.code;
  }
  if (
    error instanceof Error &&
    /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
  ) {
    return error.name;
  }
  return "UnknownError";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Maintenance was cancelled");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
