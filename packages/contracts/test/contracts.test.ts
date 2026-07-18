import { describe, expect, it } from "vitest";

import {
  adminOverviewSchema,
  adminUserListSchema,
  adminUserSchema,
  chatHistoryResponseSchema,
  chatMessageEventSchema,
  clientRealtimeEventSchema,
  createDrawingRequestSchema,
  createInvitationRequestSchema,
  currentUserSchema,
  fileIdSchema,
  problemDetailsSchema,
  revisionSchema,
  roleSchema,
  sceneEnvelopeSchema,
  serverRealtimeEventSchema,
} from "../src";

const drawingId = "a0d1c2e3-f456-4789-a012-3456789abcde";
const clientInstanceId = "b0d1c2e3-f456-4789-a012-3456789abcde";
const mutationId = "c0d1c2e3-f456-4789-a012-3456789abcde";

const element = {
  id: "element-1",
  type: "rectangle",
  version: 1,
  versionNonce: 42,
  isDeleted: false,
  index: "a0",
  customData: { preserved: true },
};

const scene = {
  type: "excalidraw" as const,
  version: 2,
  source: "https://example.com",
  elements: [element],
  appState: { viewBackgroundColor: "#ffffff" },
};

describe("common contracts", () => {
  it("accepts roles and decimal revisions", () => {
    expect(roleSchema.parse("owner")).toBe("owner");
    expect(revisionSchema.parse("9007199254740993")).toBe("9007199254740993");
  });

  it("rejects invalid roles and unsafe revision representations", () => {
    expect(roleSchema.safeParse("admin").success).toBe(false);
    expect(revisionSchema.safeParse(1).success).toBe(false);
    expect(revisionSchema.safeParse("01").success).toBe(false);
    expect(fileIdSchema.safeParse("unsafe/file").success).toBe(false);
    expect(fileIdSchema.safeParse("safe_file-id").success).toBe(true);
  });

  it("requires stable problem detail fields", () => {
    expect(
      problemDetailsSchema.parse({
        code: "VERSION_CONFLICT",
        status: 412,
        title: "The drawing changed",
        requestId: "request-1",
      }),
    ).toMatchObject({ code: "VERSION_CONFLICT", status: 412 });
  });
});

describe("scene contracts", () => {
  it("preserves unknown element fields", () => {
    const parsed = sceneEnvelopeSchema.parse(scene);

    expect(parsed.elements[0]?.customData).toEqual({ preserved: true });
  });

  it("rejects embedded binary files", () => {
    expect(
      sceneEnvelopeSchema.safeParse({ ...scene, files: { file: "data" } })
        .success,
    ).toBe(false);
  });
});

describe("drawing and sharing contracts", () => {
  it("normalizes a drawing title and validates invitations", () => {
    expect(
      createDrawingRequestSchema.parse({ title: "  Architecture  " }).title,
    ).toBe("Architecture");
    expect(
      createInvitationRequestSchema.parse({
        email: "person@example.com",
        role: "editor",
      }),
    ).toEqual({ email: "person@example.com", role: "editor" });
  });
});

describe("admin contracts", () => {
  const adminUser = {
    id: drawingId,
    name: "Ada",
    email: "ada@example.com",
    emailVerified: true,
    createdAt: "2026-07-15T10:00:00.000+00:00",
    disabledAt: null,
    drawingCount: 3,
  };

  it("requires isAdmin on the current user", () => {
    expect(
      currentUserSchema.parse({
        id: drawingId,
        email: "ada@example.com",
        name: "Ada",
        image: null,
        emailVerified: true,
        isAdmin: true,
        createdAt: "2026-07-15T10:00:00.000+00:00",
      }).isAdmin,
    ).toBe(true);
    expect(
      currentUserSchema.safeParse({
        id: drawingId,
        email: "ada@example.com",
        name: "Ada",
        image: null,
        emailVerified: true,
        createdAt: "2026-07-15T10:00:00.000+00:00",
      }).success,
    ).toBe(false);
  });

  it("parses the admin overview and user list", () => {
    expect(
      adminOverviewSchema.parse({ users: 12, drawings: 40, storageBytes: 2048 })
        .storageBytes,
    ).toBe(2048);
    expect(adminUserSchema.parse(adminUser).disabledAt).toBeNull();
    expect(
      adminUserSchema.parse({
        ...adminUser,
        disabledAt: "2026-07-16T10:00:00.000+00:00",
      }).disabledAt,
    ).toBe("2026-07-16T10:00:00.000+00:00");
    expect(
      adminUserListSchema.parse({ users: [adminUser], total: 1 }).users,
    ).toHaveLength(1);
  });

  it("rejects negative counts and unknown fields", () => {
    expect(
      adminOverviewSchema.safeParse({
        users: -1,
        drawings: 0,
        storageBytes: 0,
      }).success,
    ).toBe(false);
    expect(
      adminUserSchema.safeParse({ ...adminUser, drawingCount: -1 }).success,
    ).toBe(false);
    expect(
      adminUserSchema.safeParse({ ...adminUser, extra: true }).success,
    ).toBe(false);
  });
});

describe("realtime contracts", () => {
  it("parses client join and mutation events", () => {
    expect(
      clientRealtimeEventSchema.parse({
        type: "room.join",
        protocolVersion: 1,
        drawingId,
        clientInstanceId,
        lastRevision: "0",
      }).type,
    ).toBe("room.join");

    expect(
      clientRealtimeEventSchema.parse({
        type: "scene.mutate",
        mutationId,
        baseRevision: "1",
        elements: [element],
      }).type,
    ).toBe("scene.mutate");
  });

  it("parses a canonical committed event", () => {
    expect(
      serverRealtimeEventSchema.parse({
        type: "scene.committed",
        mutationId,
        revision: "2",
        elements: [element],
      }).type,
    ).toBe("scene.committed");
  });

  it("parses chat events and history", () => {
    expect(
      clientRealtimeEventSchema.parse({
        type: "chat.send",
        messageId: mutationId,
        body: "move the login box left",
      }).type,
    ).toBe("chat.send");

    const message = {
      id: mutationId,
      drawingId,
      userId: clientInstanceId,
      authorName: "Ada",
      body: "done",
      createdAt: "2026-07-15T10:00:00.000+00:00",
    };
    expect(
      chatMessageEventSchema.parse({ type: "chat.message", message }).message
        .body,
    ).toBe("done");
    expect(
      chatHistoryResponseSchema.parse({ messages: [message], nextCursor: null })
        .messages,
    ).toHaveLength(1);
  });

  it("rejects invalid chat payloads", () => {
    expect(
      clientRealtimeEventSchema.safeParse({
        type: "chat.send",
        messageId: mutationId,
        body: "",
      }).success,
    ).toBe(false);
    expect(
      clientRealtimeEventSchema.safeParse({
        type: "chat.send",
        messageId: mutationId,
        body: "x".repeat(4_001),
      }).success,
    ).toBe(false);
    expect(
      clientRealtimeEventSchema.safeParse({
        type: "chat.send",
        messageId: mutationId,
        body: "hi",
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown event types and numeric revisions", () => {
    expect(
      clientRealtimeEventSchema.safeParse({ type: "scene.unknown" }).success,
    ).toBe(false);
    expect(
      clientRealtimeEventSchema.safeParse({
        type: "scene.mutate",
        mutationId,
        baseRevision: 1,
        elements: [element],
      }).success,
    ).toBe(false);
  });
});
