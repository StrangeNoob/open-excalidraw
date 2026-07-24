import { randomUUID } from "node:crypto";

import { createDatabase, runMigrations } from "@open-excalidraw/database";
import express from "express";
import type { Pool } from "pg";
import request from "supertest";

import type { IdentityService } from "../src/modules/auth/index.js";
import {
  ContentService,
  createContentRouter,
  PostgresContentRepository,
} from "../src/modules/content/index.js";
import {
  DrawingService,
  PostgresDrawingRepository,
} from "../src/modules/drawings/index.js";

const databaseUrl = process.env.DATABASE_TEST_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("content persistence", () => {
  const database = createDatabase(databaseUrl ?? "postgresql://unused");
  const ownerId = randomUUID();
  const viewerId = randomUUID();
  const leavingEditorId = randomUUID();
  const drawingId = randomUUID();
  const service = new ContentService(
    new PostgresContentRepository(database.pool),
    0,
  );

  beforeAll(async () => {
    await runMigrations({ pool: database.pool });
    await database.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, 'Content Owner', $2, true),
              ($3, 'Content Viewer', $4, true),
              ($5, 'Leaving Editor', $6, true)`,
      [
        ownerId,
        `${ownerId}@example.test`,
        viewerId,
        `${viewerId}@example.test`,
        leavingEditorId,
        `${leavingEditorId}@example.test`,
      ],
    );
    const scene = emptyScene();
    const serialized = JSON.stringify(scene);
    await database.pool.query(
      `INSERT INTO drawings
         (id, owner_user_id, title, scene, scene_format_version, scene_bytes)
       VALUES ($1, $2, 'Content test', $3::jsonb, 2, $4)`,
      [drawingId, ownerId, serialized, Buffer.byteLength(serialized)],
    );
    await database.pool.query(
      `INSERT INTO drawing_members (drawing_id, user_id, role, created_by_user_id)
       VALUES ($1, $2, 'viewer', $4), ($1, $3, 'editor', $4)`,
      [drawingId, viewerId, leavingEditorId, ownerId],
    );
  });

  afterAll(async () => {
    await database.pool.query(`DELETE FROM drawings WHERE id = $1`, [
      drawingId,
    ]);
    await database.pool.query(`DELETE FROM "user" WHERE id = ANY($1::uuid[])`, [
      [ownerId, viewerId, leavingEditorId],
    ]);
    await database.close();
  });

  it("advances exactly once, rejects stale saves, and replays a mutation", async () => {
    const mutationId = randomUUID();
    const first = await service.save(ownerId, drawingId, 0n, mutationId, {
      scene: sceneWithText("one"),
      assetIds: [],
    });
    expect(first.revision).toBe("1");

    const replay = await service.save(ownerId, drawingId, 0n, mutationId, {
      scene: sceneWithText("one"),
      assetIds: [],
    });
    expect(replay).toEqual(first);
    expect((await service.load(ownerId, drawingId)).revision).toBe("1");

    await expect(
      service.save(ownerId, drawingId, 0n, randomUUID(), {
        scene: sceneWithText("stale"),
        assetIds: [],
      }),
    ).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      status: 412,
    });
    expect(
      (await service.load(ownerId, drawingId)).scene.elements[0],
    ).toMatchObject({
      id: "one",
    });
  });

  it("rejects an idempotency key reused with a different payload", async () => {
    const mutationId = randomUUID();
    const current = await service.load(ownerId, drawingId);
    await service.save(
      ownerId,
      drawingId,
      BigInt(current.revision),
      mutationId,
      {
        scene: sceneWithText("stable"),
        assetIds: [],
      },
    );
    await expect(
      service.save(ownerId, drawingId, BigInt(current.revision), mutationId, {
        scene: sceneWithText("different"),
        assetIds: [],
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_MISMATCH",
      status: 409,
    });
  });

  it("rejects missing asset metadata and viewer writes without changing content", async () => {
    const current = await service.load(ownerId, drawingId);
    const imageScene = {
      ...emptyScene(),
      elements: [
        {
          id: "image",
          type: "image",
          version: 1,
          versionNonce: 1,
          isDeleted: false,
          fileId: "missing-file",
        },
      ],
    };
    await expect(
      service.save(ownerId, drawingId, BigInt(current.revision), randomUUID(), {
        scene: imageScene,
        assetIds: ["missing-file"],
      }),
    ).rejects.toMatchObject({
      code: "MISSING_ASSET",
      status: 422,
    });
    await expect(
      service.save(
        viewerId,
        drawingId,
        BigInt(current.revision),
        randomUUID(),
        {
          scene: sceneWithText("viewer"),
          assetIds: [],
        },
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    expect((await service.load(ownerId, drawingId)).revision).toBe(
      current.revision,
    );
  });

  it("publishes quoted revision ETags and requires conditional idempotent saves", async () => {
    const identity: IdentityService = {
      resolve: () =>
        Promise.resolve({
          userId: ownerId,
          email: `${ownerId}@example.test`,
          name: "Content Owner",
          image: null,
          emailVerified: true,
          twoFactorEnabled: false,
          createdAt: new Date(),
          authKind: "session",
          sessionId: randomUUID(),
          sessionExpiresAt: new Date(Date.now() + 60_000),
        }),
    };
    const app = express();
    app.use(express.json());
    app.use(createContentRouter({ service, identity }));

    const loaded = await request(app).get(
      `/api/v1/drawings/${drawingId}/content`,
    );
    expect(loaded.status).toBe(200);
    expect(loaded.headers.etag).toBe(`"${loaded.body.revision}"`);

    const missingPrecondition = await request(app)
      .put(`/api/v1/drawings/${drawingId}/content`)
      .send({ scene: sceneWithText("no-precondition"), assetIds: [] });
    expect(missingPrecondition.status).toBe(428);
    expect(missingPrecondition.body.code).toBe("PRECONDITION_REQUIRED");

    const missingIdempotency = await request(app)
      .put(`/api/v1/drawings/${drawingId}/content`)
      .set("if-match", String(loaded.headers.etag))
      .send({ scene: sceneWithText("no-key"), assetIds: [] });
    expect(missingIdempotency.status).toBe(400);
    expect(missingIdempotency.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("serializes self-leave before a queued content save", async () => {
    const drawingService = new DrawingService(
      // This test never duplicates, so blobs are irrelevant.
      new PostgresDrawingRepository(database.pool, {
        copy: () => Promise.resolve("missing" as const),
        remove: () => Promise.resolve(),
      }),
    );
    const before = await service.load(leavingEditorId, drawingId);
    const blocker = await database.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(`SELECT id FROM drawings WHERE id = $1 FOR UPDATE`, [
      drawingId,
    ]);

    const leavePromise = drawingService.leave(leavingEditorId, drawingId);
    await waitForLeaveLockWaiter(database.pool);
    const savePromise = service.save(
      leavingEditorId,
      drawingId,
      BigInt(before.revision),
      randomUUID(),
      { scene: sceneWithText("left-before-save"), assetIds: [] },
    );
    await blocker.query("COMMIT");
    blocker.release();

    await expect(leavePromise).resolves.toBeUndefined();
    await expect(savePromise).rejects.toMatchObject({
      code: "DRAWING_NOT_FOUND",
      status: 404,
    });
    expect((await service.load(ownerId, drawingId)).revision).toBe(
      before.revision,
    );
  });
});

function emptyScene() {
  return {
    type: "excalidraw" as const,
    version: 2,
    source: "open-excalidraw-test",
    elements: [],
    appState: {},
  };
}

function sceneWithText(id: string) {
  return {
    ...emptyScene(),
    elements: [
      {
        id,
        type: "text",
        version: 1,
        versionNonce: 1,
        isDeleted: false,
      },
    ],
  };
}

async function waitForLeaveLockWaiter(pool: Pool, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query LIKE '%drawing-self-leave%'
       ) AS waiting`,
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Self-leave did not wait for the drawing lock");
}
