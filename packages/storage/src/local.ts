import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  stat as fsStat,
  unlink,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";

import {
  InvalidStorageKeyError,
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

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TEMP_PREFIX = ".open-excalidraw-upload-";

export interface LocalStorageOptions {
  rootDirectory: string;
  /** Defaults to 50 MiB and can be reduced per write. */
  maxObjectBytes?: number;
  /** Set the permissions used for newly written objects. Defaults to 0o600. */
  fileMode?: number;
}

interface ResolvedObject {
  key: string;
  path: string;
  parent: string;
}

interface WrittenTemporaryObject {
  path: string;
  size: number;
  sha256: string;
}

/** Local, streaming object storage intended for a private persistent volume. */
export class LocalObjectStorage implements ObjectStorage {
  readonly #rootDirectory: string;
  readonly #maxObjectBytes: number;
  readonly #fileMode: number;

  public constructor(options: LocalStorageOptions) {
    if (!Number.isSafeInteger(options.maxObjectBytes ?? 50 * 1024 * 1024)) {
      throw new RangeError("maxObjectBytes must be a safe integer");
    }

    if ((options.maxObjectBytes ?? 50 * 1024 * 1024) <= 0) {
      throw new RangeError("maxObjectBytes must be greater than zero");
    }

    this.#rootDirectory = resolve(options.rootDirectory);
    this.#maxObjectBytes = options.maxObjectBytes ?? 50 * 1024 * 1024;
    this.#fileMode = options.fileMode ?? 0o600;
  }

  public async put(
    key: string,
    body: StorageBody,
    options: PutObjectOptions = {},
  ): Promise<PutObjectResult> {
    let temporary: WrittenTemporaryObject | undefined;

    try {
      const object = await this.#resolveObject(key, true);
      const limit = this.#effectiveLimit(options.maxBytes);
      const expectedSha256 = normalizeExpectedSha256(options.expectedSha256);
      const written = await this.#writeTemporary(object.parent, body, limit);
      temporary = written;

      if (expectedSha256 && written.sha256 !== expectedSha256) {
        throw new StorageIntegrityError();
      }

      try {
        // Hard-link publication is atomic and refuses to replace an existing
        // destination, including writes from other processes or instances.
        // The temporary object is guaranteed to be on the same filesystem.
        await link(written.path, object.path);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) {
          throw error;
        }

        const existing = await this.#statIfPresent(object);
        if (!existing) {
          throw error;
        }
        return await this.#resolveExistingWrite(object, written, existing);
      }

      const publishedStat = await fsStat(object.path);
      return {
        key,
        size: written.size,
        sha256: written.sha256,
        modifiedAt: publishedStat.mtime,
        created: true,
      };
    } catch (error) {
      if (error instanceof StorageError || error instanceof RangeError) {
        throw error;
      }

      throw new StorageIoError("write", { cause: error });
    } finally {
      if (temporary) {
        await rm(temporary.path, { force: true }).catch(() => undefined);
      }
    }
  }

  public async get(key: string): Promise<Readable> {
    try {
      const object = await this.#resolveObject(key, false);
      await this.#assertRegularFile(object.path, key);
      const handle = await open(
        object.path,
        constants.O_RDONLY | noFollowFlag(),
      );
      return handle.createReadStream({ autoClose: true });
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      if (isNodeError(error, "ENOENT")) {
        throw new StorageNotFoundError(key);
      }
      throw new StorageIoError("read", { cause: error });
    }
  }

  public async stat(key: string): Promise<StoredObject> {
    try {
      const object = await this.#resolveObject(key, false);
      const fileStat = await this.#assertRegularFile(object.path, key);
      const sha256 = await hashFile(object.path);
      return {
        key,
        size: fileStat.size,
        sha256,
        modifiedAt: fileStat.mtime,
      };
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      if (isNodeError(error, "ENOENT")) {
        throw new StorageNotFoundError(key);
      }
      throw new StorageIoError("stat", { cause: error });
    }
  }

  public async delete(key: string): Promise<DeleteObjectResult> {
    try {
      const object = await this.#resolveObject(key, false);
      await this.#assertRegularFile(object.path, key);
      await unlink(object.path);
      return { deleted: true };
    } catch (error) {
      if (
        error instanceof StorageNotFoundError ||
        isNodeError(error, "ENOENT")
      ) {
        return { deleted: false };
      }
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageIoError("delete", { cause: error });
    }
  }

  async #resolveObject(
    key: string,
    createParent: boolean,
  ): Promise<ResolvedObject> {
    validateStorageKey(key);
    await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 });
    const root = await realpath(this.#rootDirectory);
    const path = resolve(root, ...key.split("/"));
    const parent = dirname(path);

    assertPathInsideRoot(root, path);

    try {
      if (createParent) {
        await ensureSafeDirectoryChain(root, parent);
      } else {
        await assertDirectoryChainHasNoSymlinks(root, parent);
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new StorageNotFoundError(key);
      }
      throw error;
    }

    const realParent = await realpath(parent).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) {
        throw new StorageNotFoundError(key);
      }
      throw error;
    });
    assertPathInsideRoot(root, realParent, true);

    return { key, path, parent: realParent };
  }

  async #writeTemporary(
    parent: string,
    body: StorageBody,
    limit: number,
  ): Promise<WrittenTemporaryObject> {
    const path = resolve(parent, `${TEMP_PREFIX}${randomUUID()}`);
    const handle = await open(path, "wx", this.#fileMode);
    const hash = createHash("sha256");
    let size = 0;

    try {
      for await (const chunk of body) {
        if (!(chunk instanceof Uint8Array)) {
          throw new TypeError("Storage bodies must yield Uint8Array chunks");
        }

        size += chunk.byteLength;
        if (size > limit) {
          throw new StorageSizeLimitError(limit);
        }

        hash.update(chunk);
        await writeAll(handle, chunk);
      }

      await handle.sync();
      await handle.close();
      return { path, size, sha256: hash.digest("hex") };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(path, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #statIfPresent(object: ResolvedObject): Promise<Stats | undefined> {
    try {
      return await this.#assertRegularFile(object.path, object.key);
    } catch (error) {
      if (error instanceof StorageNotFoundError) {
        return undefined;
      }
      throw error;
    }
  }

  async #resolveExistingWrite(
    object: ResolvedObject,
    temporary: WrittenTemporaryObject,
    existing: Stats,
  ): Promise<PutObjectResult> {
    if (existing.size !== temporary.size) {
      throw new StorageConflictError(object.key);
    }

    const existingSha256 = await hashFile(object.path);
    if (existingSha256 !== temporary.sha256) {
      throw new StorageConflictError(object.key);
    }

    return {
      key: object.key,
      size: existing.size,
      sha256: existingSha256,
      modifiedAt: existing.mtime,
      created: false,
    };
  }

  async #assertRegularFile(path: string, key: string): Promise<Stats> {
    let fileStat: Stats;
    try {
      fileStat = await lstat(path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new StorageNotFoundError(key);
      }
      throw error;
    }

    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new InvalidStorageKeyError(
        "The storage key does not resolve to a regular file",
      );
    }
    return fileStat;
  }

  #effectiveLimit(requestedLimit?: number): number {
    if (requestedLimit === undefined) {
      return this.#maxObjectBytes;
    }
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
      throw new RangeError("maxBytes must be a positive safe integer");
    }
    return Math.min(requestedLimit, this.#maxObjectBytes);
  }
}

export function validateStorageKey(key: string): void {
  if (
    key.length === 0 ||
    key.length > 1024 ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.includes("\\") ||
    key.includes("\0")
  ) {
    throw new InvalidStorageKeyError();
  }

  const segments = key.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.length > 255,
    )
  ) {
    throw new InvalidStorageKeyError();
  }
}

function normalizeExpectedSha256(value?: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new StorageIntegrityError();
  }
  return normalized;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, constants.O_RDONLY | noFollowFlag());
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Uint8Array);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return hash.digest("hex");
}

async function ensureSafeDirectoryChain(
  root: string,
  parent: string,
): Promise<void> {
  const relativeParent = relative(root, parent);
  if (relativeParent === "") {
    return;
  }

  let current = root;
  for (const segment of relativeParent.split(sep)) {
    current = resolve(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
    }

    const entry = await lstat(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new InvalidStorageKeyError(
        "The storage key traverses an unsafe directory",
      );
    }
  }
}

async function assertDirectoryChainHasNoSymlinks(
  root: string,
  parent: string,
): Promise<void> {
  const relativeParent = relative(root, parent);
  if (relativeParent === "") {
    return;
  }

  let current = root;
  for (const segment of relativeParent.split(sep)) {
    current = resolve(current, segment);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new InvalidStorageKeyError(
        "The storage key traverses an unsafe directory",
      );
    }
  }
}

function assertPathInsideRoot(
  root: string,
  path: string,
  allowRoot = false,
): void {
  const relativePath = relative(root, path);
  if (
    (!allowRoot && relativePath === "") ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    resolve(root, relativePath) !== path
  ) {
    throw new InvalidStorageKeyError();
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk.subarray(offset));
    if (result.bytesWritten === 0) {
      throw new Error("The storage write made no progress");
    }
    offset += result.bytesWritten;
  }
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function noFollowFlag(): number {
  return "O_NOFOLLOW" in constants
    ? (constants as typeof constants & { O_NOFOLLOW: number }).O_NOFOLLOW
    : 0;
}

/** Test/operations helper: list abandoned temporary uploads under a root. */
export async function findLocalStorageTemporaryFiles(
  rootDirectory: string,
): Promise<string[]> {
  const found: string[] = [];

  async function walk(directory: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return;
      }
      throw error;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
        } else if (entry.name.startsWith(TEMP_PREFIX)) {
          found.push(path);
        }
      }),
    );
  }

  await walk(resolve(rootDirectory));
  return found.sort();
}
