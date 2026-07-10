import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InvalidStorageKeyError,
  StorageConflictError,
  StorageIntegrityError,
  StorageIoError,
  StorageNotFoundError,
  StorageSizeLimitError,
} from "../src/errors.js";
import {
  findLocalStorageTemporaryFiles,
  LocalObjectStorage,
} from "../src/local.js";

describe("LocalObjectStorage", () => {
  let root: string;
  let storage: LocalObjectStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "open-excalidraw-storage-"));
    storage = new LocalObjectStorage({
      rootDirectory: root,
      maxObjectBytes: 64,
    });
  });

  it("streams put, get, stat, and delete operations", async () => {
    const chunks = [bytes("streamed "), bytes("asset")];
    const expected = Buffer.concat(chunks);

    const put = await storage.put("drawings/one/image.bin", body(...chunks));

    expect(put).toMatchObject({
      key: "drawings/one/image.bin",
      size: expected.byteLength,
      sha256: sha256(expected),
      created: true,
    });
    expect(await consume(await storage.get("drawings/one/image.bin"))).toEqual(
      expected,
    );
    expect(await storage.stat("drawings/one/image.bin")).toMatchObject({
      size: expected.byteLength,
      sha256: sha256(expected),
    });
    expect(await storage.delete("drawings/one/image.bin")).toEqual({
      deleted: true,
    });
    expect(await storage.delete("drawings/one/image.bin")).toEqual({
      deleted: false,
    });
    await expect(storage.get("drawings/one/image.bin")).rejects.toBeInstanceOf(
      StorageNotFoundError,
    );
  });

  it("publishes only after the streamed temporary file is complete", async () => {
    let release: (() => void) | undefined;
    let firstChunkWritten: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observedFirstChunk = new Promise<void>((resolve) => {
      firstChunkWritten = resolve;
    });

    async function* delayedBody(): AsyncGenerator<Uint8Array> {
      yield bytes("first-");
      firstChunkWritten?.();
      await gate;
      yield bytes("second");
    }

    const pendingPut = storage.put("atomic/object.bin", delayedBody());
    await observedFirstChunk;

    await vi.waitFor(async () => {
      expect(await findLocalStorageTemporaryFiles(root)).toHaveLength(1);
    });
    await expect(storage.stat("atomic/object.bin")).rejects.toBeInstanceOf(
      StorageNotFoundError,
    );

    release?.();
    await expect(pendingPut).resolves.toMatchObject({
      created: true,
      size: 12,
    });
    expect(await readFile(join(root, "atomic/object.bin"), "utf8")).toBe(
      "first-second",
    );
    expect(await findLocalStorageTemporaryFiles(root)).toEqual([]);
  });

  it("treats identical retries as idempotent and rejects different bytes", async () => {
    const first = await storage.put("same-key", body(bytes("same")));
    const inode = (await stat(join(root, "same-key"))).ino;

    const retry = await storage.put("same-key", body(bytes("same")));

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect((await stat(join(root, "same-key"))).ino).toBe(inode);
    await expect(
      storage.put("same-key", body(bytes("different"))),
    ).rejects.toBeInstanceOf(StorageConflictError);
    expect(await readFile(join(root, "same-key"), "utf8")).toBe("same");
  });

  it("atomically rejects cross-instance concurrent writes with different bytes", async () => {
    const stores = Array.from(
      { length: 24 },
      () =>
        new LocalObjectStorage({
          rootDirectory: root,
          maxObjectBytes: 64,
        }),
    );
    const values = stores.map(
      (_, index) => `writer-${String(index).padStart(2, "0")}`,
    );
    const results = await Promise.allSettled(
      stores.map((store, index) =>
        store.put("cross-instance-race", body(bytes(values[index] ?? ""))),
      ),
    );

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof StorageConflictError,
      ),
    ).toHaveLength(stores.length - 1);
    expect(values).toContain(
      await readFile(join(root, "cross-instance-race"), "utf8"),
    );
    expect(await findLocalStorageTemporaryFiles(root)).toEqual([]);
  });

  it("makes cross-instance concurrent identical writes idempotent", async () => {
    const stores = Array.from(
      { length: 24 },
      () =>
        new LocalObjectStorage({
          rootDirectory: root,
          maxObjectBytes: 64,
        }),
    );

    const results = await Promise.all(
      stores.map((store) =>
        store.put("cross-instance-identical", body(bytes("identical"))),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(
      stores.length - 1,
    );
    expect(new Set(results.map((result) => result.sha256))).toEqual(
      new Set([sha256(bytes("identical"))]),
    );
    expect(await readFile(join(root, "cross-instance-identical"), "utf8")).toBe(
      "identical",
    );
    expect(await findLocalStorageTemporaryFiles(root)).toEqual([]);
  });

  it.each([
    "",
    "/absolute",
    "../outside",
    "nested/../../outside",
    "nested//object",
    "nested/./object",
    "nested\\object",
    "trailing/",
  ])("rejects unsafe key %j", async (key) => {
    await expect(storage.put(key, body(bytes("x")))).rejects.toBeInstanceOf(
      InvalidStorageKeyError,
    );
  });

  it("preserves invalid-key errors across every operation", async () => {
    await Promise.all([
      expect(storage.put("../unsafe", body(bytes("x")))).rejects.toBeInstanceOf(
        InvalidStorageKeyError,
      ),
      expect(storage.get("../unsafe")).rejects.toBeInstanceOf(
        InvalidStorageKeyError,
      ),
      expect(storage.stat("../unsafe")).rejects.toBeInstanceOf(
        InvalidStorageKeyError,
      ),
      expect(storage.delete("../unsafe")).rejects.toBeInstanceOf(
        InvalidStorageKeyError,
      ),
    ]);
  });

  it("rejects a symbolic-link directory that escapes the storage root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "open-excalidraw-outside-"));
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, "linked"), "dir");

    await expect(
      storage.put("linked/nested/object", body(bytes("escape"))),
    ).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(access(join(outside, "nested"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes a partial temporary file when the input stream fails", async () => {
    async function* interrupted(): AsyncGenerator<Uint8Array> {
      yield bytes("partial");
      await Promise.resolve();
      throw new Error("simulated source interruption");
    }

    await expect(
      storage.put("broken/object", interrupted()),
    ).rejects.toBeInstanceOf(StorageIoError);
    await expect(storage.stat("broken/object")).rejects.toBeInstanceOf(
      StorageNotFoundError,
    );
    expect(await findLocalStorageTemporaryFiles(root)).toEqual([]);
  });

  it("enforces byte and expected-digest integrity limits", async () => {
    await expect(
      storage.put("too-large", body(bytes("12345")), { maxBytes: 4 }),
    ).rejects.toBeInstanceOf(StorageSizeLimitError);
    await expect(
      storage.put("bad-digest", body(bytes("data")), {
        expectedSha256: "0".repeat(64),
      }),
    ).rejects.toBeInstanceOf(StorageIntegrityError);
    expect(await findLocalStorageTemporaryFiles(root)).toEqual([]);
  });

  it("maps root setup failures to typed I/O errors for every operation", async () => {
    const parent = await mkdtemp(join(tmpdir(), "open-excalidraw-root-file-"));
    const rootFile = join(parent, "not-a-directory");
    await writeFile(rootFile, "file");
    const brokenStorage = new LocalObjectStorage({ rootDirectory: rootFile });

    const operations = [
      brokenStorage.put("object", body(bytes("data"))),
      brokenStorage.get("object"),
      brokenStorage.stat("object"),
      brokenStorage.delete("object"),
    ];

    await Promise.all(
      operations.map((operation) =>
        expect(operation).rejects.toMatchObject({
          code: "STORAGE_IO_ERROR",
        }),
      ),
    );
  });
});

function bytes(value: string): Buffer {
  return Buffer.from(value);
}

async function* body(...chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  yield* chunks;
}

async function consume(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk)
          : Buffer.from(chunk),
    );
  }
  return Buffer.concat(chunks);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
