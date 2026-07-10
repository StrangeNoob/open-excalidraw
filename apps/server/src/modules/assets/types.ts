import type { Request } from "express";

export type AssetAccessRole = "owner" | "editor" | "viewer";

export interface AssetIdentity {
  userId: string;
}

export type AssetIdentityResolver = (
  request: Request,
) => Promise<AssetIdentity | null>;

export interface AssetRecord {
  id: string;
  drawingId: string;
  fileId: string;
  storageKey: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  fileVersion: number | null;
  createdByUserId: string;
  createdAt: Date;
}

export interface NewAssetRecord {
  drawingId: string;
  fileId: string;
  storageKey: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  fileVersion: number | null;
  createdByUserId: string;
}

export interface InsertAssetResult {
  asset: AssetRecord;
  created: boolean;
}

/**
 * Database boundary for the asset module. Implementations must scope asset
 * reads to both drawingId and fileId and ignore soft-deleted records.
 */
export interface AssetRepository {
  getDrawingAccess(
    drawingId: string,
    userId: string,
  ): Promise<AssetAccessRole | null>;
  findAsset(drawingId: string, fileId: string): Promise<AssetRecord | null>;
  insertAsset(asset: NewAssetRecord): Promise<InsertAssetResult>;
}
