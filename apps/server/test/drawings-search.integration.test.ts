import { createHash, randomUUID } from "node:crypto";

import { createDatabase, runMigrations } from "@open-excalidraw/database";
import express from "express";
import request from "supertest";

import type { IdentityService } from "../src/modules/auth/index.js";
import { PostgresMutationRepository } from "../src/modules/collaboration/persistence/index.js";
import type { SocketAuthorizationBinding } from "../src/modules/collaboration/security/index.js";
import {
  ContentService,
  PostgresContentRepository,
} from "../src/modules/content/index.js";
import {
  createDrawingRouter,
  DrawingService,
  PostgresDrawingRepository,
  updateDrawingSearchText,
} from "../src/modules/drawings/index.js";

const databaseUrl = process.env.DATABASE_TEST_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("drawing content search", () => {
  const database = createDatabase(databaseUrl ?? "postgresql://unused");
  const content = new ContentService(
    new PostgresContentRepository(database.pool),
  );
  const drawingRepository = new PostgresDrawingRepository(database.pool, {
    copy: () => Promise.resolve("missing" as const),
    remove: () => Promise.resolve(),
  });
  const drawings = new DrawingService(drawingRepository);
  const collaboration = new PostgresMutationRepository(database.pool);

  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const memberId = randomUUID();

  beforeAll(async () => {
    await runMigrations({ pool: database.pool });
    await database.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, 'Search Owner', $2, true),
              ($3, 'Other Owner', $4, true),
              ($5, 'Search Member', $6, true)`,
      [
        ownerId,
        `${ownerId}@example.test`,
        otherOwnerId,
        `${otherOwnerId}@example.test`,
        memberId,
        `${memberId}@example.test`,
      ],
    );
  });

  afterAll(async () => {
    // owner_user_id is ON DELETE RESTRICT, so drawings must go before users.
    await database.pool.query(
      `DELETE FROM drawings WHERE owner_user_id = ANY($1::uuid[])`,
      [[ownerId, otherOwnerId, memberId]],
    );
    await database.pool.query(`DELETE FROM "user" WHERE id = ANY($1::uuid[])`, [
      [ownerId, otherOwnerId, memberId],
    ]);
    await database.close();
  });

  it("finds text saved through the content path and drops it once removed", async () => {
    const drawing = await createDrawing(ownerId);
    await save(ownerId, drawing, 0n, [textElement("quokkaword")]);

    expect(await searchIds(ownerId, "quokkaword")).toContain(drawing);

    await save(ownerId, drawing, 1n, []);
    expect(await searchIds(ownerId, "quokkaword")).not.toContain(drawing);
  });

  it("returns owned and shared matches but never another user's drawing", async () => {
    const owned = await createDrawing(ownerId);
    await save(ownerId, owned, 0n, [textElement("pangolinword")]);

    const shared = await createDrawing(otherOwnerId);
    await save(otherOwnerId, shared, 0n, [textElement("pangolinword")]);
    await addMember(shared, memberId, "viewer");
    await addMember(shared, ownerId, "editor");

    const inaccessible = await createDrawing(otherOwnerId);
    await save(otherOwnerId, inaccessible, 0n, [textElement("pangolinword")]);

    const ids = await searchIds(ownerId, "pangolinword");
    expect(ids).toContain(owned);
    expect(ids).toContain(shared);
    expect(ids).not.toContain(inaccessible);

    // The member reaches the shared drawing but not the owner's private one.
    const memberIds = await searchIds(memberId, "pangolinword");
    expect(memberIds).toContain(shared);
    expect(memberIds).not.toContain(owned);
  });

  it("excludes trashed drawings and deleted elements, indexes frame names", async () => {
    const trashed = await createDrawing(ownerId);
    await save(ownerId, trashed, 0n, [textElement("aardvarkword")]);
    await database.pool.query(
      `UPDATE drawings SET deleted_at = now() WHERE id = $1`,
      [trashed],
    );
    expect(await searchIds(ownerId, "aardvarkword")).not.toContain(trashed);

    const mixed = await createDrawing(ownerId);
    await save(ownerId, mixed, 0n, [
      textElement("visibleword"),
      textElement("hiddenword", { isDeleted: true }),
    ]);
    expect(await searchIds(ownerId, "visibleword")).toContain(mixed);
    expect(await searchIds(ownerId, "hiddenword")).not.toContain(mixed);

    const framed = await createDrawing(ownerId);
    await save(ownerId, framed, 0n, [frameElement("frobnicateframe")]);
    expect(await searchIds(ownerId, "frobnicateframe")).toContain(framed);
  });

  it("does not touch the search row when a save leaves the text unchanged", async () => {
    const drawing = await createDrawing(ownerId);
    await save(ownerId, drawing, 0n, [textElement("dedupeword")]);
    const first = await searchRowUpdatedAt(drawing);

    // Identical scene, fresh mutation: content_revision advances but the
    // extracted text is unchanged, so the side row must not be rewritten.
    await save(ownerId, drawing, 1n, [textElement("dedupeword")]);
    const second = await searchRowUpdatedAt(drawing);

    expect(second.getTime()).toBe(first.getTime());
  });

  it("maintains the search row through a committed collaboration mutation", async () => {
    const drawing = await createDrawing(ownerId);
    const before = await collaboration.loadSnapshot(drawing, ownerId);
    if (!before) throw new Error("Expected a collaboration snapshot");

    const event = {
      type: "scene.mutate" as const,
      mutationId: randomUUID(),
      baseRevision: before.revision.toString(),
      elements: [collabTextElement("collabword")],
    };
    const result = await collaboration.persist({
      binding: binding(drawing, ownerId),
      event,
      payloadHash: createHash("sha256").update(JSON.stringify(event)).digest(),
    });

    expect(result.status).toBe("committed");
    expect(await searchIds(ownerId, "collabword")).toContain(drawing);
  });

  it("accepts websearch syntax and never errors on nonsense operators", async () => {
    const drawing = await createDrawing(ownerId);
    await save(ownerId, drawing, 0n, [textElement("alpha beta gamma")]);

    // Space is AND in websearch syntax.
    expect(await searchIds(ownerId, "alpha gamma")).toContain(drawing);
    // A quoted phrase matches only the adjacent order.
    expect(await searchIds(ownerId, '"beta gamma"')).toContain(drawing);
    expect(await searchIds(ownerId, '"gamma beta"')).not.toContain(drawing);
    // Unbalanced quotes and stray operators must not raise.
    await expect(searchIds(ownerId, 'alpha OR OR ("')).resolves.toEqual(
      expect.any(Array),
    );
  });

  it("yields an empty search row for a malformed scene instead of erroring", async () => {
    const drawing = await createDrawing(ownerId);
    // elements as a string, not an array — the extraction's jsonb_typeof guard
    // must fall back to '' rather than raising.
    await database.pool.query(
      `UPDATE drawings
       SET scene = jsonb_set(scene, '{elements}', '"not-an-array"'::jsonb)
       WHERE id = $1`,
      [drawing],
    );
    await expect(
      updateDrawingSearchText(database.pool, drawing),
    ).resolves.toBeUndefined();

    const row = await database.pool.query<{ extracted_text: string }>(
      `SELECT extracted_text FROM drawing_search_texts WHERE drawing_id = $1`,
      [drawing],
    );
    expect(row.rows[0]?.extracted_text).toBe("");
  });

  it("serves the search endpoint and rejects an empty query", async () => {
    const drawing = await createDrawing(ownerId);
    await save(ownerId, drawing, 0n, [textElement("endpointword")]);

    const identity: IdentityService = {
      resolve: () =>
        Promise.resolve({
          userId: ownerId,
          email: `${ownerId}@example.test`,
          name: "Search Owner",
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
    app.use(createDrawingRouter({ service: drawings, identity }));

    const ok = await request(app)
      .get("/api/v1/drawings/search")
      .query({ q: "endpointword" });
    expect(ok.status).toBe(200);
    expect(ok.body.drawingIds).toContain(drawing);

    const missing = await request(app).get("/api/v1/drawings/search");
    expect(missing.status).toBe(400);
  });

  const emptyScene = {
    type: "excalidraw" as const,
    version: 2,
    source: "search-test",
    elements: [] as unknown[],
    appState: {},
  };

  async function createDrawing(owner: string): Promise<string> {
    const id = randomUUID();
    const serialized = JSON.stringify(emptyScene);
    await database.pool.query(
      `INSERT INTO drawings
         (id, owner_user_id, title, scene, scene_format_version, scene_bytes)
       VALUES ($1, $2, 'Search test', $3::jsonb, 2, $4)`,
      [id, owner, serialized, Buffer.byteLength(serialized)],
    );
    return id;
  }

  async function addMember(
    drawingId: string,
    userId: string,
    role: "editor" | "viewer",
  ) {
    await database.pool.query(
      `INSERT INTO drawing_members (drawing_id, user_id, role, created_by_user_id)
       VALUES ($1, $2, $3, $4)`,
      [drawingId, userId, role, ownerId],
    );
  }

  async function save(
    userId: string,
    drawingId: string,
    expectedRevision: bigint,
    elements: unknown[],
  ) {
    return content.save(userId, drawingId, expectedRevision, randomUUID(), {
      scene: { ...emptyScene, elements },
      assetIds: [],
    });
  }

  async function searchIds(userId: string, query: string): Promise<string[]> {
    return (await drawings.search(userId, query)).drawingIds;
  }

  async function searchRowUpdatedAt(drawingId: string): Promise<Date> {
    const row = await database.pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM drawing_search_texts WHERE drawing_id = $1`,
      [drawingId],
    );
    const updatedAt = row.rows[0]?.updated_at;
    if (!updatedAt) throw new Error("Expected a search row");
    return updatedAt;
  }

  function binding(
    drawingId: string,
    userId: string,
  ): SocketAuthorizationBinding {
    return {
      connectionId: randomUUID(),
      drawingId,
      userId,
      sessionId: randomUUID(),
      sessionExpiresAt: new Date(Date.now() + 60_000),
      role: "owner",
    };
  }
});

function textElement(
  text: string,
  { isDeleted = false }: { isDeleted?: boolean } = {},
) {
  return {
    id: randomUUID(),
    type: "text",
    version: 1,
    versionNonce: 1,
    isDeleted,
    text,
  };
}

function frameElement(name: string) {
  return {
    id: randomUUID(),
    type: "frame",
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    name,
  };
}

function collabTextElement(text: string) {
  return {
    id: randomUUID(),
    type: "text",
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    index: "a0",
    text,
  };
}
