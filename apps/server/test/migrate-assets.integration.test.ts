import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
  LocalObjectStorage,
  S3ObjectStorage,
  type ObjectStorage,
} from "@open-excalidraw/storage";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";

import {
  migrateAssets,
  type MigratableAsset,
} from "../src/tools/migrate-assets.js";

const MINIO_IMAGE = "minio/minio:RELEASE.2025-09-07T16-13-09Z";
const ACCESS_KEY = "integration-access";
const SECRET_KEY = "integration-secret";
const BUCKET = "assets";

let container: StartedTestContainer;
let endpoint: string;

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha256(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

async function* body(payload: Uint8Array): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  yield payload;
}

function s3Storage(): S3ObjectStorage {
  return new S3ObjectStorage({
    bucket: BUCKET,
    endpoint,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    forcePathStyle: true,
  });
}

async function localStorage(): Promise<LocalObjectStorage> {
  return new LocalObjectStorage({
    rootDirectory: await mkdtemp(join(tmpdir(), "migrate-assets-")),
  });
}

async function seed(
  storage: ObjectStorage,
  entries: Record<string, Uint8Array>,
): Promise<MigratableAsset[]> {
  const assets: MigratableAsset[] = [];
  for (const [storageKey, payload] of Object.entries(entries)) {
    await storage.put(storageKey, body(payload), {
      expectedSha256: sha256(payload),
    });
    assets.push({
      storageKey,
      sha256: sha256(payload),
      byteSize: payload.byteLength,
    });
  }
  return assets;
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
  await new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  }).send(new CreateBucketCommand({ Bucket: BUCKET }));
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

describe("migrateAssets", () => {
  it("copies local assets to S3, is re-runnable, and reverses", async () => {
    const local = await localStorage();
    const remote = s3Storage();
    const assets = await seed(local, {
      "drawings/one/assets/a": bytes("first asset"),
      "drawings/one/assets/b": bytes("second asset"),
      "drawings/two/assets/c": bytes("third asset"),
    });
    const withOrphan = [
      ...assets,
      {
        storageKey: "drawings/gone/assets/x",
        sha256: sha256(bytes("x")),
        byteSize: 1,
      },
    ];

    const first = await migrateAssets({
      assets: withOrphan,
      source: local,
      destination: remote,
    });
    expect(first).toEqual({
      copied: 3,
      skippedIdentical: 0,
      missingSource: 1,
      failed: 0,
    });
    for (const asset of assets) {
      const stat = await remote.stat(asset.storageKey);
      expect(stat.sha256).toBe(asset.sha256);
      expect(stat.size).toBe(asset.byteSize);
    }

    // Re-run: everything already at the destination.
    const rerun = await migrateAssets({
      assets: withOrphan,
      source: local,
      destination: remote,
    });
    expect(rerun).toEqual({
      copied: 0,
      skippedIdentical: 3,
      missingSource: 1,
      failed: 0,
    });

    // Reverse direction into a fresh local root.
    const restored = await localStorage();
    const reverse = await migrateAssets({
      assets,
      source: remote,
      destination: restored,
    });
    expect(reverse).toEqual({
      copied: 3,
      skippedIdentical: 0,
      missingSource: 0,
      failed: 0,
    });
    for (const asset of assets) {
      const stat = await restored.stat(asset.storageKey);
      expect(stat.sha256).toBe(asset.sha256);
    }
  });

  it("does not write during a dry run", async () => {
    const local = await localStorage();
    const remote = s3Storage();
    const assets = await seed(local, {
      "drawings/dry/assets/a": bytes("dry run asset"),
    });

    const summary = await migrateAssets({
      assets,
      source: local,
      destination: remote,
      dryRun: true,
    });
    expect(summary.copied).toBe(1);
    await expect(remote.stat("drawings/dry/assets/a")).rejects.toThrow();
  });

  it("counts integrity failures without aborting the run", async () => {
    const local = await localStorage();
    const remote = s3Storage();
    const [good] = await seed(local, {
      "drawings/mix/assets/good": bytes("good asset"),
    });
    await seed(local, { "drawings/mix/assets/bad": bytes("bad asset") });
    const corrupt: MigratableAsset = {
      storageKey: "drawings/mix/assets/bad",
      // Recorded checksum disagrees with the stored bytes.
      sha256: sha256(bytes("something else")),
      byteSize: 9,
    };

    const summary = await migrateAssets({
      assets: [corrupt, good!],
      source: local,
      destination: remote,
    });
    expect(summary).toEqual({
      copied: 1,
      skippedIdentical: 0,
      missingSource: 0,
      failed: 1,
    });
    await expect(remote.stat(corrupt.storageKey)).rejects.toThrow();
    await expect(remote.stat(good!.storageKey)).resolves.toMatchObject({
      sha256: good!.sha256,
    });
  });
});
