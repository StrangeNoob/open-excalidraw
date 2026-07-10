import {
  drawingAssets,
  type Database,
  type DrawingAsset,
} from "@open-excalidraw/database";

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
    const [inserted] = await this.database
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
      return { asset: mapAsset(inserted), created: true };
    }

    const existing = await this.database.query.drawingAssets.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.drawingId, asset.drawingId),
          eq(table.fileId, asset.fileId),
        ),
    });
    if (!existing) {
      throw new Error("Asset insertion conflicted without an active record");
    }
    if (existing.deletedAt) {
      throw new AssetTombstoneConflictError();
    }

    return { asset: mapAsset(existing), created: false };
  }
}
