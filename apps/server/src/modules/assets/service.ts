import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import {
  StorageConflictError,
  StorageIntegrityError,
  StorageNotFoundError,
  StorageSizeLimitError,
  type ObjectStorage,
} from "@open-excalidraw/storage";
import { fileIdSchema } from "@open-excalidraw/contracts";
import { fileTypeFromBuffer } from "file-type";

import {
  assetError,
  AssetError,
  AssetTombstoneConflictError,
} from "./errors.js";
import type { AssetIdentity, AssetRecord, AssetRepository } from "./types.js";

export const DEFAULT_MAX_ASSET_BYTES = 4 * 1024 * 1024;
export const ASSET_CHECKSUM_HEADER = "x-content-sha256";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ALLOWED_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jfif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
  "image/x-icon",
]);

export interface UploadAssetInput {
  identity: AssetIdentity;
  drawingId: string;
  fileId: string;
  declaredMimeType: string;
  expectedSha256: string;
  fileVersion: number | null;
  bytes: Buffer;
}

export interface UploadAssetResult {
  asset: AssetRecord;
  created: boolean;
}

export interface DownloadAssetInput {
  identity: AssetIdentity;
  drawingId: string;
  fileId: string;
}

export interface DownloadAssetResult {
  asset: AssetRecord;
  body: Readable;
}

export interface AssetServiceOptions {
  repository: AssetRepository;
  storage: ObjectStorage;
  maxAssetBytes?: number;
}

export class AssetService {
  readonly #repository: AssetRepository;
  readonly #storage: ObjectStorage;
  readonly #maxAssetBytes: number;

  public constructor(options: AssetServiceOptions) {
    this.#repository = options.repository;
    this.#storage = options.storage;
    this.#maxAssetBytes = options.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES;

    if (
      !Number.isSafeInteger(this.#maxAssetBytes) ||
      this.#maxAssetBytes <= 0
    ) {
      throw new RangeError("maxAssetBytes must be a positive safe integer");
    }
  }

  public get maxAssetBytes() {
    return this.#maxAssetBytes;
  }

  public async upload(input: UploadAssetInput): Promise<UploadAssetResult> {
    validateIdentifiers(input.drawingId, input.fileId);
    const role = await this.#repository.getDrawingAccess(
      input.drawingId,
      input.identity.userId,
    );
    if (!role) {
      throw assetError(
        404,
        "DRAWING_NOT_FOUND",
        "Drawing not found",
        "The drawing is unavailable.",
      );
    }
    if (role === "viewer") {
      throw assetError(
        403,
        "ASSET_UPLOAD_FORBIDDEN",
        "Asset upload forbidden",
        "Viewer access does not allow asset uploads.",
      );
    }

    if (input.bytes.byteLength === 0) {
      throw assetError(
        400,
        "EMPTY_ASSET",
        "Empty asset",
        "An asset must contain at least one byte.",
      );
    }
    if (input.bytes.byteLength > this.#maxAssetBytes) {
      throw tooLargeError(this.#maxAssetBytes);
    }

    const expectedSha256 = normalizeChecksum(input.expectedSha256);
    const actualSha256 = createHash("sha256").update(input.bytes).digest("hex");
    if (actualSha256 !== expectedSha256) {
      throw assetError(
        422,
        "ASSET_CHECKSUM_MISMATCH",
        "Asset checksum mismatch",
        "The request checksum does not match the uploaded bytes.",
      );
    }

    const mimeType = normalizeMimeType(input.declaredMimeType);
    await assertMimeMatchesBytes(mimeType, input.bytes);

    let existing: AssetRecord | null;
    try {
      existing = await this.#repository.findAsset(
        input.drawingId,
        input.fileId,
      );
    } catch (error) {
      throw mapStorageError(error, this.#maxAssetBytes);
    }
    if (existing) {
      if (existing.sha256 !== actualSha256) {
        throw assetConflict();
      }
      return { asset: existing, created: false };
    }

    const storageKey = assetStorageKey(input.drawingId, input.fileId);
    let blobCreated = false;

    try {
      const stored = await this.#storage.put(
        storageKey,
        bufferBody(input.bytes),
        {
          expectedSha256: actualSha256,
          maxBytes: this.#maxAssetBytes,
        },
      );
      blobCreated = stored.created;

      const inserted = await this.#repository.insertAsset({
        drawingId: input.drawingId,
        fileId: input.fileId,
        storageKey,
        mimeType,
        byteSize: stored.size,
        sha256: stored.sha256,
        fileVersion: input.fileVersion,
        createdByUserId: input.identity.userId,
      });

      if (inserted.status === "not-found") {
        throw assetError(
          404,
          "DRAWING_NOT_FOUND",
          "Drawing not found",
          "The drawing is unavailable.",
        );
      }
      if (inserted.status === "forbidden") {
        throw assetError(
          403,
          "ASSET_UPLOAD_FORBIDDEN",
          "Asset upload forbidden",
          "Viewer access does not allow asset uploads.",
        );
      }

      if (inserted.asset.sha256 !== actualSha256) {
        throw assetConflict();
      }

      return { asset: inserted.asset, created: inserted.created };
    } catch (error) {
      if (blobCreated) {
        let committed: AssetRecord | null;
        try {
          committed = await this.#repository.findAsset(
            input.drawingId,
            input.fileId,
          );
        } catch {
          // The database outcome is ambiguous. Retain the complete blob so a
          // committed metadata row can never be left pointing at deleted data.
          throw mapStorageError(error, this.#maxAssetBytes);
        }

        if (committed) {
          if (committed.sha256 === actualSha256) {
            return { asset: committed, created: false };
          }
          throw assetConflict();
        }

        // A concurrent identical uploader may already be preparing metadata
        // for this complete blob. Synchronous deletion could make that future
        // row point at missing bytes, so unreferenced blobs are left for the
        // scheduled orphan cleanup job.
      }
      throw mapStorageError(error, this.#maxAssetBytes);
    }
  }

  public async download(
    input: DownloadAssetInput,
  ): Promise<DownloadAssetResult> {
    validateIdentifiers(input.drawingId, input.fileId);
    const role = await this.#repository.getDrawingAccess(
      input.drawingId,
      input.identity.userId,
    );
    if (!role) {
      throw assetError(
        404,
        "ASSET_NOT_FOUND",
        "Asset not found",
        "The asset is unavailable.",
      );
    }

    return this.#streamAsset(input.drawingId, input.fileId);
  }

  /**
   * Streams an asset without a per-user role check. The caller is responsible
   * for authorizing access, e.g. by resolving an active share-link token to
   * the drawing ID.
   */
  public async downloadShared(input: {
    drawingId: string;
    fileId: string;
  }): Promise<DownloadAssetResult> {
    validateIdentifiers(input.drawingId, input.fileId);
    return this.#streamAsset(input.drawingId, input.fileId);
  }

  async #streamAsset(
    drawingId: string,
    fileId: string,
  ): Promise<DownloadAssetResult> {
    const asset = await this.#repository.findAsset(drawingId, fileId);
    if (!asset) {
      throw assetError(
        404,
        "ASSET_NOT_FOUND",
        "Asset not found",
        "The asset is unavailable.",
      );
    }

    try {
      return { asset, body: await this.#storage.get(asset.storageKey) };
    } catch (error) {
      if (error instanceof StorageNotFoundError) {
        throw assetError(
          503,
          "ASSET_BLOB_UNAVAILABLE",
          "Asset temporarily unavailable",
          "The asset bytes are temporarily unavailable.",
          { cause: error },
        );
      }
      throw mapStorageError(error, this.#maxAssetBytes);
    }
  }
}

export function assetStorageKey(drawingId: string, fileId: string) {
  validateIdentifiers(drawingId, fileId);
  return `drawings/${drawingId}/assets/${fileId}`;
}

export function normalizeChecksum(value: string) {
  const checksum = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(checksum)) {
    throw assetError(
      400,
      "INVALID_ASSET_CHECKSUM",
      "Invalid asset checksum",
      `${ASSET_CHECKSUM_HEADER} must be a 64-character SHA-256 hex digest.`,
    );
  }
  return checksum;
}

function validateIdentifiers(drawingId: string, fileId: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      drawingId,
    )
  ) {
    throw assetError(
      400,
      "INVALID_DRAWING_ID",
      "Invalid drawing ID",
      "drawingId must be a UUID.",
    );
  }
  if (!fileIdSchema.safeParse(fileId).success) {
    throw assetError(
      400,
      "INVALID_FILE_ID",
      "Invalid file ID",
      "fileId may contain only letters, digits, underscores, and hyphens.",
    );
  }
}

function normalizeMimeType(value: string) {
  const mimeType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw assetError(
      415,
      "UNSUPPORTED_ASSET_TYPE",
      "Unsupported asset type",
      "The Content-Type is not a supported Excalidraw image format.",
    );
  }
  return mimeType;
}

async function assertMimeMatchesBytes(mimeType: string, bytes: Buffer) {
  const detected = await fileTypeFromBuffer(bytes);
  // file-type intentionally reports SVG as generic XML. Recognize the SVG
  // root explicitly while still requiring its declared image MIME type.
  const detectedMime = looksLikeSvg(bytes)
    ? "image/svg+xml"
    : (detected?.mime ?? null);

  const matches =
    detectedMime === mimeType ||
    (detectedMime === "image/jpeg" && mimeType === "image/jfif");
  if (!matches) {
    throw assetError(
      415,
      "ASSET_MIME_MISMATCH",
      "Asset type mismatch",
      "The declared Content-Type does not match the uploaded bytes.",
    );
  }
}

function looksLikeSvg(bytes: Buffer) {
  const prefix = bytes.subarray(0, 16 * 1024).toString("utf8");
  const withoutBom = prefix.replace(/^\uFEFF/, "").trimStart();
  return /^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(
    withoutBom,
  );
}

function bufferBody(bytes: Buffer) {
  return Readable.from([bytes]);
}

function tooLargeError(limit: number) {
  return assetError(
    413,
    "ASSET_TOO_LARGE",
    "Asset too large",
    `Assets may not exceed ${limit} bytes.`,
  );
}

function assetConflict() {
  return assetError(
    409,
    "ASSET_FILE_ID_CONFLICT",
    "Asset file ID conflict",
    "The file ID already belongs to different asset bytes.",
  );
}

function mapStorageError(error: unknown, maxAssetBytes: number): AssetError {
  if (error instanceof AssetError) {
    return error;
  }
  if (error instanceof StorageConflictError) {
    return assetConflict();
  }
  if (error instanceof AssetTombstoneConflictError) {
    return assetConflict();
  }
  if (error instanceof StorageSizeLimitError) {
    return tooLargeError(maxAssetBytes);
  }
  if (error instanceof StorageIntegrityError) {
    return assetError(
      422,
      "ASSET_CHECKSUM_MISMATCH",
      "Asset checksum mismatch",
      "The stored bytes do not match the request checksum.",
      { cause: error },
    );
  }

  return assetError(
    503,
    "ASSET_STORAGE_UNAVAILABLE",
    "Asset storage unavailable",
    "Asset storage is temporarily unavailable.",
    { cause: error },
  );
}
