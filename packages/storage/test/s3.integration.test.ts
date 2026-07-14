import { createHash } from "node:crypto";

import {
  CreateBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";

import {
  S3ObjectStorage,
  StorageConflictError,
  StorageIntegrityError,
  StorageNotFoundError,
  StorageSizeLimitError,
} from "../src/index.js";

/**
 * Behavioral parity suite for the S3 driver, run against MinIO. MinIO
 * supports conditional PUT (IfNoneMatch), so the Backblaze B2 501 fallback
 * path in S3ObjectStorage has no automated coverage here — mock the SDK if
 * that path ever regresses.
 */

const MINIO_IMAGE = "minio/minio:RELEASE.2025-09-07T16-13-09Z";
const ACCESS_KEY = "integration-access";
const SECRET_KEY = "integration-secret";
const BUCKET = "assets";

let container: StartedTestContainer;
let endpoint: string;
let sequence = 0;

function uniqueKey(name = "object"): string {
  sequence += 1;
  return `case-${sequence}/${name}`;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function body(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* generate() {
    await Promise.resolve();
    yield* chunks;
  })();
}

function sha256(...chunks: Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function rawClient(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

function storage(maxObjectBytes?: number): S3ObjectStorage {
  return new S3ObjectStorage({
    bucket: BUCKET,
    endpoint,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    forcePathStyle: true,
    ...(maxObjectBytes === undefined ? {} : { maxObjectBytes }),
  });
}

beforeAll(async () => {
  container = await new GenericContainer(MINIO_IMAGE)
    .withCommand(["server", "/data"])
    .withEnvironment({
      MINIO_ROOT_USER: ACCESS_KEY,
      MINIO_ROOT_PASSWORD: SECRET_KEY,
    })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp("/minio/health/live", 9000))
    .start();
  endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  await rawClient().send(new CreateBucketCommand({ Bucket: BUCKET }));
});

afterAll(async () => {
  await container?.stop();
});

describe("S3ObjectStorage against MinIO", () => {
  it("round-trips put, get, stat, and delete", async () => {
    const instance = storage();
    const key = uniqueKey();
    const payload = bytes("hello object storage");

    const written = await instance.put(key, body(payload), {
      expectedSha256: sha256(payload),
    });
    expect(written).toMatchObject({
      key,
      size: payload.byteLength,
      sha256: sha256(payload),
      created: true,
    });

    const fetched = await readAll(await instance.get(key));
    expect(new Uint8Array(fetched)).toEqual(payload);

    const statted = await instance.stat(key);
    expect(statted).toMatchObject({
      key,
      size: payload.byteLength,
      sha256: sha256(payload),
    });
    expect(statted.modifiedAt.getTime()).toBeGreaterThan(0);

    await expect(instance.delete(key)).resolves.toEqual({ deleted: true });
    await expect(instance.delete(key)).resolves.toEqual({ deleted: false });
    await expect(instance.get(key)).rejects.toBeInstanceOf(
      StorageNotFoundError,
    );
    await expect(instance.stat(key)).rejects.toBeInstanceOf(
      StorageNotFoundError,
    );
  });

  it("treats identical retries as idempotent", async () => {
    const instance = storage();
    const key = uniqueKey();
    const payload = bytes("same bytes");

    const first = await instance.put(key, body(payload));
    const second = await instance.put(key, body(payload));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.sha256).toBe(first.sha256);
    expect(second.size).toBe(first.size);
  });

  it("rejects different bytes for an occupied key", async () => {
    const instance = storage();
    const key = uniqueKey();

    await instance.put(key, body(bytes("original")));
    await expect(
      instance.put(key, body(bytes("different"))),
    ).rejects.toBeInstanceOf(StorageConflictError);
  });

  it("makes concurrent identical writes idempotent", async () => {
    const key = uniqueKey();
    const payload = bytes("concurrent identical");

    const results = await Promise.all(
      Array.from({ length: 8 }, () => storage().put(key, body(payload))),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    for (const result of results) {
      expect(result.sha256).toBe(sha256(payload));
    }
  });

  it("lets exactly one concurrent conflicting write win", async () => {
    const key = uniqueKey();

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        storage().put(key, body(bytes(`writer-${index}`))),
      ),
    );

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(StorageConflictError);
      }
    }
  });

  it("enforces byte limits and checksum integrity", async () => {
    const instance = storage(8);
    const key = uniqueKey();

    await expect(
      instance.put(key, body(bytes("far too large for the limit"))),
    ).rejects.toBeInstanceOf(StorageSizeLimitError);
    await expect(
      instance.put(key, body(bytes("abc")), { maxBytes: 2 }),
    ).rejects.toBeInstanceOf(StorageSizeLimitError);
    await expect(
      instance.put(key, body(bytes("abc")), {
        expectedSha256: sha256(bytes("other")),
      }),
    ).rejects.toBeInstanceOf(StorageIntegrityError);
    // No partial object may survive a rejected write.
    await expect(instance.stat(key)).rejects.toBeInstanceOf(
      StorageNotFoundError,
    );
  });

  it("stores and round-trips a zero-byte object", async () => {
    const instance = storage();
    const key = uniqueKey("empty");

    const written = await instance.put(key, body());
    expect(written).toMatchObject({
      size: 0,
      sha256: sha256(),
      created: true,
    });
    const fetched = await readAll(await instance.get(key));
    expect(fetched.byteLength).toBe(0);
  });

  it("hashes foreign objects that lack sha256 metadata", async () => {
    const key = uniqueKey("foreign");
    const payload = bytes("written by another client");

    await rawClient().send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: Buffer.from(payload),
      }),
    );

    const statted = await storage().stat(key);
    expect(statted.sha256).toBe(sha256(payload));
    expect(statted.size).toBe(payload.byteLength);

    // A retry of identical bytes still resolves via the hash fallback.
    const retried = await storage().put(key, body(payload));
    expect(retried.created).toBe(false);
  });
});
