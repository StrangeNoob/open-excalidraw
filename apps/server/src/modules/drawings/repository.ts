import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { CONTRACT_LIMITS } from "@open-excalidraw/contracts";
import {
  StorageIntegrityError,
  StorageNotFoundError,
  type ObjectStorage,
} from "@open-excalidraw/storage";

import { assetStorageKey, thumbnailStorageKey } from "../assets/service.js";
import { insertAuditEvent } from "../audit.js";
import type {
  AccessibleDrawing,
  DrawingBlobStore,
  DrawingRepository,
  RenameDrawingResult,
  TransferOwnershipResult,
} from "./types.js";

const EMPTY_SCENE = {
  type: "excalidraw",
  version: 2,
  source: "open-excalidraw",
  elements: [],
  appState: {},
};

interface AccessibleDrawingRow extends QueryResultRow {
  id: string;
  title: string;
  owner_user_id: string;
  owner_name: string;
  role: "owner" | "editor" | "viewer";
  tags: string[];
  content_revision: string;
  metadata_revision: string;
  created_at: Date;
  updated_at: Date;
  thumbnail_updated_at: Date | null;
  is_template: boolean;
}

/** The requesting user's private tags, aggregated per drawing. */
const tagsSelect = (userParam: string) => `
  COALESCE((
    SELECT array_agg(t.tag ORDER BY t.tag)
    FROM drawing_user_tags t
    WHERE t.drawing_id = d.id AND t.user_id = ${userParam}
  ), '{}') AS tags
`;

export class PostgresDrawingRepository implements DrawingRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly blobs: DrawingBlobStore,
  ) {}

  public async listForUser(userId: string) {
    const [owned, shared] = await Promise.all([
      this.pool.query<AccessibleDrawingRow>(
        `
          SELECT
            d.id, d.title, d.owner_user_id, u.name AS owner_name,
            'owner'::text AS role, d.content_revision, d.metadata_revision,
            d.created_at, d.updated_at, d.thumbnail_updated_at, d.is_template,
            ${tagsSelect("$1")}
          FROM drawings d
          JOIN "user" u ON u.id = d.owner_user_id
          WHERE d.owner_user_id = $1 AND d.deleted_at IS NULL
          ORDER BY d.updated_at DESC
        `,
        [userId],
      ),
      this.pool.query<AccessibleDrawingRow>(
        `
          SELECT
            d.id, d.title, d.owner_user_id, u.name AS owner_name,
            m.role, d.content_revision, d.metadata_revision,
            d.created_at, d.updated_at, d.thumbnail_updated_at, d.is_template,
            ${tagsSelect("$1")}
          FROM drawing_members m
          JOIN drawings d ON d.id = m.drawing_id
          JOIN "user" u ON u.id = d.owner_user_id
          WHERE m.user_id = $1 AND d.deleted_at IS NULL
          ORDER BY d.updated_at DESC
        `,
        [userId],
      ),
    ]);

    return {
      owned: owned.rows.map(mapAccessible),
      shared: shared.rows.map(mapAccessible),
    };
  }

  public async findAccessible(
    drawingId: string,
    userId: string,
  ): Promise<AccessibleDrawing | null> {
    return findAccessibleWith(this.pool, drawingId, userId);
  }

  public async create(input: {
    ownerUserId: string;
    title: string;
    idempotencyKey?: string;
  }): Promise<AccessibleDrawing> {
    const scene = JSON.stringify(EMPTY_SCENE);
    const drawingId = input.idempotencyKey
      ? deterministicDrawingId(input.ownerUserId, input.idempotencyKey)
      : null;
    const result = await this.pool.query<AccessibleDrawingRow>(
      `
        WITH created AS (
          INSERT INTO drawings (
            id, owner_user_id, title, scene, scene_format_version, scene_bytes
          ) VALUES (COALESCE($5::uuid, gen_random_uuid()), $1, $2, $3::jsonb, 1, $4)
          ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
          WHERE drawings.owner_user_id = EXCLUDED.owner_user_id
          RETURNING drawings.*
        )
        SELECT
          d.id, d.title, d.owner_user_id, u.name AS owner_name,
          'owner'::text AS role, d.content_revision, d.metadata_revision,
          d.created_at, d.updated_at, d.thumbnail_updated_at, d.is_template,
          '{}'::text[] AS tags
        FROM created d
        JOIN "user" u ON u.id = d.owner_user_id
      `,
      [
        input.ownerUserId,
        input.title,
        scene,
        Buffer.byteLength(scene),
        drawingId,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Drawing insert did not return a row");
    }
    return mapAccessible(row);
  }

  public async duplicate(input: {
    sourceDrawingId: string;
    ownerUserId: string;
  }): Promise<AccessibleDrawing | null> {
    // Phase 1: copy the rows in one short SQL-only transaction. Blob I/O is
    // deliberately kept outside so the FOR SHARE lock (which blocks content
    // saves on the source) is held for milliseconds, not for the copy.
    const newId = randomUUID();
    const client = await this.pool.connect();
    let drawing: AccessibleDrawing;
    let assets: { file_id: string; sha256: Buffer }[];
    let hasThumbnail: boolean;
    try {
      await client.query("BEGIN");
      // The access predicate is re-checked here, inside the transaction:
      // the service's capability check ran on an earlier snapshot and a
      // revocation may have committed since.
      const source = await client.query<{
        title: string;
        thumbnail_updated_at: Date | null;
      }>(
        `SELECT s.title, s.thumbnail_updated_at FROM drawings s
         WHERE s.id = $1 AND s.deleted_at IS NULL
           AND (
             s.owner_user_id = $2
             OR EXISTS (
               SELECT 1 FROM drawing_members m
               WHERE m.drawing_id = s.id AND m.user_id = $2
             )
           )
         FOR SHARE`,
        [input.sourceDrawingId, input.ownerUserId],
      );
      const src = source.rows[0];
      if (!src) {
        await client.query("ROLLBACK");
        return null;
      }

      const assetRows = await client.query<{
        file_id: string;
        sha256: Buffer;
      }>(
        `SELECT file_id, sha256 FROM drawing_assets
         WHERE drawing_id = $1 AND deleted_at IS NULL`,
        [input.sourceDrawingId],
      );

      // Scene copied in SQL so the payload never round-trips through JS.
      await client.query(
        `INSERT INTO drawings (
           id, owner_user_id, title, scene, scene_format_version, scene_bytes,
           thumbnail_updated_at
         )
         SELECT $2::uuid, $3, $4, s.scene, s.scene_format_version,
                s.scene_bytes, $5::timestamptz
         FROM drawings s WHERE s.id = $1`,
        [
          input.sourceDrawingId,
          newId,
          input.ownerUserId,
          duplicateTitle(src.title),
          src.thumbnail_updated_at,
        ],
      );
      await client.query(
        `INSERT INTO drawing_assets (
           drawing_id, file_id, storage_key, mime_type, byte_size, sha256,
           file_version, created_by_user_id
         )
         SELECT $2::uuid, a.file_id,
                'drawings/' || ($2::uuid)::text || '/assets/' || a.file_id,
                a.mime_type, a.byte_size, a.sha256, a.file_version, $3::uuid
         FROM drawing_assets a
         WHERE a.drawing_id = $1 AND a.deleted_at IS NULL`,
        [input.sourceDrawingId, newId, input.ownerUserId],
      );

      const loaded = await findAccessibleWith(client, newId, input.ownerUserId);
      if (!loaded) {
        throw new Error("Duplicated drawing could not be reloaded");
      }
      await client.query("COMMIT");
      drawing = loaded;
      assets = assetRows.rows;
      hasThumbnail = src.thumbnail_updated_at !== null;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection may already be gone; surface the original error.
      }
      throw error;
    } finally {
      client.release();
    }

    // Phase 2: copy the blobs. Rows committed first means every key below is
    // derivable from drawing_assets/drawings, so even a crash mid-copy leaves
    // nothing the normal delete/purge path cannot reclaim.
    const copiedKeys: string[] = [];
    try {
      for (const asset of assets) {
        const targetKey = assetStorageKey(newId, asset.file_id);
        const copied = await this.blobs.copy({
          sourceKey: assetStorageKey(input.sourceDrawingId, asset.file_id),
          targetKey,
          expectedSha256: asset.sha256.toString("hex"),
        });
        if (copied === "copied") {
          copiedKeys.push(targetKey);
        }
      }
      if (hasThumbnail) {
        await this.blobs.copy({
          sourceKey: thumbnailStorageKey(input.sourceDrawingId),
          targetKey: thumbnailStorageKey(newId),
        });
      }
    } catch (error) {
      // Storage failed hard (not a missing/corrupt source): undo the copy so
      // a retry does not stack half-broken duplicates. Blobs first — the rows
      // are what make leftover keys purgeable if this cleanup dies midway.
      for (const key of copiedKeys) {
        try {
          await this.blobs.remove(key);
        } catch {
          // Storage is already failing; the purge path can retry later.
        }
      }
      await this.pool.query(
        `DELETE FROM drawings WHERE id = $1 AND owner_user_id = $2`,
        [newId, input.ownerUserId],
      );
      throw error;
    }
    return drawing;
  }

  public async rename(input: {
    drawingId: string;
    actorUserId: string;
    title: string;
    expectedMetadataRevision: bigint;
    isTemplate?: boolean;
  }): Promise<RenameDrawingResult> {
    const result = await this.pool.query<{ metadata_revision: string }>(
      `
        UPDATE drawings d
        SET
          title = $3,
          is_template = COALESCE($5, d.is_template),
          metadata_revision = d.metadata_revision + 1,
          updated_at = now()
        WHERE d.id = $1
          AND d.deleted_at IS NULL
          AND d.metadata_revision = $4::bigint
          AND (
            d.owner_user_id = $2
            OR EXISTS (
              SELECT 1 FROM drawing_members m
              WHERE m.drawing_id = d.id
                AND m.user_id = $2
                AND m.role = 'editor'
            )
          )
        RETURNING d.metadata_revision
      `,
      [
        input.drawingId,
        input.actorUserId,
        input.title,
        input.expectedMetadataRevision.toString(),
        input.isTemplate ?? null,
      ],
    );

    if (!result.rows[0]) {
      const current = await this.findAccessible(
        input.drawingId,
        input.actorUserId,
      );
      return current
        ? current.role === "viewer"
          ? { status: "forbidden" }
          : { status: "conflict", currentRevision: current.metadataRevision }
        : { status: "not-found" };
    }

    const drawing = await this.findAccessible(
      input.drawingId,
      input.actorUserId,
    );
    return drawing ? { status: "updated", drawing } : { status: "not-found" };
  }

  public async softDelete(input: {
    drawingId: string;
    ownerUserId: string;
    auditRequestId?: string;
  }) {
    const result = input.auditRequestId
      ? await this.pool.query(
          `WITH deleted AS (
             UPDATE drawings
             SET deleted_at = now(), updated_at = now(),
                 metadata_revision = metadata_revision + 1
             WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL
             RETURNING id
           )
           INSERT INTO audit_events
             (actor_user_id, drawing_id, event_type, request_id, metadata)
           SELECT $2, deleted.id, 'drawing.deleted', $3, '{}'::jsonb
           FROM deleted
           RETURNING id`,
          [input.drawingId, input.ownerUserId, input.auditRequestId],
        )
      : await this.pool.query(
          `
        UPDATE drawings
        SET
          deleted_at = now(),
          updated_at = now(),
          metadata_revision = metadata_revision + 1
        WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL
      `,
          [input.drawingId, input.ownerUserId],
        );
    return result.rowCount === 1 ? "deleted" : "not-found";
  }

  public async replaceTags(input: {
    drawingId: string;
    userId: string;
    tags: string[];
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM drawing_user_tags WHERE drawing_id = $1 AND user_id = $2`,
        [input.drawingId, input.userId],
      );
      if (input.tags.length > 0) {
        await client.query(
          `
            INSERT INTO drawing_user_tags (drawing_id, user_id, tag)
            SELECT $1, $2, unnest($3::text[])
          `,
          [input.drawingId, input.userId, input.tags],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async leave(input: { drawingId: string; userId: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const drawing = await client.query(
        `SELECT id FROM drawings /* drawing-self-leave */
         WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [input.drawingId],
      );
      if (!drawing.rows[0]) {
        await client.query("ROLLBACK");
        return "not-found";
      }
      const result = await client.query(
        `DELETE FROM drawing_members WHERE drawing_id = $1 AND user_id = $2`,
        [input.drawingId, input.userId],
      );
      await client.query("COMMIT");
      return result.rowCount === 1 ? "left" : "not-found";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async transferOwnership(input: {
    drawingId: string;
    currentOwnerUserId: string;
    newOwnerUserId: string;
    auditRequestId?: string;
  }): Promise<TransferOwnershipResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const target = await client.query(`SELECT id FROM "user" WHERE id = $1`, [
        input.newOwnerUserId,
      ]);
      if (!target.rows[0]) {
        await client.query("ROLLBACK");
        return { status: "target-not-found" };
      }

      await client.query(`SELECT id FROM drawings WHERE id = $1 FOR UPDATE`, [
        input.drawingId,
      ]);
      const update = await client.query(
        `
          UPDATE drawings
          SET
            owner_user_id = $3,
            metadata_revision = metadata_revision + 1,
            updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL
        `,
        [input.drawingId, input.currentOwnerUserId, input.newOwnerUserId],
      );
      if (update.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { status: "not-found" };
      }

      await client.query(
        `DELETE FROM drawing_members WHERE drawing_id = $1 AND user_id = $2`,
        [input.drawingId, input.newOwnerUserId],
      );
      await client.query(
        `
          INSERT INTO drawing_members (
            drawing_id, user_id, role, created_by_user_id
          ) VALUES ($1, $2, 'editor', $3)
          ON CONFLICT (drawing_id, user_id)
          DO UPDATE SET role = 'editor'
        `,
        [input.drawingId, input.currentOwnerUserId, input.newOwnerUserId],
      );

      const drawing = await findAccessibleWith(
        client,
        input.drawingId,
        input.newOwnerUserId,
      );
      if (!drawing) {
        throw new Error("Transferred drawing could not be reloaded");
      }
      if (input.auditRequestId) {
        await insertAuditEvent(client, {
          actorUserId: input.currentOwnerUserId,
          drawingId: input.drawingId,
          eventType: "drawing.ownership_transferred",
          requestId: input.auditRequestId,
          metadata: { newOwnerUserId: input.newOwnerUserId },
        });
      }
      await client.query("COMMIT");
      return { status: "transferred", drawing };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Adapts object storage to the blob copies a drawing duplicate needs. */
export function storageDrawingBlobStore(
  storage: ObjectStorage,
): DrawingBlobStore {
  return {
    async copy(input) {
      let body;
      try {
        body = await storage.get(input.sourceKey);
      } catch (error) {
        if (error instanceof StorageNotFoundError) {
          return "missing";
        }
        throw error;
      }
      try {
        await storage.put(
          input.targetKey,
          body,
          input.expectedSha256 ? { expectedSha256: input.expectedSha256 } : {},
        );
      } catch (error) {
        // A corrupt source blob (bytes no longer match their recorded
        // checksum) must not make the drawing un-duplicatable; the copy is
        // simply as broken as its source, like a missing blob.
        if (error instanceof StorageIntegrityError) {
          return "missing";
        }
        throw error;
      }
      return "copied";
    },
    async remove(key) {
      await storage.delete(key);
    },
  };
}

/** Owner-scoped deterministic UUID used only when a create idempotency key exists. */
export function deterministicDrawingId(
  ownerUserId: string,
  idempotencyKey: string,
): string {
  const bytes = createHash("sha256")
    .update("open-excalidraw:drawing-create\0")
    .update(ownerUserId)
    .update("\0")
    .update(idempotencyKey)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function findAccessibleWith(
  client: Pick<Pool | PoolClient, "query">,
  drawingId: string,
  userId: string,
): Promise<AccessibleDrawing | null> {
  const result = await client.query<AccessibleDrawingRow>(
    `
      SELECT
        d.id, d.title, d.owner_user_id, u.name AS owner_name,
        CASE WHEN d.owner_user_id = $2 THEN 'owner' ELSE m.role END AS role,
        d.content_revision, d.metadata_revision, d.created_at, d.updated_at,
        d.thumbnail_updated_at, d.is_template, ${tagsSelect("$2")}
      FROM drawings d
      JOIN "user" u ON u.id = d.owner_user_id
      LEFT JOIN drawing_members m
        ON m.drawing_id = d.id AND m.user_id = $2
      WHERE d.id = $1
        AND d.deleted_at IS NULL
        AND (d.owner_user_id = $2 OR m.user_id IS NOT NULL)
      LIMIT 1
    `,
    [drawingId, userId],
  );
  return result.rows[0] ? mapAccessible(result.rows[0]) : null;
}

function mapAccessible(row: AccessibleDrawingRow): AccessibleDrawing {
  if (row.role !== "owner" && row.role !== "editor" && row.role !== "viewer") {
    throw new Error("Database returned an invalid drawing role");
  }
  return {
    id: row.id,
    title: row.title,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    role: row.role,
    tags: row.tags,
    contentRevision: BigInt(row.content_revision),
    metadataRevision: BigInt(row.metadata_revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    thumbnailUpdatedAt: row.thumbnail_updated_at,
    isTemplate: row.is_template,
  };
}

/** "Title copy", truncated so the suffix always fits the title limit. */
function duplicateTitle(title: string): string {
  const suffix = " copy";
  const max = CONTRACT_LIMITS.drawingTitleCharacters;
  const base =
    title.length + suffix.length <= max
      ? title
      : title.slice(0, max - suffix.length).trimEnd();
  return `${base}${suffix}`;
}
