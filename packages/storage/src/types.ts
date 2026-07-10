import type { Readable } from "node:stream";

/**
 * A storage key is a relative, slash-delimited object name. Implementations
 * must reject absolute paths, dot segments, backslashes, and symbolic-link
 * traversal rather than normalizing unsafe input.
 */
export type StorageKey = string;

export type StorageBody = AsyncIterable<Uint8Array>;

export interface PutObjectOptions {
  /** Optional SHA-256 hex digest supplied by the caller for integrity checks. */
  expectedSha256?: string;
  /** Per-call limit. The implementation-wide limit still applies. */
  maxBytes?: number;
}

export interface StoredObject {
  key: StorageKey;
  size: number;
  sha256: string;
  modifiedAt: Date;
}

export interface PutObjectResult extends StoredObject {
  /** False when an identical object already occupied the key. */
  created: boolean;
}

export interface DeleteObjectResult {
  deleted: boolean;
}

export interface ObjectStorage {
  put(
    key: StorageKey,
    body: StorageBody,
    options?: PutObjectOptions,
  ): Promise<PutObjectResult>;
  get(key: StorageKey): Promise<Readable>;
  stat(key: StorageKey): Promise<StoredObject>;
  delete(key: StorageKey): Promise<DeleteObjectResult>;
}
