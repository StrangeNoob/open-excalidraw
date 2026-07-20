import express from "express";
import { randomUUID } from "node:crypto";
import request from "supertest";

import type {
  IdentityService,
  RequestIdentity,
} from "../src/modules/auth/index.js";
import {
  can,
  createDrawingRouter,
  DrawingService,
  type AccessibleDrawing,
  type CreateDrawingResult,
  type DrawingRepository,
  type RenameDrawingResult,
  type TransferOwnershipResult,
} from "../src/modules/drawings/index.js";

const ownerId = randomUUID();
const editorId = randomUUID();
const viewerId = randomUUID();
const outsiderId = randomUUID();

describe("drawing capability policy", () => {
  it("defines the complete owner/editor/viewer matrix", () => {
    expect(can("owner", "rename")).toBe(true);
    expect(can("editor", "rename")).toBe(true);
    expect(can("viewer", "rename")).toBe(false);
    expect(can("owner", "share")).toBe(true);
    expect(can("editor", "share")).toBe(false);
    expect(can("viewer", "share")).toBe(false);
    expect(can("owner", "delete")).toBe(true);
    expect(can("editor", "delete")).toBe(false);
    expect(can("owner", "transfer-ownership")).toBe(true);
    expect(can("editor", "transfer-ownership")).toBe(false);
    expect(can("owner", "leave")).toBe(false);
    expect(can("editor", "leave")).toBe(true);
    expect(can("viewer", "leave")).toBe(true);
  });
});

describe("drawing HTTP domain", () => {
  it("lists only active owned/shared drawings and never leaks an outsider drawing", async () => {
    const fixture = createFixture();
    const owned = fixture.repository.seed(ownerId, "Owned", "owner");
    const shared = fixture.repository.seed(
      randomUUID(),
      "Shared",
      "viewer",
      ownerId,
    );
    fixture.repository.seed(randomUUID(), "Inaccessible", "owner");
    const deleted = fixture.repository.seed(ownerId, "Deleted", "owner");
    fixture.repository.deleted.set(
      deleted.id,
      new Date("2026-01-02T00:00:00.000Z"),
    );

    const response = await request(fixture.app)
      .get("/api/v1/drawings")
      .set("x-test-user", ownerId);

    expect(response.status).toBe(200);
    expect(
      response.body.owned.map((drawing: { id: string }) => drawing.id),
    ).toEqual([owned.id]);
    expect(
      response.body.shared.map((drawing: { id: string }) => drawing.id),
    ).toEqual([shared.id]);
    expect(JSON.stringify(response.body)).not.toContain("Inaccessible");
    expect(JSON.stringify(response.body)).not.toContain("Deleted");
  });

  it("carries thumbnailUpdatedAt through summaries", async () => {
    const fixture = createFixture();
    const bare = fixture.repository.seed(ownerId, "Bare", "owner");
    const thumbed = fixture.repository.seed(ownerId, "Thumbed", "owner");
    const stored = fixture.repository.drawings.get(thumbed.id);
    if (stored) {
      stored.thumbnailUpdatedAt = new Date("2026-07-15T09:30:00.000Z");
    }

    const response = await request(fixture.app)
      .get("/api/v1/drawings")
      .set("x-test-user", ownerId);

    expect(response.status).toBe(200);
    const owned = response.body.owned as Array<{
      id: string;
      thumbnailUpdatedAt: string | null;
    }>;
    const byId = new Map(
      owned.map((drawing) => [drawing.id, drawing.thumbnailUpdatedAt]),
    );
    expect(byId.get(bare.id)).toBeNull();
    expect(byId.get(thumbed.id)).toBe("2026-07-15T09:30:00.000Z");
  });

  it("allows owners and editors to rename, rejects viewers, and detects stale revisions", async () => {
    const fixture = createFixture();
    const ownerDrawing = fixture.repository.seed(ownerId, "Owner", "owner");
    const editorDrawing = fixture.repository.seed(
      ownerId,
      "Editor",
      "editor",
      editorId,
    );
    const viewerDrawing = fixture.repository.seed(
      ownerId,
      "Viewer",
      "viewer",
      viewerId,
    );

    const owner = await rename(
      fixture.app,
      ownerId,
      ownerDrawing.id,
      "Owner renamed",
      "0",
    );
    const editor = await rename(
      fixture.app,
      editorId,
      editorDrawing.id,
      "Editor renamed",
      "0",
    );
    const viewer = await rename(
      fixture.app,
      viewerId,
      viewerDrawing.id,
      "Rejected",
      "0",
    );
    const stale = await rename(
      fixture.app,
      ownerId,
      ownerDrawing.id,
      "Stale",
      "0",
    );

    expect(owner.status).toBe(200);
    expect(owner.body.metadataRevision).toBe("1");
    expect(editor.status).toBe(200);
    expect(viewer.status).toBe(403);
    expect(viewer.body.code).toBe("FORBIDDEN");
    expect(stale.status).toBe(412);
    expect(stale.body).toMatchObject({
      code: "METADATA_VERSION_CONFLICT",
      status: 412,
    });
  });

  it("restricts deletion and ownership transfer to owners", async () => {
    const fixture = createFixture();
    const drawing = fixture.repository.seed(ownerId, "Transfer me", "owner");
    fixture.repository.members.set(`${drawing.id}:${editorId}`, "editor");

    const editorDelete = await request(fixture.app)
      .delete(`/api/v1/drawings/${drawing.id}`)
      .set("x-test-user", editorId);
    expect(editorDelete.status).toBe(403);

    const editorTransfer = await request(fixture.app)
      .post(`/api/v1/drawings/${drawing.id}/transfer-ownership`)
      .set("x-test-user", editorId)
      .send({ newOwnerUserId: viewerId });
    expect(editorTransfer.status).toBe(403);

    const transferred = await request(fixture.app)
      .post(`/api/v1/drawings/${drawing.id}/transfer-ownership`)
      .set("x-test-user", ownerId)
      .send({ newOwnerUserId: editorId });
    expect(transferred.status).toBe(200);
    expect(transferred.body).toMatchObject({
      ownerUserId: editorId,
      role: "owner",
      metadataRevision: "1",
    });
    expect(fixture.repository.members.get(`${drawing.id}:${ownerId}`)).toBe(
      "editor",
    );
    expect(fixture.repository.members.has(`${drawing.id}:${editorId}`)).toBe(
      false,
    );

    const oldOwnerDelete = await request(fixture.app)
      .delete(`/api/v1/drawings/${drawing.id}`)
      .set("x-test-user", ownerId);
    expect(oldOwnerDelete.status).toBe(403);

    const newOwnerDelete = await request(fixture.app)
      .delete(`/api/v1/drawings/${drawing.id}`)
      .set("x-test-user", editorId);
    expect(newOwnerDelete.status).toBe(204);
  });

  it("allows members to leave while requiring an owner to transfer first", async () => {
    const fixture = createFixture();
    const drawing = fixture.repository.seed(ownerId, "Leave", "owner");
    fixture.repository.members.set(`${drawing.id}:${viewerId}`, "viewer");

    const ownerLeave = await request(fixture.app)
      .delete(`/api/v1/drawings/${drawing.id}/members/me`)
      .set("x-test-user", ownerId);
    expect(ownerLeave.status).toBe(409);
    expect(ownerLeave.body.code).toBe("OWNER_CANNOT_LEAVE");

    const viewerLeave = await request(fixture.app)
      .delete(`/api/v1/drawings/${drawing.id}/members/me`)
      .set("x-test-user", viewerId);
    expect(viewerLeave.status).toBe(204);
    expect(fixture.repository.members.has(`${drawing.id}:${viewerId}`)).toBe(
      false,
    );
  });

  it("stores per-user private tags with normalization and caps", async () => {
    const fixture = createFixture();
    const drawing = fixture.repository.seed(ownerId, "Tagged", "owner");
    fixture.repository.members.set(`${drawing.id}:${viewerId}`, "viewer");

    // Viewers may tag: tags are private per user.
    const viewerTag = await request(fixture.app)
      .put(`/api/v1/drawings/${drawing.id}/tags`)
      .set("x-test-user", viewerId)
      .send({ tags: [" Foo ", "bar", "foo"] });
    expect(viewerTag.status).toBe(200);
    expect(viewerTag.body.tags).toEqual(["bar", "foo"]);

    const ownerList = await request(fixture.app)
      .get("/api/v1/drawings")
      .set("x-test-user", ownerId);
    expect(ownerList.body.owned[0].tags).toEqual([]);

    const viewerList = await request(fixture.app)
      .get("/api/v1/drawings")
      .set("x-test-user", viewerId);
    expect(viewerList.body.shared[0].tags).toEqual(["bar", "foo"]);

    const tooMany = await request(fixture.app)
      .put(`/api/v1/drawings/${drawing.id}/tags`)
      .set("x-test-user", viewerId)
      .send({ tags: Array.from({ length: 21 }, (_, i) => `tag-${i}`) });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.code).toBe("INVALID_REQUEST");

    const outsider = await request(fixture.app)
      .put(`/api/v1/drawings/${drawing.id}/tags`)
      .set("x-test-user", outsiderId)
      .send({ tags: ["nope"] });
    expect(outsider.status).toBe(404);
  });

  it("duplicates accessible drawings into the caller's account", async () => {
    const fixture = createFixture();
    const shared = fixture.repository.seed(
      randomUUID(),
      "Shared sketch",
      "viewer",
      viewerId,
    );

    const duplicated = await request(fixture.app)
      .post(`/api/v1/drawings/${shared.id}/duplicate`)
      .set("x-test-user", viewerId);
    expect(duplicated.status).toBe(201);
    expect(duplicated.body).toMatchObject({
      title: "Shared sketch copy",
      ownerUserId: viewerId,
      role: "owner",
      isTemplate: false,
    });
    expect(duplicated.body.id).not.toBe(shared.id);

    const outsider = await request(fixture.app)
      .post(`/api/v1/drawings/${shared.id}/duplicate`)
      .set("x-test-user", outsiderId);
    expect(outsider.status).toBe(404);

    const missing = await request(fixture.app)
      .post(`/api/v1/drawings/${randomUUID()}/duplicate`)
      .set("x-test-user", viewerId);
    expect(missing.status).toBe(404);
  });

  it("replays a duplicate instead of stacking copies for the same idempotency key", async () => {
    const fixture = createFixture();
    const drawing = fixture.repository.seed(ownerId, "Base", "owner");
    const idempotencyKey = randomUUID();

    const first = await request(fixture.app)
      .post(`/api/v1/drawings/${drawing.id}/duplicate`)
      .set("x-test-user", ownerId)
      .send({ idempotencyKey });
    const replayed = await request(fixture.app)
      .post(`/api/v1/drawings/${drawing.id}/duplicate`)
      .set("x-test-user", ownerId)
      .send({ idempotencyKey });

    expect(first.status).toBe(201);
    expect(replayed.status).toBe(201);
    expect(replayed.body.id).toBe(first.body.id);

    const fresh = await request(fixture.app)
      .post(`/api/v1/drawings/${drawing.id}/duplicate`)
      .set("x-test-user", ownerId)
      .send({ idempotencyKey: randomUUID() });
    expect(fresh.status).toBe(201);
    expect(fresh.body.id).not.toBe(first.body.id);
  });

  it("creates a drawing at a client-supplied id, replays the owner's retry, and rejects another user's reuse with 409", async () => {
    const fixture = createFixture();
    const clientId = randomUUID();

    const created = await request(fixture.app)
      .post("/api/v1/drawings")
      .set("x-test-user", ownerId)
      .send({ title: "Offline sketch", id: clientId });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: clientId,
      title: "Offline sketch",
      ownerUserId: ownerId,
      role: "owner",
    });

    // The owner re-sending the same id (a lost-response retry) replays the
    // original drawing — even when the retry carries a different title.
    const replay = await request(fixture.app)
      .post("/api/v1/drawings")
      .set("x-test-user", ownerId)
      .send({ title: "Retry title", id: clientId });
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({
      id: clientId,
      title: "Offline sketch",
    });

    // Another user reusing the taken id is a genuine conflict.
    const conflict = await request(fixture.app)
      .post("/api/v1/drawings")
      .set("x-test-user", editorId)
      .send({ title: "Clashing", id: clientId });
    expect(conflict.status).toBe(409);
    expect(conflict.type).toBe("application/problem+json");
    expect(conflict.body.code).toBe("DRAWING_ID_CONFLICT");

    // A malformed id never reaches the repository.
    const malformed = await request(fixture.app)
      .post("/api/v1/drawings")
      .set("x-test-user", ownerId)
      .send({ title: "Bad id", id: "not-a-uuid" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe("INVALID_REQUEST");

    // Omitting the id keeps the server-assigned default.
    const assigned = await request(fixture.app)
      .post("/api/v1/drawings")
      .set("x-test-user", ownerId)
      .send({ title: "Server assigned" });
    expect(assigned.status).toBe(201);
    expect(assigned.body.id).not.toBe(clientId);
  });

  it("toggles the template flag through PATCH with rename semantics", async () => {
    const fixture = createFixture();
    const drawing = fixture.repository.seed(ownerId, "Base", "owner");
    fixture.repository.members.set(`${drawing.id}:${viewerId}`, "viewer");

    const marked = await request(fixture.app)
      .patch(`/api/v1/drawings/${drawing.id}`)
      .set("x-test-user", ownerId)
      .send({ title: "Base", metadataRevision: "0", isTemplate: true });
    expect(marked.status).toBe(200);
    expect(marked.body.isTemplate).toBe(true);

    // Omitting the flag leaves it untouched.
    const renamed = await request(fixture.app)
      .patch(`/api/v1/drawings/${drawing.id}`)
      .set("x-test-user", ownerId)
      .send({ title: "Renamed base", metadataRevision: "1" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.isTemplate).toBe(true);

    const viewer = await request(fixture.app)
      .patch(`/api/v1/drawings/${drawing.id}`)
      .set("x-test-user", viewerId)
      .send({ title: "Nope", metadataRevision: "2", isTemplate: false });
    expect(viewer.status).toBe(403);
  });

  it("lists only the caller's trashed drawings, newest deletion first", async () => {
    const fixture = createFixture();
    const older = fixture.repository.seed(ownerId, "Older trash", "owner");
    const newer = fixture.repository.seed(ownerId, "Newer trash", "owner");
    fixture.repository.seed(ownerId, "Active", "owner");
    const foreign = fixture.repository.seed(randomUUID(), "Foreign", "owner");
    fixture.repository.deleted.set(
      older.id,
      new Date("2026-01-02T00:00:00.000Z"),
    );
    fixture.repository.deleted.set(
      newer.id,
      new Date("2026-01-03T00:00:00.000Z"),
    );
    fixture.repository.deleted.set(
      foreign.id,
      new Date("2026-01-04T00:00:00.000Z"),
    );

    const response = await request(fixture.app)
      .get("/api/v1/drawings/trash")
      .set("x-test-user", ownerId);

    expect(response.status).toBe(200);
    expect(
      response.body.drawings.map((drawing: { id: string }) => drawing.id),
    ).toEqual([newer.id, older.id]);
    expect(response.body.drawings[0].deletedAt).toBe(
      "2026-01-03T00:00:00.000Z",
    );
    expect(JSON.stringify(response.body)).not.toContain("Active");
    expect(JSON.stringify(response.body)).not.toContain("Foreign");
  });

  it("restores a trashed drawing for its owner only", async () => {
    const fixture = createFixture();
    const drawing = fixture.repository.seed(ownerId, "Restore me", "owner");
    fixture.repository.members.set(`${drawing.id}:${editorId}`, "editor");

    // Active drawings cannot be restored.
    const active = await request(fixture.app)
      .post(`/api/v1/drawings/${drawing.id}/restore`)
      .set("x-test-user", ownerId);
    expect(active.status).toBe(404);

    await request(fixture.app)
      .delete(`/api/v1/drawings/${drawing.id}`)
      .set("x-test-user", ownerId);

    const byEditor = await request(fixture.app)
      .post(`/api/v1/drawings/${drawing.id}/restore`)
      .set("x-test-user", editorId);
    expect(byEditor.status).toBe(404);

    const restored = await request(fixture.app)
      .post(`/api/v1/drawings/${drawing.id}/restore`)
      .set("x-test-user", ownerId);
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({
      id: drawing.id,
      title: "Restore me",
      role: "owner",
    });

    const list = await request(fixture.app)
      .get("/api/v1/drawings")
      .set("x-test-user", ownerId);
    expect(list.body.owned.map((entry: { id: string }) => entry.id)).toContain(
      drawing.id,
    );

    const trash = await request(fixture.app)
      .get("/api/v1/drawings/trash")
      .set("x-test-user", ownerId);
    expect(trash.body.drawings).toEqual([]);
  });

  it("permanently deletes only trashed drawings, owner only", async () => {
    const fixture = createFixture();
    const drawing = fixture.repository.seed(ownerId, "Purge me", "owner");
    fixture.repository.members.set(`${drawing.id}:${editorId}`, "editor");

    // Must be trashed first.
    const active = await request(fixture.app)
      .delete(`/api/v1/drawings/${drawing.id}/permanent`)
      .set("x-test-user", ownerId);
    expect(active.status).toBe(404);

    await request(fixture.app)
      .delete(`/api/v1/drawings/${drawing.id}`)
      .set("x-test-user", ownerId);

    const byEditor = await request(fixture.app)
      .delete(`/api/v1/drawings/${drawing.id}/permanent`)
      .set("x-test-user", editorId);
    expect(byEditor.status).toBe(404);

    const purged = await request(fixture.app)
      .delete(`/api/v1/drawings/${drawing.id}/permanent`)
      .set("x-test-user", ownerId);
    expect(purged.status).toBe(204);

    const restoreAfterPurge = await request(fixture.app)
      .post(`/api/v1/drawings/${drawing.id}/restore`)
      .set("x-test-user", ownerId);
    expect(restoreAfterPurge.status).toBe(404);
  });

  it("requires a valid session on every route", async () => {
    const fixture = createFixture();
    const response = await request(fixture.app).get("/api/v1/drawings");
    expect(response.status).toBe(401);
    expect(response.type).toBe("application/problem+json");
    expect(response.body.code).toBe("AUTHENTICATION_REQUIRED");
  });
});

function createFixture() {
  const repository = new InMemoryDrawingRepository();
  const service = new DrawingService(repository);
  const identity: IdentityService = {
    resolve(headers) {
      const userId =
        headers instanceof Headers
          ? headers.get("x-test-user")
          : typeof headers["x-test-user"] === "string"
            ? headers["x-test-user"]
            : null;
      return Promise.resolve(userId ? identityFor(userId) : null);
    },
  };
  const app = express();
  app.use(express.json());
  app.use(createDrawingRouter({ service, identity }));
  return { app, repository };
}

function identityFor(userId: string): RequestIdentity {
  return {
    userId,
    email: `${userId}@example.test`,
    name: "Test User",
    image: null,
    emailVerified: true,
    twoFactorEnabled: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    sessionId: randomUUID(),
    sessionExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
  };
}

function rename(
  app: express.Express,
  userId: string,
  drawingId: string,
  title: string,
  metadataRevision: string,
) {
  return request(app)
    .patch(`/api/v1/drawings/${drawingId}`)
    .set("x-test-user", userId)
    .send({ title, metadataRevision });
}

class InMemoryDrawingRepository implements DrawingRepository {
  public readonly drawings = new Map<string, AccessibleDrawing>();
  public readonly members = new Map<string, "editor" | "viewer">();
  public readonly deleted = new Map<string, Date>();
  public readonly tags = new Map<string, string[]>();

  private tagsFor(drawingId: string, userId: string): string[] {
    return this.tags.get(`${drawingId}:${userId}`) ?? [];
  }

  public seed(
    ownerUserId: string,
    title: string,
    role: "owner" | "editor" | "viewer",
    currentUserId: string = ownerUserId,
  ): AccessibleDrawing {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const drawing: AccessibleDrawing = {
      id: randomUUID(),
      title,
      ownerUserId,
      ownerName: "Owner",
      role: "owner",
      tags: [],
      contentRevision: 0n,
      metadataRevision: 0n,
      createdAt: now,
      updatedAt: now,
      thumbnailUpdatedAt: null,
      isTemplate: false,
    };
    this.drawings.set(drawing.id, drawing);
    if (role !== "owner") {
      this.members.set(`${drawing.id}:${currentUserId}`, role);
    }
    return { ...drawing, role };
  }

  public listForUser(userId: string) {
    const owned: AccessibleDrawing[] = [];
    const shared: AccessibleDrawing[] = [];
    for (const drawing of this.drawings.values()) {
      if (this.deleted.has(drawing.id)) continue;
      const tags = this.tagsFor(drawing.id, userId);
      if (drawing.ownerUserId === userId) {
        owned.push({ ...drawing, role: "owner", tags });
        continue;
      }
      const role = this.members.get(`${drawing.id}:${userId}`);
      if (role) shared.push({ ...drawing, role, tags });
    }
    return Promise.resolve({ owned, shared });
  }

  public findAccessible(drawingId: string, userId: string) {
    const drawing = this.drawings.get(drawingId);
    if (!drawing || this.deleted.has(drawingId)) return Promise.resolve(null);
    const tags = this.tagsFor(drawingId, userId);
    if (drawing.ownerUserId === userId) {
      return Promise.resolve({ ...drawing, role: "owner" as const, tags });
    }
    const role = this.members.get(`${drawingId}:${userId}`);
    return Promise.resolve(role ? { ...drawing, role, tags } : null);
  }

  public replaceTags(input: {
    drawingId: string;
    userId: string;
    tags: string[];
  }) {
    const key = `${input.drawingId}:${input.userId}`;
    if (input.tags.length === 0) {
      this.tags.delete(key);
    } else {
      this.tags.set(key, [...input.tags].sort());
    }
    return Promise.resolve();
  }

  public create(input: {
    ownerUserId: string;
    title: string;
    id?: string;
    idempotencyKey?: string;
  }): Promise<CreateDrawingResult> {
    const existing = input.id ? this.drawings.get(input.id) : undefined;
    if (existing) {
      // Same-owner reuse replays the existing drawing; another user's id
      // is a genuine conflict.
      return Promise.resolve(
        existing.ownerUserId === input.ownerUserId
          ? {
              status: "created",
              drawing: { ...existing, role: "owner" as const },
            }
          : { status: "conflict" },
      );
    }
    const seeded = this.seed(input.ownerUserId, input.title, "owner");
    if (!input.id) {
      return Promise.resolve({ status: "created", drawing: seeded });
    }
    // Re-key the seeded drawing under the client-supplied id.
    const stored = this.drawings.get(seeded.id)!;
    this.drawings.delete(seeded.id);
    stored.id = input.id;
    this.drawings.set(input.id, stored);
    return Promise.resolve({
      status: "created",
      drawing: { ...stored, role: "owner" },
    });
  }

  public readonly duplicatesByKey = new Map<string, string>();

  public duplicate(input: {
    sourceDrawingId: string;
    ownerUserId: string;
    idempotencyKey?: string;
  }): Promise<AccessibleDrawing | null> {
    const source = this.drawings.get(input.sourceDrawingId);
    if (!source || this.deleted.has(input.sourceDrawingId)) {
      return Promise.resolve(null);
    }
    const replayKey = input.idempotencyKey
      ? `${input.ownerUserId}:${input.idempotencyKey}`
      : null;
    if (replayKey) {
      const existingId = this.duplicatesByKey.get(replayKey);
      if (existingId) {
        return this.findAccessible(existingId, input.ownerUserId);
      }
    }
    const copy = this.seed(input.ownerUserId, `${source.title} copy`, "owner");
    if (replayKey) {
      this.duplicatesByKey.set(replayKey, copy.id);
    }
    return Promise.resolve(copy);
  }

  public async rename(input: {
    drawingId: string;
    actorUserId: string;
    title: string;
    expectedMetadataRevision: bigint;
    isTemplate?: boolean;
  }): Promise<RenameDrawingResult> {
    const accessible = await this.findAccessible(
      input.drawingId,
      input.actorUserId,
    );
    if (!accessible) return { status: "not-found" };
    const current = this.drawings.get(input.drawingId)!;
    if (current.metadataRevision !== input.expectedMetadataRevision) {
      return {
        status: "conflict",
        currentRevision: current.metadataRevision,
      };
    }
    current.title = input.title;
    current.isTemplate = input.isTemplate ?? current.isTemplate;
    current.metadataRevision += 1n;
    return {
      status: "updated",
      drawing: { ...current, role: accessible.role },
    };
  }

  public softDelete(input: { drawingId: string; ownerUserId: string }) {
    const drawing = this.drawings.get(input.drawingId);
    if (!drawing || drawing.ownerUserId !== input.ownerUserId) {
      return Promise.resolve("not-found" as const);
    }
    this.deleted.set(input.drawingId, new Date());
    return Promise.resolve("deleted" as const);
  }

  public listTrashedForUser(userId: string) {
    const trashed = [...this.deleted.entries()]
      .flatMap(([drawingId, deletedAt]) => {
        const drawing = this.drawings.get(drawingId);
        return drawing && drawing.ownerUserId === userId
          ? [
              {
                ...drawing,
                role: "owner" as const,
                tags: this.tagsFor(drawingId, userId),
                deletedAt,
              },
            ]
          : [];
      })
      .sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());
    return Promise.resolve(trashed);
  }

  public restore(input: { drawingId: string; ownerUserId: string }) {
    const drawing = this.drawings.get(input.drawingId);
    if (
      !drawing ||
      drawing.ownerUserId !== input.ownerUserId ||
      !this.deleted.has(input.drawingId)
    ) {
      return Promise.resolve("not-found" as const);
    }
    this.deleted.delete(input.drawingId);
    drawing.metadataRevision += 1n;
    return Promise.resolve("restored" as const);
  }

  public purge(input: { drawingId: string; ownerUserId: string }) {
    const drawing = this.drawings.get(input.drawingId);
    if (
      !drawing ||
      drawing.ownerUserId !== input.ownerUserId ||
      !this.deleted.has(input.drawingId)
    ) {
      return Promise.resolve("not-found" as const);
    }
    this.drawings.delete(input.drawingId);
    this.deleted.delete(input.drawingId);
    return Promise.resolve("purged" as const);
  }

  public leave(input: { drawingId: string; userId: string }) {
    return Promise.resolve(
      this.members.delete(`${input.drawingId}:${input.userId}`)
        ? ("left" as const)
        : ("not-found" as const),
    );
  }

  public transferOwnership(input: {
    drawingId: string;
    currentOwnerUserId: string;
    newOwnerUserId: string;
  }): Promise<TransferOwnershipResult> {
    if (input.newOwnerUserId === outsiderId) {
      return Promise.resolve({ status: "target-not-found" });
    }
    const drawing = this.drawings.get(input.drawingId);
    if (!drawing || drawing.ownerUserId !== input.currentOwnerUserId) {
      return Promise.resolve({ status: "not-found" });
    }
    this.members.delete(`${drawing.id}:${input.newOwnerUserId}`);
    this.members.set(`${drawing.id}:${input.currentOwnerUserId}`, "editor");
    drawing.ownerUserId = input.newOwnerUserId;
    drawing.metadataRevision += 1n;
    return Promise.resolve({
      status: "transferred",
      drawing: { ...drawing, role: "owner" },
    });
  }
}
