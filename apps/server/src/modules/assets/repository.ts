import {
  drawingAssets,
  drawingMembers,
  drawings,
  type Database,
  type DrawingAsset,
} from "@open-excalidraw/database";
import { and, eq, isNull } from "drizzle-orm";

import { AssetTombstoneConflictError } from "./errors.js";
import type {
  AssetAccessRole,
  AssetRecord,
  AssetRepository,
  InsertAssetResult,
  NewAssetRecord,
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
