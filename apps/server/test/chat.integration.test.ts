import { randomUUID } from "node:crypto";

import { createDatabase, runMigrations } from "@open-excalidraw/database";

import { PostgresChatRepository } from "../src/modules/chat/index.js";
import { ChatService } from "../src/modules/chat/service.js";

const databaseUrl = process.env.DATABASE_TEST_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("chat message persistence and history", () => {
  const database = createDatabase(databaseUrl ?? "postgresql://unused");
  const authorId = randomUUID();
  const viewerId = randomUUID();
  const drawingId = randomUUID();
  const repository = new PostgresChatRepository(database.pool);
  const service = new ChatService({
    repository,
    membershipResolver: {
      getRole: () => Promise.resolve("owner" as const),
    },
  });

  beforeAll(async () => {
    await runMigrations({ pool: database.pool });
    await database.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, 'Chat Author', $2, true)`,
      [authorId, `${authorId}@example.test`],
    );
    await database.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, 'Chat Viewer', $2, true)`,
      [viewerId, `${viewerId}@example.test`],
    );
    const scene = JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "test",
      elements: [],
      appState: {},
    });
    await database.pool.query(
      `INSERT INTO drawings
         (id, owner_user_id, title, scene, scene_format_version, scene_bytes)
       VALUES ($1, $2, 'Chatty drawing', $3::jsonb, 2, $4)`,
      [drawingId, authorId, scene, Buffer.byteLength(scene)],
    );
    await database.pool.query(
      `INSERT INTO drawing_members (drawing_id, user_id, role, created_by_user_id)
       VALUES ($1, $2, 'viewer', $3)`,
      [drawingId, viewerId, authorId],
    );
  });

  afterAll(async () => {
    await database.pool.query(`DELETE FROM drawings WHERE id = $1`, [
      drawingId,
    ]);
    await database.pool.query(`DELETE FROM "user" WHERE id = ANY($1::uuid[])`, [
      [authorId, viewerId],
    ]);
    await database.close();
  });

  it("persists a message once and joins the author name", async () => {
    const messageId = randomUUID();
    const first = await repository.insert({
      id: messageId,
      drawingId,
      userId: authorId,
      body: "first message",
    });
    const duplicate = await repository.insert({
      id: messageId,
      drawingId,
      userId: authorId,
      body: "first message",
    });

    expect(first).toMatchObject({
      id: messageId,
      drawingId,
      userId: authorId,
      authorName: "Chat Author",
      body: "first message",
    });
    expect(first?.createdAt).toBeInstanceOf(Date);
    expect(duplicate).toBeNull();
  });

  it("pages history newest-first across the keyset cursor", async () => {
    for (let i = 0; i < 60; i += 1) {
      await repository.insert({
        id: randomUUID(),
        drawingId,
        userId: authorId,
        body: `message ${i}`,
      });
    }

    const firstPage = await service.history(authorId, drawingId);
    expect(firstPage.messages).toHaveLength(50);
    expect(firstPage.nextCursor).not.toBeNull();

    const timestamps = firstPage.messages.map((message) =>
      Date.parse(message.createdAt),
    );
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));

    const secondPage = await service.history(
      authorId,
      drawingId,
      firstPage.nextCursor!,
    );
    expect(secondPage.messages.length).toBeGreaterThanOrEqual(11);
    expect(secondPage.nextCursor).toBeNull();

    const seen = new Set(firstPage.messages.map((message) => message.id));
    for (const message of secondPage.messages) {
      expect(seen.has(message.id)).toBe(false);
    }
  });

  it("round-trips mentions and anchors and leaves both null when absent", async () => {
    const annotatedId = randomUUID();
    const mentionedId = randomUUID();
    const anchor = { elementIds: ["Zx1", "Zx2"] };

    const annotated = await repository.insert({
      id: annotatedId,
      drawingId,
      userId: authorId,
      body: "look at this",
      mentions: [mentionedId],
      anchor,
    });
    const plain = await repository.insert({
      id: randomUUID(),
      drawingId,
      userId: authorId,
      body: "no metadata",
    });

    expect(annotated).toMatchObject({ mentions: [mentionedId], anchor });
    expect(plain).toMatchObject({ mentions: null, anchor: null });

    const reloaded = (await repository.listBefore(drawingId, null, 5)).find(
      (message) => message.id === annotatedId,
    );
    expect(reloaded).toMatchObject({ mentions: [mentionedId], anchor });
  });

  it("lists the owner and every member as chat participants", async () => {
    const participants = await repository.listParticipants(drawingId);

    expect(participants).toEqual([
      { userId: authorId, name: "Chat Author" },
      { userId: viewerId, name: "Chat Viewer" },
    ]);
    // The roster a viewer reads to mention people, which the owner-only
    // sharing member list would refuse them.
    await expect(service.participants(viewerId, drawingId)).resolves.toEqual({
      participants,
    });
  });
});
