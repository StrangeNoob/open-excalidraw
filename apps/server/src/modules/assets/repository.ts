import {
  drawingAssets,
  drawingMembers,
  drawings,
  type Database,
  type DrawingAsset,
} from "@open-excalidraw/database";
import { and, eq, isNull, sql } from "drizzle-orm";

import { AssetTombstoneConflictError } from "./errors.js";
import type {
  AssetAccessRole,
  AssetRecord,
  AssetRepository,
  InsertAssetResult,
  NewAssetRecord,
  QuotaContext,
} from "./types.js";

function mapAsset(asset: DrawingAsset): AssetRecord {
  return {
    id: asset.id,
    drawingId: asset.drawingId,
    fileId: asset.fileId,
    storageKey: asset.storageKey,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    sha256: asset.sha256.toString("hex"),
    fileVersion: asset.fileVersion,
    createdByUserId: asset.createdByUserId,
    createdAt: asset.createdAt,
  };
}

/** PostgreSQL/Drizzle implementation used by the production composition root. */
export class DrizzleAssetRepository implements AssetRepository {
  public constructor(private readonly database: Database) {}

  public async getDrawingAccess(
    drawingId: string,
    userId: string,
  ): Promise<AssetAccessRole | null> {
    const drawing = await this.database.query.drawings.findFirst({
      columns: { ownerUserId: true },
      where: (table, { and, eq, isNull }) =>
        and(eq(table.id, drawingId), isNull(table.deletedAt)),
    });

    if (!drawing) {
      return null;
    }
    if (drawing.ownerUserId === userId) {
      return "owner";
    }

    const member = await this.database.query.drawingMembers.findFirst({
      columns: { role: true },
      where: (table, { and, eq }) =>
        and(eq(table.drawingId, drawingId), eq(table.userId, userId)),
    });

    return member?.role === "editor" || member?.role === "viewer"
      ? member.role
      : null;
  }

  public async setThumbnailUpdatedAt(
    drawingId: string,
    when: Date | null,
  ): Promise<boolean> {
    const updated = await this.database
      .update(drawings)
      .set({ thumbnailUpdatedAt: when })
      .where(and(eq(drawings.id, drawingId), isNull(drawings.deletedAt)))
      .returning({ id: drawings.id });
    return updated.length === 1;
  }

  public async getQuotaContext(
    drawingId: string,
  ): Promise<QuotaContext | null> {
    // One query: owner + override + global setting + the owner's total active
    // asset bytes across all their drawings (trashed included). LEFT JOIN
    // app_settings tolerates a missing settings row (treated as no global).
    // pg returns bigint as string, so every numeric column is converted below.
    const result = await this.database.execute<{
      owner_user_id: string;
      used_bytes: string;
      owner_quota_override_bytes: string | null;
      global_quota_bytes: string | null;
    }>(sql`
      SELECT
        d.owner_user_id AS owner_user_id,
        u.storage_quota_bytes AS owner_quota_override_bytes,
        s.storage_quota_per_user_bytes AS global_quota_bytes,
        (SELECT coalesce(sum(a.byte_size), 0)
           FROM drawing_assets a
           JOIN drawings d2 ON d2.id = a.drawing_id
           WHERE d2.owner_user_id = d.owner_user_id
             AND a.deleted_at IS NULL) AS used_bytes
      FROM drawings d
      JOIN "user" u ON u.id = d.owner_user_id
      LEFT JOIN app_settings s ON s.id = true
      WHERE d.id = ${drawingId}
    `);

    const row = result.rows[0];
    if (!row) return null;
    return {
      ownerUserId: row.owner_user_id,
      usedBytes: Number(row.used_bytes),
      ownerQuotaOverrideBytes:
        row.owner_quota_override_bytes === null
          ? null
          : Number(row.owner_quota_override_bytes),
      globalQuotaBytes:
        row.global_quota_bytes === null ? null : Number(row.global_quota_bytes),
    };
  }

  public async findAsset(
    drawingId: string,
    fileId: string,
  ): Promise<AssetRecord | null> {
    const asset = await this.database.query.drawingAssets.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.drawingId, drawingId),
          eq(table.fileId, fileId),
          isNull(table.deletedAt),
        ),
    });

    return asset ? mapAsset(asset) : null;
  }

  public async insertAsset(asset: NewAssetRecord): Promise<InsertAssetResult> {
    return this.database.transaction(async (transaction) => {
      const [drawing] = await transaction
        .select({ ownerUserId: drawings.ownerUserId })
        .from(drawings)
        .where(
          and(eq(drawings.id, asset.drawingId), isNull(drawings.deletedAt)),
        )
        .for("update");
      if (!drawing) return { status: "not-found" as const };

      if (drawing.ownerUserId !== asset.createdByUserId) {
        const [member] = await transaction
          .select({ role: drawingMembers.role })
          .from(drawingMembers)
          .where(
            and(
              eq(drawingMembers.drawingId, asset.drawingId),
              eq(drawingMembers.userId, asset.createdByUserId),
            ),
          );
        if (!member) return { status: "not-found" as const };
        if (member.role !== "editor") return { status: "forbidden" as const };
      }

      const [inserted] = await transaction
        .insert(drawingAssets)
        .values({
          drawingId: asset.drawingId,
          fileId: asset.fileId,
          storageKey: asset.storageKey,
          mimeType: asset.mimeType,
          byteSize: asset.byteSize,
          sha256: Buffer.from(asset.sha256, "hex"),
          fileVersion: asset.fileVersion,
          createdByUserId: asset.createdByUserId,
        })
        .onConflictDoNothing({
          target: [drawingAssets.drawingId, drawingAssets.fileId],
        })
        .returning();

      if (inserted) {
        return {
          status: "committed" as const,
          asset: mapAsset(inserted),
          created: true,
        };
      }

      const [existing] = await transaction
        .select()
        .from(drawingAssets)
        .where(
          and(
            eq(drawingAssets.drawingId, asset.drawingId),
            eq(drawingAssets.fileId, asset.fileId),
          ),
        )
        .for("update");
      if (!existing) {
        throw new Error("Asset insertion conflicted without an active record");
      }
      if (existing.deletedAt) {
        throw new AssetTombstoneConflictError();
      }

      return {
        status: "committed" as const,
        asset: mapAsset(existing),
        created: false,
      };
    });
  }
}
