import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  LocalObjectStorage,
  type ObjectStorage,
} from "@open-excalidraw/storage";
import express from "express";
import request from "supertest";

import {
  AssetService,
  createAssetRouter,
  type AssetAccessRole,
  type AssetRecord,
  type AssetRepository,
  type InsertAssetResult,
  type NewAssetRecord,
} from "../src/modules/assets/index.js";

const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EDITOR_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VIEWER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OUTSIDER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DRAWING_A = "11111111-1111-4111-8111-111111111111";
const DRAWING_B = "22222222-2222-4222-8222-222222222222";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const DIFFERENT_PNG = Buffer.concat([PNG, Buffer.from([0])]);

class MemoryAssetRepository implements AssetRepository {
  readonly access = new Map<string, AssetAccessRole>();
  readonly assets = new Map<string, AssetRecord>();
  commitThenFail = false;
  failFind = false;
  failFindAfter: number | null = null;
  failInsert = false;
  findCalls = 0;

  public setAccess(drawingId: string, userId: string, role: AssetAccessRole) {
    this.access.set(`${drawingId}:${userId}`, role);
  }

  public getDrawingAccess(drawingId: string, userId: string) {
    return Promise.resolve(this.access.get(`${drawingId}:${userId}`) ?? null);
  }

  public findAsset(drawingId: string, fileId: string) {
    this.findCalls += 1;
    if (
      this.failFind ||
      (this.failFindAfter !== null && this.findCalls > this.failFindAfter)
    ) {
      throw new Error("database lookup unavailable");
    }
    return Promise.resolve(this.assets.get(`${drawingId}:${fileId}`) ?? null);
  }

  public insertAsset(asset: NewAssetRecord): Promise<InsertAssetResult> {
    if (this.failInsert) {
      throw new Error("database unavailable");
    }

    const key = `${asset.drawingId}:${asset.fileId}`;
    const existing = this.assets.get(key);
    if (existing) {
      return Promise.resolve({ asset: existing, created: false });
    }

    const created: AssetRecord = {
      ...asset,
      id: randomUUID(),
      createdAt: new Date("2026-07-10T12:00:00.000Z"),
    };
    this.assets.set(key, created);
    if (this.commitThenFail) {
      throw new Error("connection lost after commit");
    }
    return Promise.resolve({ asset: created, created: true });
  }
}

class FailingPutStorage implements ObjectStorage {
  public put(): ReturnType<ObjectStorage["put"]> {
    return Promise.reject(new Error("disk offline"));
  }

  public get(): ReturnType<ObjectStorage["get"]> {
    return Promise.resolve(Readable.from([]));
  }

  public stat(): ReturnType<ObjectStorage["stat"]> {
    return Promise.reject(new Error("not implemented"));
  }

  public delete(): ReturnType<ObjectStorage["delete"]> {
    return Promise.resolve({ deleted: false });
  }
}

describe("asset HTTP boundary", () => {
  let directory: string;
  let repository: MemoryAssetRepository;
  let storage: LocalObjectStorage;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "open-excalidraw-assets-"));
    repository = new MemoryAssetRepository();
    repository.setAccess(DRAWING_A, OWNER_ID, "owner");
    repository.setAccess(DRAWING_A, EDITOR_ID, "editor");
    repository.setAccess(DRAWING_A, VIEWER_ID, "viewer");
    repository.setAccess(DRAWING_B, OUTSIDER_ID, "viewer");
    storage = new LocalObjectStorage({ rootDirectory: directory });
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it("allows owners and editors to upload while rejecting viewer uploads", async () => {
    const app = createTestApp(repository, storage);

    const ownerUpload = await upload(app, OWNER_ID, "owner-file", PNG);
    expect(ownerUpload.status).toBe(201);
    expect(ownerUpload.body).toMatchObject({
      drawingId: DRAWING_A,
      fileId: "owner-file",
      mimeType: "image/png",
      byteSize: PNG.byteLength,
      sha256: checksum(PNG),
    });

    const editorUpload = await upload(app, EDITOR_ID, "editor-file", PNG);
    expect(editorUpload.status).toBe(201);

    const viewerUpload = await upload(app, VIEWER_ID, "viewer-file", PNG);
    expect(viewerUpload.status).toBe(403);
    expect(viewerUpload.body.code).toBe("ASSET_UPLOAD_FORBIDDEN");
  });

  it("allows viewers to download and applies safe private response headers", async () => {
    const app = createTestApp(repository, storage);
    expect((await upload(app, OWNER_ID, "shared-file", PNG)).status).toBe(201);

    const response = await request(app)
      .get(`/api/v1/drawings/${DRAWING_A}/assets/shared-file`)
      .set("x-test-user-id", VIEWER_ID);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(PNG);
    expect(response.headers["content-type"]).toMatch(/^image\/png/);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toContain("private");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="shared-file.png"',
    );
    expect(response.headers.etag).toBe(`"${checksum(PNG)}"`);
  });

  it("never returns an asset through another drawing", async () => {
    const app = createTestApp(repository, storage);
    expect((await upload(app, OWNER_ID, "scoped-file", PNG)).status).toBe(201);

    const response = await request(app)
      .get(`/api/v1/drawings/${DRAWING_B}/assets/scoped-file`)
      .set("x-test-user-id", OUTSIDER_ID);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("ASSET_NOT_FOUND");
  });

  it("rejects MIME spoofing and invalid checksums", async () => {
    const app = createTestApp(repository, storage);

    const spoofed = await upload(
      app,
      OWNER_ID,
      "spoofed-file",
      PNG,
      "image/jpeg",
    );
    expect(spoofed.status).toBe(415);
    expect(spoofed.body.code).toBe("ASSET_MIME_MISMATCH");

    const badChecksum = await request(app)
      .put(`/api/v1/drawings/${DRAWING_A}/assets/checksum-file`)
      .set("x-test-user-id", OWNER_ID)
      .set("x-content-sha256", "0".repeat(64))
      .set("content-type", "image/png")
      .send(PNG);
    expect(badChecksum.status).toBe(422);
    expect(badChecksum.body.code).toBe("ASSET_CHECKSUM_MISMATCH");
  });

  it("rejects oversize bodies before committing metadata", async () => {
    const app = createTestApp(repository, storage, 32);
    const response = await upload(app, OWNER_ID, "large-file", PNG);

    expect(response.status).toBe(413);
    expect(response.body.code).toBe("ASSET_TOO_LARGE");
    expect(repository.assets.size).toBe(0);
  });

  it("leaves metadata untouched when the blob write fails", async () => {
    const app = createTestApp(repository, new FailingPutStorage());
    const response = await upload(app, OWNER_ID, "failed-file", PNG);

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("ASSET_STORAGE_UNAVAILABLE");
    expect(repository.assets.size).toBe(0);
  });

  it("retains an unreferenced blob for safe deferred cleanup when metadata insertion fails", async () => {
    repository.failInsert = true;
    const app = createTestApp(repository, storage);
    const response = await upload(app, OWNER_ID, "database-failed", PNG);

    expect(response.status).toBe(503);
    expect(repository.assets.size).toBe(0);
    await expect(
      storage.stat(`drawings/${DRAWING_A}/assets/database-failed`),
    ).resolves.toMatchObject({ sha256: checksum(PNG) });
  });

  it("retains a blob when an ambiguous database error committed metadata", async () => {
    repository.commitThenFail = true;
    const app = createTestApp(repository, storage);
    const response = await upload(app, OWNER_ID, "ambiguous-commit", PNG);

    expect(response.status).toBe(200);
    expect(
      repository.assets.get(`${DRAWING_A}:ambiguous-commit`),
    ).toBeDefined();
    await expect(
      storage.stat(`drawings/${DRAWING_A}/assets/ambiguous-commit`),
    ).resolves.toMatchObject({ sha256: checksum(PNG) });
  });

  it("retains a complete blob while the database outcome cannot be checked", async () => {
    repository.failInsert = true;
    repository.failFindAfter = 1;
    const app = createTestApp(repository, storage);
    const response = await upload(app, OWNER_ID, "ambiguous-lookup", PNG);

    expect(response.status).toBe(503);
    await expect(
      storage.stat(`drawings/${DRAWING_A}/assets/ambiguous-lookup`),
    ).resolves.toMatchObject({ sha256: checksum(PNG) });
  });

  it("treats an identical file ID and hash as idempotent but conflicts on new bytes", async () => {
    const app = createTestApp(repository, storage);
    const first = await upload(app, OWNER_ID, "stable-file", PNG);
    const retry = await upload(app, OWNER_ID, "stable-file", PNG);
    const conflict = await upload(app, OWNER_ID, "stable-file", DIFFERENT_PNG);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("ASSET_FILE_ID_CONFLICT");
  });

  it("requires authentication and validates file IDs", async () => {
    const app = createTestApp(repository, storage);

    const unauthenticated = await request(app)
      .get(`/api/v1/drawings/${DRAWING_A}/assets/asset-file`)
      .expect(401);
    expect(unauthenticated.headers["www-authenticate"]).toBe("Session");

    const invalidFileId = await upload(app, OWNER_ID, "bad.file", PNG);
    expect(invalidFileId.status).toBe(400);
    expect(invalidFileId.body.code).toBe("INVALID_FILE_ID");
  });

  it("accepts SVG only when its declared type matches the markup", async () => {
    const app = createTestApp(repository, storage);
    const svg = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
    );
    const response = await upload(
      app,
      OWNER_ID,
      "vector-file",
      svg,
      "image/svg+xml; charset=utf-8",
    );

    expect(response.status).toBe(201);
    expect(response.body.mimeType).toBe("image/svg+xml");
  });
});

function createTestApp(
  repository: AssetRepository,
  storage: ObjectStorage,
  maxAssetBytes?: number,
) {
  const app = express();
  const service = new AssetService({
    repository,
    storage,
    ...(maxAssetBytes === undefined ? {} : { maxAssetBytes }),
  });
  app.use(
    "/api/v1",
    createAssetRouter({
      service,
      resolveIdentity(request_) {
        const userId = request_.get("x-test-user-id");
        return Promise.resolve(userId ? { userId } : null);
      },
    }),
  );
  return app;
}

function upload(
  app: express.Express,
  userId: string,
  fileId: string,
  body: Buffer,
  mimeType = "image/png",
) {
  return request(app)
    .put(`/api/v1/drawings/${DRAWING_A}/assets/${fileId}`)
    .set("x-test-user-id", userId)
    .set("x-content-sha256", checksum(body))
    .set("content-type", mimeType)
    .send(body);
}

function checksum(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
