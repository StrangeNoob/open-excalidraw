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
  // Nullable since migration 0011: the creator's account may have been
  // deleted, which nulls this attribution (ON DELETE SET NULL).
  createdByUserId: string | null;
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

export type InsertAssetResult =
  | { status: "committed"; asset: AssetRecord; created: boolean }
  | { status: "not-found" }
  | { status: "forbidden" };

/**
 * Everything needed to enforce a per-user storage quota for one upload, keyed
 * by the drawing being uploaded into. Bytes are charged to the drawing's owner,
 * so an editor uploading into a shared drawing spends the owner's quota.
 */
export interface QuotaContext {
  ownerUserId: string;
  /**
   * Active (deleted_at IS NULL) asset bytes across every drawing the owner
   * owns, including soft-deleted drawings — bytes are freed only on purge.
   */
  usedBytes: number;
  /** The owner's per-user override, or null to fall back to the global setting. */
  ownerQuotaOverrideBytes: number | null;
  /** The instance-wide app_settings default, or null to fall back to the env. */
  globalQuotaBytes: number | null;
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
  /**
   * Resolves the owner, their current usage, and the configured quota tiers for
   * the drawing in one query. Null when the drawing does not exist.
   */
  getQuotaContext(drawingId: string): Promise<QuotaContext | null>;
  /** Sets or clears drawings.thumbnail_updated_at; false if drawing missing/deleted. */
  setThumbnailUpdatedAt(drawingId: string, when: Date | null): Promise<boolean>;
  /**
   * Rechecks upload authorization while holding the drawing lock, then commits
   * metadata in the same transaction. Implementations must acquire the drawing
   * lock before any asset row lock.
   */
  insertAsset(asset: NewAssetRecord): Promise<InsertAssetResult>;
}
