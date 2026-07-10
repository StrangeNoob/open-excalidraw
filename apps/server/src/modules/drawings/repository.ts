import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  AccessibleDrawing,
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
  content_revision: string;
  metadata_revision: string;
  created_at: Date;
  updated_at: Date;
}

export class PostgresDrawingRepository implements DrawingRepository {
  public constructor(private readonly pool: Pool) {}

  public async listForUser(userId: string) {
    const [owned, shared] = await Promise.all([
      this.pool.query<AccessibleDrawingRow>(
        `
          SELECT
            d.id, d.title, d.owner_user_id, u.name AS owner_name,
            'owner'::text AS role, d.content_revision, d.metadata_revision,
            d.created_at, d.updated_at
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
            d.created_at, d.updated_at
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
  }): Promise<AccessibleDrawing> {
    const scene = JSON.stringify(EMPTY_SCENE);
    const result = await this.pool.query<AccessibleDrawingRow>(
      `
        WITH created AS (
          INSERT INTO drawings (
            owner_user_id, title, scene, scene_format_version, scene_bytes
          ) VALUES ($1, $2, $3::jsonb, 1, $4)
          RETURNING *
        )
        SELECT
          d.id, d.title, d.owner_user_id, u.name AS owner_name,
          'owner'::text AS role, d.content_revision, d.metadata_revision,
          d.created_at, d.updated_at
        FROM created d
        JOIN "user" u ON u.id = d.owner_user_id
      `,
      [input.ownerUserId, input.title, scene, Buffer.byteLength(scene)],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Drawing insert did not return a row");
    }
    return mapAccessible(row);
  }

  public async rename(input: {
    drawingId: string;
    actorUserId: string;
    title: string;
    expectedMetadataRevision: bigint;
  }): Promise<RenameDrawingResult> {
    const result = await this.pool.query<{ metadata_revision: string }>(
      `
        UPDATE drawings d
        SET
          title = $3,
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

  public async softDelete(input: { drawingId: string; ownerUserId: string }) {
    const result = await this.pool.query(
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

  public async leave(input: { drawingId: string; userId: string }) {
    const result = await this.pool.query(
      `DELETE FROM drawing_members WHERE drawing_id = $1 AND user_id = $2`,
      [input.drawingId, input.userId],
    );
    return result.rowCount === 1 ? "left" : "not-found";
  }

  public async transferOwnership(input: {
    drawingId: string;
    currentOwnerUserId: string;
    newOwnerUserId: string;
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
        d.content_revision, d.metadata_revision, d.created_at, d.updated_at
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
    contentRevision: BigInt(row.content_revision),
    metadataRevision: BigInt(row.metadata_revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
