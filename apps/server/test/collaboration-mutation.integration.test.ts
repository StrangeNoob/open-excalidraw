import { randomUUID } from "node:crypto";

import { createDatabase, runMigrations } from "@open-excalidraw/database";

import { MutationService } from "../src/modules/collaboration/mutation-service.js";
import { PostgresMutationRepository } from "../src/modules/collaboration/persistence/index.js";
import type {
  SocketAuthorizationBinding,
  SocketSessionValidityResolver,
} from "../src/modules/collaboration/security/index.js";
import { PostgresSharingRepository } from "../src/modules/sharing/index.js";

const databaseUrl = process.env.DATABASE_TEST_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("durable collaboration mutations", () => {
  const database = createDatabase(databaseUrl ?? "postgresql://unused");
  const repository = new PostgresMutationRepository(database.pool);
  const service = new MutationService({
    repository,
    sessionValidityResolver: activeSessions,
  });
  const ownerId = randomUUID();
  const editorOneId = randomUUID();
  const editorTwoId = randomUUID();
  const viewerId = randomUUID();
  const drawingId = randomUUID();

  beforeAll(async () => {
    await runMigrations({ pool: database.pool });
    await database.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, 'Collab Owner', $2, true),
              ($3, 'Editor One', $4, true),
              ($5, 'Editor Two', $6, true),
              ($7, 'Collab Viewer', $8, true)`,
      [
        ownerId,
        `${ownerId}@example.test`,
        editorOneId,
        `${editorOneId}@example.test`,
        editorTwoId,
        `${editorTwoId}@example.test`,
        viewerId,
        `${viewerId}@example.test`,
      ],
    );
    const scene = JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "collaboration-test",
      elements: [],
      appState: {},
    });
    await database.pool.query(
      `INSERT INTO drawings
         (id, owner_user_id, title, scene, scene_format_version, scene_bytes)
       VALUES ($1, $2, 'Collaboration', $3::jsonb, 1, $4)`,
      [drawingId, ownerId, scene, Buffer.byteLength(scene)],
    );
    await database.pool.query(
      `INSERT INTO drawing_members (drawing_id, user_id, role, created_by_user_id)
       VALUES ($1, $2, 'editor', $5), ($1, $3, 'editor', $5),
              ($1, $4, 'viewer', $5)`,
      [drawingId, editorOneId, editorTwoId, viewerId, ownerId],
    );
  });

  afterAll(async () => {
    await database.pool.query(`DELETE FROM drawings WHERE id = $1`, [
      drawingId,
    ]);
    await database.pool.query(`DELETE FROM "user" WHERE id = ANY($1::uuid[])`, [
      [ownerId, editorOneId, editorTwoId, viewerId],
    ]);
    await database.close();
  });

  it("merges two editors from one base for different and identical elements", async () => {
    const base = await snapshot(editorOneId);
    const different = await Promise.all([
      service.mutate(binding(editorOneId, "editor", "editor-one"), {
        type: "scene.mutate",
        mutationId: randomUUID(),
        baseRevision: base.revision.toString(),
        elements: [element("different-a", 1, 10)],
      }),
      service.mutate(binding(editorTwoId, "editor", "editor-two"), {
        type: "scene.mutate",
        mutationId: randomUUID(),
        baseRevision: base.revision.toString(),
        elements: [element("different-b", 1, 20)],
      }),
    ]);
    expect(different.every((outcome) => outcome.kind === "committed")).toBe(
      true,
    );
    expect(ids((await snapshot(ownerId)).snapshot.elements)).toEqual(
      expect.arrayContaining(["different-a", "different-b"]),
    );

    const identicalBase = await snapshot(editorOneId);
    const identical = await Promise.all([
      service.mutate(binding(editorOneId, "editor", "same-one"), {
        type: "scene.mutate",
        mutationId: randomUUID(),
        baseRevision: identicalBase.revision.toString(),
        elements: [element("same-element", 1, 100)],
      }),
      service.mutate(binding(editorTwoId, "editor", "same-two"), {
        type: "scene.mutate",
        mutationId: randomUUID(),
        baseRevision: identicalBase.revision.toString(),
        elements: [element("same-element", 1, 50)],
      }),
    ]);
    expect(identical.some((outcome) => outcome.kind === "committed")).toBe(
      true,
    );
    expect(
      (await snapshot(ownerId)).snapshot.elements.find(
        (candidate) => candidate.id === "same-element",
      ),
    ).toMatchObject({ versionNonce: 50 });
  });

  it("deduplicates lost acknowledgements, including current-base noops", async () => {
    const current = await snapshot(editorOneId);
    const event = {
      type: "scene.mutate" as const,
      mutationId: randomUUID(),
      baseRevision: current.revision.toString(),
      elements: [element("lost-ack", 1, 1)],
    };
    const committed = await service.mutate(
      binding(editorOneId, "editor"),
      event,
    );
    const duplicate = await service.mutate(
      binding(editorOneId, "editor"),
      event,
    );
    expect(committed.kind).toBe("committed");
    expect(duplicate).toMatchObject({
      kind: "ack",
      event: { status: "duplicate" },
    });
    await expect(
      service.mutate(binding(editorOneId, "editor"), {
        ...event,
        elements: [element("different-payload", 1, 1)],
      }),
    ).rejects.toMatchObject({ code: "MUTATION_ID_MISMATCH" });

    const noopBase = await snapshot(editorOneId);
    const unchanged = noopBase.snapshot.elements.find(
      (candidate) => candidate.id === "lost-ack",
    );
    if (!unchanged) throw new Error("Expected canonical lost-ack element");
    const noop = {
      type: "scene.mutate" as const,
      mutationId: randomUUID(),
      baseRevision: noopBase.revision.toString(),
      elements: [unchanged],
    };
    await expect(
      service.mutate(binding(editorOneId, "editor"), noop),
    ).resolves.toMatchObject({
      kind: "ack",
      event: { status: "noop", revision: noopBase.revision.toString() },
    });
    await expect(
      service.mutate(binding(editorOneId, "editor"), noop),
    ).resolves.toMatchObject({
      kind: "ack",
      event: { status: "duplicate", revision: noopBase.revision.toString() },
    });
    await expect(
      service.mutate(binding(editorOneId, "editor"), {
        ...noop,
        elements: [{ ...unchanged, version: unchanged.version + 1 }],
      }),
    ).rejects.toMatchObject({ code: "MUTATION_ID_MISMATCH" });
  });

  it("rejects future bases, reconciles stale bases, and validates assets", async () => {
    const current = await snapshot(editorTwoId);
    await expect(
      service.mutate(binding(editorTwoId, "editor"), {
        type: "scene.mutate",
        mutationId: randomUUID(),
        baseRevision: (current.revision + 1n).toString(),
        elements: [element("future", 1, 1)],
      }),
    ).rejects.toMatchObject({
      code: "FUTURE_REVISION",
      retryable: true,
    });

    await expect(
      service.mutate(binding(editorTwoId, "editor"), {
        type: "scene.mutate",
        mutationId: randomUUID(),
        baseRevision: "0",
        elements: [element("stale-but-valid", 1, 1)],
      }),
    ).resolves.toMatchObject({ kind: "committed" });
    await expect(
      service.mutate(binding(editorTwoId, "editor"), {
        type: "scene.mutate",
        mutationId: randomUUID(),
        baseRevision: (await snapshot(editorTwoId)).revision.toString(),
        elements: [
          {
            ...element("missing-image", 1, 1),
            type: "image",
            fileId: "missing",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "MISSING_ASSET" });
  });

  it("rolls back the revision and returns no result when the database rejects the mutation", async () => {
    const before = await snapshot(editorTwoId);
    const mutationId = randomUUID();
    await expect(
      repository.persist({
        binding: binding(editorTwoId, "editor"),
        event: {
          type: "scene.mutate",
          mutationId,
          baseRevision: before.revision.toString(),
          elements: [element("database-rollback", 1, 1)],
        },
        payloadHash: Buffer.alloc(31),
      }),
    ).rejects.toMatchObject({ code: "23514" });
    const after = await snapshot(editorTwoId);
    expect(after.revision).toBe(before.revision);
    expect(ids(after.snapshot.elements)).not.toContain("database-rollback");
    const recorded = await database.pool.query<{ count: string }>(
      `SELECT count(*) FROM drawing_mutations
       WHERE drawing_id = $1 AND mutation_id = $2`,
      [drawingId, mutationId],
    );
    expect(recorded.rows[0]?.count).toBe("0");
  });

  it("handles a maximum 5,000-element patch without quadratic lookup", async () => {
    const current = await snapshot(editorTwoId);
    const elements = Array.from({ length: 5_000 }, (_, index) =>
      element(`boundary-${index.toString().padStart(4, "0")}`, 1, index + 1),
    );
    const outcome = await service.mutate(binding(editorTwoId, "editor"), {
      type: "scene.mutate",
      mutationId: randomUUID(),
      baseRevision: current.revision.toString(),
      elements,
    });
    expect(outcome).toMatchObject({
      kind: "committed",
      event: { elements: { length: 5_000 } },
    });
  });

  it("enforces viewer role and revocation using live database membership", async () => {
    const current = await snapshot(ownerId);
    const mutation = {
      type: "scene.mutate" as const,
      mutationId: randomUUID(),
      baseRevision: current.revision.toString(),
      elements: [element("viewer-rejected", 1, 1)],
    };
    await expect(
      service.mutate(binding(viewerId, "viewer"), mutation),
    ).rejects.toMatchObject({ code: "SOCKET_EVENT_FORBIDDEN" });
    await expect(
      service.mutate(binding(viewerId, "editor"), mutation),
    ).rejects.toMatchObject({ code: "SOCKET_EVENT_FORBIDDEN" });

    await expect(
      new PostgresSharingRepository(database.pool).removeMember({
        drawingId,
        actorUserId: ownerId,
        memberUserId: editorOneId,
      }),
    ).resolves.toBe("removed");
    await expect(
      service.mutate(binding(editorOneId, "editor"), {
        ...mutation,
        mutationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "SOCKET_NOT_MEMBER" });
  });

  function snapshot(userId: string) {
    return repository.loadSnapshot(drawingId, userId).then((result) => {
      if (!result) throw new Error("Expected collaboration snapshot");
      return result;
    });
  }

  function binding(
    userId: string,
    role: "owner" | "editor" | "viewer",
    connectionId: string = randomUUID(),
  ): SocketAuthorizationBinding {
    return Object.freeze({
      connectionId,
      drawingId,
      userId,
      sessionId: randomUUID(),
      sessionExpiresAt: new Date(Date.now() + 60_000),
      role,
    });
  }
});

const activeSessions: SocketSessionValidityResolver = {
  isSessionActive: () => Promise.resolve(true),
};

function element(id: string, version: number, versionNonce: number) {
  return {
    id,
    type: "rectangle",
    version,
    versionNonce,
    isDeleted: false,
    index: id,
  };
}

function ids(elements: readonly { id: string }[]) {
  return elements.map((element_) => element_.id);
}
