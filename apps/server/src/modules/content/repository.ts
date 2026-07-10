import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  ContentAccess,
  ContentRepository,
  RestoreRevisionResult,
  RevisionRecord,
  SaveContentInput,
  SaveContentResult,
  StoredContent,
} from "./types.js";

interface DrawingContentRow extends QueryResultRow {
  id: string;
  scene: StoredContent["scene"];
  scene_bytes: number;
  scene_format_version: number;
  owner_user_id: string;
  content_revision: string;
  updated_at: Date;
  last_checkpoint_at: Date | null;
}

interface MutationRow extends QueryResultRow {
  payload_hash: Buffer;
  resulting_revision: string;
  created_at: Date;
}

export class PostgresContentRepository implements ContentRepository {
  public constructor(private readonly pool: Pool) {}

  public async load(
    drawingId: string,
    userId: string,
  ): Promise<StoredContent | null> {
    const result = await this.pool.query<DrawingContentRow & { role: string }>(
      `${ACCESS_QUERY} AND d.id = $1 LIMIT 1`,
      [drawingId, userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      revision: BigInt(row.content_revision),
      scene: row.scene,
      assetIds: referencedAssetIds(row.scene),
      savedAt: row.updated_at,
    };
  }

  public async save(input: SaveContentInput): Promise<SaveContentResult> {
    return transaction(this.pool, async (client) => {
      const drawing = await lockAccessible(
        client,
        input.drawingId,
        input.actorUserId,
      );
      if (!drawing) return { status: "not-found" };
      if (drawing.role === "viewer") return { status: "forbidden" };

      const prior = await client.query<MutationRow>(
        `SELECT payload_hash, resulting_revision, created_at
         FROM drawing_mutations WHERE drawing_id = $1 AND mutation_id = $2`,
        [input.drawingId, input.mutationId],
      );
      const replay = prior.rows[0];
      if (replay) {
        return replay.payload_hash.equals(input.payloadHash)
          ? {
              status: "replayed",
              revision: BigInt(replay.resulting_revision),
              savedAt: replay.created_at,
            }
          : { status: "idempotency-mismatch" };
      }

      const currentRevision = BigInt(drawing.content_revision);
      if (currentRevision !== input.expectedRevision) {
        return { status: "conflict", currentRevision };
      }

      const missing = await lockAndFindMissingAssets(
        client,
        input.drawingId,
        input.assetIds,
      );
      if (missing.length > 0)
        return { status: "missing-assets", fileIds: missing };

      const nextRevision = currentRevision + 1n;
      const checkpointDue =
        drawing.last_checkpoint_at === null ||
        Date.now() - drawing.last_checkpoint_at.getTime() >=
          input.checkpointIntervalMs;
      const updated = await client.query<{ updated_at: Date }>(
        `UPDATE drawings
         SET scene = $2::jsonb,
             scene_format_version = $3,
             scene_bytes = $4,
             content_revision = $5::bigint,
             updated_at = now(),
             last_checkpoint_at = CASE WHEN $6 THEN now() ELSE last_checkpoint_at END
         WHERE id = $1 AND owner_user_id IS NOT NULL AND deleted_at IS NULL
         RETURNING updated_at`,
        [
          input.drawingId,
          JSON.stringify(input.scene),
          1,
          input.sceneBytes,
          nextRevision.toString(),
          checkpointDue,
        ],
      );
      const savedAt = updated.rows[0]?.updated_at;
      if (!savedAt)
        throw new Error("Locked drawing disappeared during content save");

      await client.query(
        `UPDATE drawing_assets SET last_referenced_at = now()
         WHERE drawing_id = $1 AND file_id = ANY($2::text[]) AND deleted_at IS NULL`,
        [input.drawingId, input.assetIds],
      );
      await client.query(
        `INSERT INTO drawing_mutations
           (drawing_id, mutation_id, payload_hash, base_revision, resulting_revision, created_at)
         VALUES ($1, $2, $3, $4::bigint, $5::bigint, $6)`,
        [
          input.drawingId,
          input.mutationId,
          input.payloadHash,
          currentRevision.toString(),
          nextRevision.toString(),
          savedAt,
        ],
      );
      if (checkpointDue) {
        await insertRevision(client, {
          drawingId: input.drawingId,
          revision: nextRevision,
          scene: input.scene,
          sceneFormatVersion: 1,
          sceneBytes: input.sceneBytes,
          authorUserId: input.actorUserId,
          reason: "checkpoint",
        });
      }
      return { status: "saved", revision: nextRevision, savedAt };
    });
  }

  public async listRevisions(
    drawingId: string,
    userId: string,
  ): Promise<RevisionRecord[] | null> {
    return transaction(this.pool, async (client) => {
      const drawing = await lockDrawing(client, drawingId, "share");
      if (!drawing || !(await roleForLockedDrawing(client, drawing, userId))) {
        return null;
      }
      const result = await client.query<{
        content_revision: string;
        reason: string;
        author_user_id: string;
        created_at: Date;
      }>(
        `SELECT content_revision, reason, author_user_id, created_at
         FROM drawing_revisions WHERE drawing_id = $1
         ORDER BY content_revision DESC LIMIT 100`,
        [drawingId],
      );
      return result.rows.map((row) => ({
        revision: BigInt(row.content_revision),
        reason: row.reason === "restore" ? "restore" : "checkpoint",
        authorUserId: row.author_user_id,
        createdAt: row.created_at,
      }));
    });
  }

  public async restore(input: {
    drawingId: string;
    actorUserId: string;
    revision: bigint;
  }): Promise<RestoreRevisionResult> {
    return transaction(this.pool, async (client) => {
      const drawing = await lockAccessible(
        client,
        input.drawingId,
        input.actorUserId,
      );
      if (!drawing) return { status: "not-found" };
      if (drawing.role === "viewer") return { status: "forbidden" };
      const target = await client.query<{
        scene: StoredContent["scene"];
        scene_format_version: number;
        scene_bytes: number;
      }>(
        `SELECT scene, scene_format_version, scene_bytes
         FROM drawing_revisions
         WHERE drawing_id = $1 AND content_revision = $2::bigint`,
        [input.drawingId, input.revision.toString()],
      );
      const revision = target.rows[0];
      if (!revision) return { status: "revision-not-found" };

      const restoredAssetIds = referencedAssetIds(revision.scene);
      const missing = await lockAndFindMissingAssets(
        client,
        input.drawingId,
        restoredAssetIds,
      );
      if (missing.length > 0) {
        return { status: "missing-assets", fileIds: missing };
      }

      const currentRevision = BigInt(drawing.content_revision);
      await client.query(
        `INSERT INTO drawing_revisions
           (drawing_id, content_revision, scene, scene_format_version, scene_bytes, author_user_id, reason)
         VALUES ($1, $2::bigint, $3::jsonb, $4, $5, $6, 'checkpoint')
         ON CONFLICT (drawing_id, content_revision) DO NOTHING`,
        [
          input.drawingId,
          currentRevision.toString(),
          JSON.stringify(drawing.scene),
          drawing.scene_format_version,
          drawing.scene_bytes,
          input.actorUserId,
        ],
      );
      const nextRevision = currentRevision + 1n;
      const updated = await client.query<{ updated_at: Date }>(
        `UPDATE drawings
         SET scene = $2::jsonb, scene_format_version = $3, scene_bytes = $4,
             content_revision = $5::bigint, updated_at = now(), last_checkpoint_at = now()
         WHERE id = $1 RETURNING updated_at`,
        [
          input.drawingId,
          JSON.stringify(revision.scene),
          revision.scene_format_version,
          revision.scene_bytes,
          nextRevision.toString(),
        ],
      );
      await insertRevision(client, {
        drawingId: input.drawingId,
        revision: nextRevision,
        scene: revision.scene,
        sceneFormatVersion: revision.scene_format_version,
        sceneBytes: revision.scene_bytes,
        authorUserId: input.actorUserId,
        reason: "restore",
      });
      await client.query(
        `UPDATE drawing_assets SET last_referenced_at = now()
         WHERE drawing_id = $1 AND file_id = ANY($2::text[]) AND deleted_at IS NULL`,
        [input.drawingId, restoredAssetIds],
      );
      const savedAt = updated.rows[0]?.updated_at;
      if (!savedAt)
        throw new Error("Locked drawing disappeared during restore");
      return { status: "restored", revision: nextRevision, savedAt };
    });
  }
}

const ACCESS_QUERY = `
  SELECT d.id, d.scene, d.scene_bytes, d.scene_format_version, d.owner_user_id,
         d.content_revision, d.updated_at,
         d.last_checkpoint_at,
         CASE WHEN d.owner_user_id = $2 THEN 'owner' ELSE m.role END AS role
  FROM drawings d
  LEFT JOIN drawing_members m ON m.drawing_id = d.id AND m.user_id = $2
  WHERE d.deleted_at IS NULL AND (d.owner_user_id = $2 OR m.user_id IS NOT NULL)`;

async function lockAccessible(
  client: PoolClient,
  drawingId: string,
  userId: string,
) {
  const drawing = await lockDrawing(client, drawingId, "update");
  if (!drawing) return null;
  const role = await roleForLockedDrawing(client, drawing, userId);
  return role ? { ...drawing, role } : null;
}

async function lockDrawing(
  client: PoolClient,
  drawingId: string,
  mode: "share" | "update",
) {
  const lockClause = mode === "update" ? "FOR UPDATE" : "FOR SHARE";
  const result = await client.query<DrawingContentRow>(
    `SELECT id, scene, scene_bytes, scene_format_version, owner_user_id,
            content_revision, updated_at, last_checkpoint_at
     FROM drawings WHERE id = $1 AND deleted_at IS NULL ${lockClause}`,
    [drawingId],
  );
  return result.rows[0] ?? null;
}

async function roleForLockedDrawing(
  client: PoolClient,
  drawing: DrawingContentRow,
  userId: string,
): Promise<ContentAccess["role"] | null> {
  if (drawing.owner_user_id === userId) return "owner";
  const result = await client.query<{ role: "editor" | "viewer" }>(
    `SELECT role FROM drawing_members WHERE drawing_id = $1 AND user_id = $2`,
    [drawing.id, userId],
  );
  return result.rows[0]?.role ?? null;
}

async function lockAndFindMissingAssets(
  client: PoolClient,
  drawingId: string,
  assetIds: string[],
) {
  if (assetIds.length === 0) return [];
  const result = await client.query<{ file_id: string }>(
    `SELECT file_id FROM drawing_assets
     WHERE drawing_id = $1 AND file_id = ANY($2::text[]) AND deleted_at IS NULL
     ORDER BY file_id FOR UPDATE`,
    [drawingId, assetIds],
  );
  const found = new Set(result.rows.map((row) => row.file_id));
  return assetIds.filter((fileId) => !found.has(fileId));
}

async function insertRevision(
  client: PoolClient,
  input: {
    drawingId: string;
    revision: bigint;
    scene: StoredContent["scene"];
    sceneFormatVersion: number;
    sceneBytes: number;
    authorUserId: string;
    reason: "checkpoint" | "restore";
  },
) {
  await client.query(
    `INSERT INTO drawing_revisions
       (drawing_id, content_revision, scene, scene_format_version, scene_bytes, author_user_id, reason)
     VALUES ($1, $2::bigint, $3::jsonb, $4, $5, $6, $7)`,
    [
      input.drawingId,
      input.revision.toString(),
      JSON.stringify(input.scene),
      input.sceneFormatVersion,
      input.sceneBytes,
      input.authorUserId,
      input.reason,
    ],
  );
}

function referencedAssetIds(scene: StoredContent["scene"]) {
  const ids = new Set<string>();
  for (const element of scene.elements) {
    if (
      typeof element === "object" &&
      element !== null &&
      "fileId" in element &&
      typeof element.fileId === "string" &&
      element.fileId.length > 0
    ) {
      ids.add(element.fileId);
    }
  }
  return [...ids].sort();
}

async function transaction<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
