import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  StorageConflictError,
  StorageError,
  StorageIntegrityError,
  StorageIoError,
  StorageNotFoundError,
  StorageSizeLimitError,
} from "./errors.js";
import type {
  DeleteObjectResult,
  ObjectStorage,
  PutObjectOptions,
  PutObjectResult,
  StorageBody,
  StoredObject,
} from "./types.js";
import {
  SHA256_PATTERN,
  effectiveByteLimit,
  normalizeExpectedSha256,
  validateMaxObjectBytes,
  validateStorageKey,
} from "./validate.js";

export interface S3StorageOptions {
  bucket: string;
  /**
   * Required for AWS S3, where SigV4 signing needs a concrete region.
   * Defaults to "auto" (the value Cloudflare R2 documents) only when a
   * custom endpoint is configured.
   */
  region?: string;
  /** Custom endpoint for S3-compatible providers. Omit for AWS S3. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style bucket URLs; required by MinIO. */
  forcePathStyle?: boolean;
  /** Defaults to 50 MiB and can be reduced per write. */
  maxObjectBytes?: number;
}

interface BufferedBody {
  buffer: Buffer;
  size: number;
  sha256: string;
}

/**
 * S3-compatible object storage (AWS S3, Cloudflare R2, MinIO, Backblaze B2,
 * DigitalOcean Spaces, Wasabi, ...) selected via a configurable endpoint.
 */
export class S3ObjectStorage implements ObjectStorage {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #maxObjectBytes: number;
  /** Flips false on the first 501 so providers without conditional PUT
   * (Backblaze B2) pay one failed request per process, not per call. */
  #conditionalPutSupported = true;

  public constructor(options: S3StorageOptions) {
    this.#maxObjectBytes = validateMaxObjectBytes(options.maxObjectBytes);
    this.#bucket = options.bucket;
    const region = options.region?.trim();
    if (!region && !options.endpoint) {
      throw new Error(
        "region is required when no custom endpoint is configured",
      );
    }
    this.#client = new S3Client({
      region: region || "auto",
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle ?? false,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      // Newer SDK defaults inject CRC32 checksum headers that several
      // S3-compatible providers (Backblaze B2, older MinIO) reject.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  public async put(
    key: string,
    body: StorageBody,
    options: PutObjectOptions = {},
  ): Promise<PutObjectResult> {
    validateStorageKey(key);
    const limit = effectiveByteLimit(options.maxBytes, this.#maxObjectBytes);
    const expectedSha256 = normalizeExpectedSha256(options.expectedSha256);

    try {
      const written = await bufferBody(body, limit);
      if (expectedSha256 && written.sha256 !== expectedSha256) {
        throw new StorageIntegrityError();
      }

      if (!this.#conditionalPutSupported) {
        return await this.#putWithoutCondition(key, written);
      }

      try {
        return await this.#putIfAbsent(key, written);
      } catch (error) {
        if (statusOf(error) === 501) {
          this.#conditionalPutSupported = false;
          return await this.#putWithoutCondition(key, written);
        }
        throw error;
      }
    } catch (error) {
      throw mapError("write", error);
    }
  }

  public async get(key: string): Promise<Readable> {
    validateStorageKey(key);
    try {
      const response = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      return response.Body as Readable;
    } catch (error) {
      if (isNotFound(error)) {
        throw new StorageNotFoundError(key);
      }
      throw mapError("read", error);
    }
  }

  public async stat(key: string): Promise<StoredObject> {
    validateStorageKey(key);
    try {
      const response = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      const metadataSha256 = response.Metadata?.["sha256"];
      const sha256 =
        metadataSha256 && SHA256_PATTERN.test(metadataSha256)
          ? metadataSha256
          : await this.#hashRemote(key);
      return {
        key,
        size: response.ContentLength ?? 0,
        sha256,
        modifiedAt: response.LastModified ?? new Date(0),
      };
    } catch (error) {
      if (isNotFound(error)) {
        throw new StorageNotFoundError(key);
      }
      throw mapError("stat", error);
    }
  }

  public async delete(key: string): Promise<DeleteObjectResult> {
    validateStorageKey(key);
    try {
      await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
    } catch (error) {
      if (isNotFound(error)) {
        return { deleted: false };
      }
      throw mapError("delete", error);
    }

    try {
      await this.#client.send(
        new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      return { deleted: true };
    } catch (error) {
      throw mapError("delete", error);
    }
  }

  /** Atomic create via conditional PUT (AWS S3, R2, MinIO 2024-09+). */
  async #putIfAbsent(
    key: string,
    written: BufferedBody,
    retry = true,
  ): Promise<PutObjectResult> {
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: written.buffer,
          ContentLength: written.size,
          IfNoneMatch: "*",
          Metadata: { sha256: written.sha256 },
        }),
      );
    } catch (error) {
      // AWS reports concurrent conditional PUTs as retryable 409s.
      const status = statusOf(error);
      if (status !== 412 && status !== 409) {
        throw error;
      }

      let existing: StoredObject;
      try {
        existing = await this.stat(key);
      } catch (statError) {
        if (statError instanceof StorageNotFoundError && retry) {
          // The competing object vanished between PUT and stat.
          return this.#putIfAbsent(key, written, false);
        }
        throw statError;
      }
      return resolveExistingWrite(key, written, existing);
    }

    return {
      key,
      size: written.size,
      sha256: written.sha256,
      // PutObject responses carry no LastModified; callers of put() never
      // read modifiedAt, so a local timestamp avoids a HeadObject round trip.
      modifiedAt: new Date(),
      created: true,
    };
  }

  /**
   * ponytail: best-effort conflict detection for providers without
   * conditional PUT (Backblaze B2) — a concurrent-write race can go
   * undetected; the upgrade path is provider-native conditional APIs.
   */
  async #putWithoutCondition(
    key: string,
    written: BufferedBody,
  ): Promise<PutObjectResult> {
    let existing: StoredObject | undefined;
    try {
      existing = await this.stat(key);
    } catch (error) {
      if (!(error instanceof StorageNotFoundError)) {
        throw error;
      }
    }
    if (existing) {
      return resolveExistingWrite(key, written, existing);
    }

    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: written.buffer,
        ContentLength: written.size,
        Metadata: { sha256: written.sha256 },
      }),
    );
    return {
      key,
      size: written.size,
      sha256: written.sha256,
      modifiedAt: new Date(),
      created: true,
    };
  }

  /** Hash an object missing sha256 metadata (written by another client). */
  async #hashRemote(key: string): Promise<string> {
    const body = await this.get(key);
    const hash = createHash("sha256");
    for await (const chunk of body) {
      hash.update(chunk as Uint8Array);
    }
    return hash.digest("hex");
  }
}

async function bufferBody(
  body: StorageBody,
  limit: number,
): Promise<BufferedBody> {
  // ponytail: buffered in memory — the asset service caps uploads at 4 MiB
  // and the driver at 50 MiB; switch to multipart streaming if that grows.
  const chunks: Uint8Array[] = [];
  const hash = createHash("sha256");
  let size = 0;

  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError("Storage bodies must yield Uint8Array chunks");
    }
    size += chunk.byteLength;
    if (size > limit) {
      throw new StorageSizeLimitError(limit);
    }
    hash.update(chunk);
    chunks.push(chunk);
  }

  return { buffer: Buffer.concat(chunks), size, sha256: hash.digest("hex") };
}

function resolveExistingWrite(
  key: string,
  written: BufferedBody,
  existing: StoredObject,
): PutObjectResult {
  if (existing.size !== written.size || existing.sha256 !== written.sha256) {
    throw new StorageConflictError(key);
  }
  return { ...existing, created: false };
}

function statusOf(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "$metadata" in error &&
    typeof (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode === "number"
  ) {
    return (error as { $metadata: { httpStatusCode: number } }).$metadata
      .httpStatusCode;
  }
  return undefined;
}

function isNotFound(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "NoSuchKey" || error.name === "NotFound") {
      return true;
    }
  }
  return statusOf(error) === 404;
}

function mapError(
  operation: "write" | "read" | "stat" | "delete",
  error: unknown,
): Error {
  if (
    error instanceof StorageError ||
    error instanceof RangeError ||
    error instanceof TypeError
  ) {
    return error;
  }
  return new StorageIoError(operation, { cause: error });
}
