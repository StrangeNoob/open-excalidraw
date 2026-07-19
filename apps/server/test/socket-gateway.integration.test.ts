import type { ClientRealtimeEvent, Role } from "@open-excalidraw/contracts";
import type { Server, Socket } from "socket.io";

import type {
  IdentityService,
  RequestIdentity,
} from "../src/modules/auth/identity.js";
import {
  attachCollaborationGateway,
  type GatewayChatService,
  type GatewayMutationService,
  type GatewayPresenceChange,
  type GatewayPresenceParticipant,
  type GatewayRoomEvent,
  type GatewaySnapshot,
} from "../src/modules/collaboration/socket-gateway.js";
import {
  StrictOriginPolicy,
  type SocketAuthorizationBinding,
} from "../src/modules/collaboration/security/index.js";

const DRAWING_ID = "a0d1c2e3-f456-4789-a012-3456789abcde";
const OTHER_DRAWING_ID = "b0d1c2e3-f456-4789-a012-3456789abcde";
const EDITOR_ID = "10000000-0000-4000-8000-000000000001";
const VIEWER_ID = "10000000-0000-4000-8000-000000000002";
const CLIENT_ID = "20000000-0000-4000-8000-000000000001";
const ORIGIN = "https://draw.example.test";
const NOW = new Date("2026-07-11T10:00:00.000Z");
const SHARE_LINK_ID = "60000000-0000-4000-8000-000000000001";
const SHARE_TOKEN = "s".repeat(43);

describe("collaboration socket gateway", () => {
  it("rejects an untrusted or unauthenticated Socket.IO upgrade", async () => {
    const fixture = createFixture();
    const wrongOrigin = fixture.connect("wrong-origin", EDITOR_ID, {
      origin: "https://evil.example.test",
    });
    const noSession = fixture.connect("no-session", null);

    await vi.waitFor(() => {
      expect(wrongOrigin.connectError).not.toBeNull();
      expect(noSession.connectError).not.toBeNull();
    });
    expect(connectErrorData(wrongOrigin)).toMatchObject({
      code: "SOCKET_ORIGIN_DENIED",
      type: "protocol.error",
    });
    expect(connectErrorData(noSession)).toMatchObject({
      code: "SOCKET_UNAUTHENTICATED",
      type: "protocol.error",
    });
    expect(fixture.gateway.connectionCount()).toBe(0);
  });

  it("rejects a nonmember join with a structured error", async () => {
    const fixture = createFixture();
    const outsider = fixture.connect("outsider", VIEWER_ID);

    outsider.clientEmit("room.join", joinEvent());

    await vi.waitFor(() => expect(outsider.disconnected).toBe(true));
    expect(outsider.events("protocol.error")).toContainEqual(
      expect.objectContaining({
        code: "SOCKET_NOT_MEMBER",
        retryable: false,
        type: "protocol.error",
      }),
    );
  });

  it("lets viewers receive live commits but rejects raw viewer mutation", async () => {
    const fixture = createFixture();
    fixture.roles.set(roleKey(EDITOR_ID), "editor");
    fixture.roles.set(roleKey(VIEWER_ID), "viewer");
    const editor = fixture.connect("editor", EDITOR_ID);
    const viewer = fixture.connect("viewer", VIEWER_ID);
    await join(editor);
    await join(viewer);

    viewer.clientEmit(
      "scene.mutate",
      mutationEvent("30000000-0000-4000-8000-000000000001"),
    );
    await vi.waitFor(() =>
      expect(viewer.events("protocol.error")).toContainEqual(
        expect.objectContaining({ code: "SOCKET_EVENT_FORBIDDEN" }),
      ),
    );
    expect(fixture.mutate).not.toHaveBeenCalled();
    expect(fixture.securityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "scene.mutate",
        actorUserId: VIEWER_ID,
        drawingId: DRAWING_ID,
      }),
    );

    viewer.clientEmit("scene.preview", previewEvent());
    await vi.waitFor(() =>
      expect(fixture.securityAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "scene.preview" }),
      ),
    );
    expect(fixture.preview.latest(viewer.id)).toBeNull();

    editor.clientEmit(
      "scene.mutate",
      mutationEvent("30000000-0000-4000-8000-000000000002"),
    );
    await vi.waitFor(() =>
      expect(viewer.events("scene.committed")).toHaveLength(1),
    );
    expect(editor.events("scene.committed")).toHaveLength(1);
    expect(fixture.sessionActive).toHaveBeenCalledWith(
      `session-${EDITOR_ID}`,
      EDITOR_ID,
    );
  });

  it("applies a live role demotion before the next queued mutation", async () => {
    const fixture = createFixture();
    fixture.roles.set(roleKey(EDITOR_ID), "editor");
    const editor = fixture.connect("editor", EDITOR_ID);
    await join(editor);

    fixture.roles.set(roleKey(EDITOR_ID), "viewer");
    fixture.rooms.changeRole(DRAWING_ID, EDITOR_ID, "viewer");
    expect(editor.events("room.roleChanged")).toContainEqual({
      role: "viewer",
      type: "room.roleChanged",
    });

    editor.clientEmit(
      "scene.mutate",
      mutationEvent("30000000-0000-4000-8000-000000000003"),
    );
    await vi.waitFor(() =>
      expect(editor.events("protocol.error")).toContainEqual(
        expect.objectContaining({ code: "SOCKET_EVENT_FORBIDDEN" }),
      ),
    );
    expect(fixture.mutate).not.toHaveBeenCalled();
  });

  it("clears a revoked connection preview and resyncs remaining members", async () => {
    const fixture = createFixture();
    fixture.roles.set(roleKey(EDITOR_ID), "editor");
    fixture.roles.set(roleKey(VIEWER_ID), "viewer");
    const editor = fixture.connect("editor", EDITOR_ID);
    const viewer = fixture.connect("viewer", VIEWER_ID);
    await join(editor);
    await join(viewer);

    editor.clientEmit("scene.preview", previewEvent());
    await vi.waitFor(() =>
      expect(viewer.events("scene.preview")).toHaveLength(1),
    );
    expect(fixture.preview.latest(editor.id)).not.toBeNull();

    fixture.roles.delete(roleKey(EDITOR_ID));
    fixture.rooms.revoke(DRAWING_ID, EDITOR_ID);

    expect(editor.disconnected).toBe(true);
    expect(fixture.preview.latest(editor.id)).toBeNull();
    expect(fixture.presence.roster()).toHaveLength(1);
    await vi.waitFor(() =>
      expect(viewer.events("room.resyncRequired")).toContainEqual({
        reason: "stale-preview",
        revision: "7",
        type: "room.resyncRequired",
      }),
    );
  });

  it("signals a revision gap and follows it with a canonical snapshot", async () => {
    const fixture = createFixture();
    fixture.roles.set(roleKey(EDITOR_ID), "editor");
    const editor = fixture.connect("editor", EDITOR_ID);

    editor.clientEmit("room.join", { ...joinEvent(), lastRevision: "2" });

    await vi.waitFor(() => expect(editor.events("room.ready")).toHaveLength(1));
    expect(editor.events("room.resyncRequired")).toEqual([
      {
        reason: "revision-gap",
        revision: "7",
        type: "room.resyncRequired",
      },
    ]);
    expect(editor.events("room.ready")[0]).toMatchObject({
      revision: "7",
      role: "editor",
      snapshot: fixture.snapshot.snapshot,
      type: "room.ready",
    });
  });

  it("requests a canonical resync for every socket after a revision restore", async () => {
    const fixture = createFixture();
    fixture.roles.set(roleKey(EDITOR_ID), "editor");
    fixture.roles.set(roleKey(VIEWER_ID), "viewer");
    const editor = fixture.connect("restore-editor", EDITOR_ID);
    const viewer = fixture.connect("restore-viewer", VIEWER_ID);
    await join(editor);
    await join(viewer);

    fixture.rooms.requestResync(DRAWING_ID, 12n, "revision-restored");

    const expected = {
      reason: "revision-restored",
      revision: "12",
      type: "room.resyncRequired",
    };
    expect(editor.events("room.resyncRequired")).toContainEqual(expected);
    expect(viewer.events("room.resyncRequired")).toContainEqual(expected);
  });

  it("expires silent presence and disconnects the stale socket", async () => {
    const fixture = createFixture({ presenceSweepIntervalMs: 5 });
    fixture.roles.set(roleKey(EDITOR_ID), "editor");
    const editor = fixture.connect("idle-editor", EDITOR_ID);
    await join(editor);

    fixture.presence.expire(editor.id);

    await vi.waitFor(() => expect(editor.disconnected).toBe(true));
    expect(fixture.presence.roster()).toHaveLength(0);
    expect(fixture.rooms.getBinding(editor.id)).toBeNull();
    fixture.gateway.close();
  });

  it("bounds a flooding client queue and disconnects it safely", async () => {
    let releaseMutation!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const fixture = createFixture({
      maxQueuedEvents: 2,
      mutate: vi.fn<GatewayMutationService["mutate"]>(
        async (_binding, event) => {
          await blocked;
          return committed(event);
        },
      ),
    });
    fixture.roles.set(roleKey(EDITOR_ID), "editor");
    const editor = fixture.connect("editor", EDITOR_ID);
    await join(editor);

    editor.clientEmit(
      "scene.mutate",
      mutationEvent("30000000-0000-4000-8000-000000000011"),
    );
    await vi.waitFor(() => expect(fixture.mutate).toHaveBeenCalledOnce());
    editor.clientEmit(
      "scene.mutate",
      mutationEvent("30000000-0000-4000-8000-000000000012"),
    );
    editor.clientEmit(
      "scene.mutate",
      mutationEvent("30000000-0000-4000-8000-000000000013"),
    );

    await vi.waitFor(() => expect(editor.disconnected).toBe(true));
    expect(editor.events("protocol.error")).toContainEqual(
      expect.objectContaining({ code: "SOCKET_BACKPRESSURE_LIMIT" }),
    );
    expect(fixture.mutate).toHaveBeenCalledOnce();
    releaseMutation();
  });

  it("lets a viewer send chat and broadcasts to the room including the sender", async () => {
    const fixture = createFixture();
    fixture.roles.set(roleKey(EDITOR_ID), "editor");
    fixture.roles.set(roleKey(VIEWER_ID), "viewer");
    const editor = fixture.connect("editor", EDITOR_ID);
    const viewer = fixture.connect("viewer", VIEWER_ID);
    await join(editor);
    await join(viewer);

    viewer.clientEmit("chat.send", chatSendEvent("can you zoom the header?"));

    await vi.waitFor(() => {
      expect(viewer.events("chat.message")).toHaveLength(1);
      expect(editor.events("chat.message")).toHaveLength(1);
    });
    expect(viewer.events("chat.message")[0]).toMatchObject({
      type: "chat.message",
      message: {
        userId: VIEWER_ID,
        body: "can you zoom the header?",
      },
    });
    expect(viewer.disconnected).toBe(false);
  });

  it("skips the broadcast for a duplicate chat messageId", async () => {
    const fixture = createFixture({
      chatSend: vi.fn().mockResolvedValue(null),
    });
    fixture.roles.set(roleKey(EDITOR_ID), "editor");
    const editor = fixture.connect("editor", EDITOR_ID);
    await join(editor);

    editor.clientEmit("chat.send", chatSendEvent("again"));

    await vi.waitFor(() => expect(fixture.chatSend).toHaveBeenCalledOnce());
    expect(editor.events("chat.message")).toHaveLength(0);
    expect(editor.events("protocol.error")).toHaveLength(0);
  });

  it("reports a chat rate limit as retryable without disconnecting", async () => {
    const rateLimitError = Object.assign(
      new Error("Chat message rate exceeded"),
      {
        code: "CHAT_RATE_LIMITED",
        retryable: true,
      },
    );
    const fixture = createFixture({
      chatSend: vi.fn().mockRejectedValue(rateLimitError),
    });
    fixture.roles.set(roleKey(EDITOR_ID), "editor");
    const editor = fixture.connect("editor", EDITOR_ID);
    await join(editor);

    editor.clientEmit("chat.send", chatSendEvent("spam"));

    await vi.waitFor(() =>
      expect(editor.events("protocol.error")).toContainEqual(
        expect.objectContaining({ code: "CHAT_RATE_LIMITED", retryable: true }),
      ),
    );
    expect(editor.disconnected).toBe(false);
  });

  it("rejects chat before the room join completes", async () => {
    const fixture = createFixture();
    fixture.roles.set(roleKey(EDITOR_ID), "editor");
    const editor = fixture.connect("editor", EDITOR_ID);

    editor.clientEmit("chat.send", chatSendEvent("too early"));

    await vi.waitFor(() =>
      expect(editor.events("protocol.error")).toContainEqual(
        expect.objectContaining({ code: "SOCKET_NOT_JOINED" }),
      ),
    );
    expect(fixture.chatSend).not.toHaveBeenCalled();
  });

  it("gives a share-link viewer a live read-only room", async () => {
    const fixture = createFixture();
    fixture.roles.set(roleKey(EDITOR_ID), "editor");
    fixture.shareLinks.set(SHARE_TOKEN, {
      drawingId: DRAWING_ID,
      linkId: SHARE_LINK_ID,
    });
    const editor = fixture.connect("editor", EDITOR_ID);
    const shareViewer = fixture.connect("share-viewer", null, {
      auth: { shareToken: SHARE_TOKEN },
    });
    await join(editor);
    await join(shareViewer);

    expect(shareViewer.events("room.ready")[0]).toMatchObject({
      revision: "7",
      role: "viewer",
      snapshot: fixture.snapshot.snapshot,
      type: "room.ready",
    });
    // Anonymous viewers never enter presence: members-only roster.
    expect(
      fixture.presence.roster().map((participant) => participant.connectionId),
    ).toEqual([editor.id]);

    editor.clientEmit(
      "scene.mutate",
      mutationEvent("30000000-0000-4000-8000-000000000031"),
    );
    await vi.waitFor(() =>
      expect(shareViewer.events("scene.committed")).toHaveLength(1),
    );
  });

  it("never delivers chat to share-link viewers", async () => {
    const fixture = createFixture();
    fixture.roles.set(roleKey(EDITOR_ID), "editor");
    fixture.roles.set(roleKey(VIEWER_ID), "viewer");
    fixture.shareLinks.set(SHARE_TOKEN, {
      drawingId: DRAWING_ID,
      linkId: SHARE_LINK_ID,
    });
    const editor = fixture.connect("editor", EDITOR_ID);
    const viewer = fixture.connect("viewer", VIEWER_ID);
    const shareViewer = fixture.connect("share-viewer", null, {
      auth: { shareToken: SHARE_TOKEN },
    });
    await join(editor);
    await join(viewer);
    await join(shareViewer);

    editor.clientEmit("chat.send", chatSendEvent("members only"));

    await vi.waitFor(() => {
      expect(editor.events("chat.message")).toHaveLength(1);
      expect(viewer.events("chat.message")).toHaveLength(1);
    });
    expect(shareViewer.events("chat.message")).toHaveLength(0);
  });

  it("rejects every emit from a share-link viewer and disconnects on repeat", async () => {
    const fixture = createFixture();
    fixture.shareLinks.set(SHARE_TOKEN, {
      drawingId: DRAWING_ID,
      linkId: SHARE_LINK_ID,
    });
    const shareViewer = fixture.connect("share-viewer", null, {
      auth: { shareToken: SHARE_TOKEN },
    });
    await join(shareViewer);

    shareViewer.clientEmit(
      "scene.mutate",
      mutationEvent("30000000-0000-4000-8000-000000000041"),
    );
    shareViewer.clientEmit("chat.send", chatSendEvent("hello?"));
    shareViewer.clientEmit("presence.update", {
      idleState: "active",
      type: "presence.update",
    });

    await vi.waitFor(() => expect(shareViewer.disconnected).toBe(true));
    const forbidden = shareViewer
      .events("protocol.error")
      .filter(
        (event) =>
          (event as { code: string }).code === "SOCKET_EVENT_FORBIDDEN",
      );
    expect(forbidden).toHaveLength(3);
    expect(fixture.mutate).not.toHaveBeenCalled();
    expect(fixture.chatSend).not.toHaveBeenCalled();
  });

  it("kicks live share viewers when the link is revoked", async () => {
    const fixture = createFixture();
    fixture.shareLinks.set(SHARE_TOKEN, {
      drawingId: DRAWING_ID,
      linkId: SHARE_LINK_ID,
    });
    const shareViewer = fixture.connect("share-viewer", null, {
      auth: { shareToken: SHARE_TOKEN },
    });
    await join(shareViewer);

    fixture.shareLinks.delete(SHARE_TOKEN);
    fixture.rooms.revoke(DRAWING_ID, `share:${SHARE_LINK_ID}`);

    expect(shareViewer.disconnected).toBe(true);
    expect(shareViewer.events("protocol.error")).toContainEqual(
      expect.objectContaining({ code: "SOCKET_MEMBERSHIP_REVOKED" }),
    );
  });

  it("rejects a join when the link is revoked during authorization", async () => {
    let resolutions = 0;
    const fixture = createFixture({
      // Calls 1-2 are the upgrade and the join authorization; returning null
      // from call 3 simulates a revoke landing between token resolution and
      // binding registration, which only the post-registration recheck sees.
      resolveToken: (token) => {
        resolutions += 1;
        return Promise.resolve(
          token === SHARE_TOKEN && resolutions <= 2
            ? { drawingId: DRAWING_ID, linkId: SHARE_LINK_ID }
            : null,
        );
      },
    });
    const shareViewer = fixture.connect("share-viewer", null, {
      auth: { shareToken: SHARE_TOKEN },
    });

    shareViewer.clientEmit("room.join", joinEvent());

    await vi.waitFor(() => expect(shareViewer.disconnected).toBe(true));
    expect(shareViewer.events("protocol.error")).toContainEqual(
      expect.objectContaining({ code: "SOCKET_NOT_MEMBER" }),
    );
    expect(shareViewer.events("room.ready")).toHaveLength(0);
    expect(fixture.rooms.getBinding(shareViewer.id)).toBeNull();
  });

  it("rejects unknown share tokens at the upgrade", async () => {
    const fixture = createFixture();
    const shareViewer = fixture.connect("share-viewer", null, {
      auth: { shareToken: SHARE_TOKEN },
    });

    await vi.waitFor(() => expect(shareViewer.connectError).not.toBeNull());
    expect(connectErrorData(shareViewer)).toMatchObject({
      code: "SOCKET_UNAUTHENTICATED",
      type: "protocol.error",
    });
  });

  it("rejects a share token that belongs to a different drawing", async () => {
    const fixture = createFixture();
    fixture.shareLinks.set(SHARE_TOKEN, {
      drawingId: OTHER_DRAWING_ID,
      linkId: SHARE_LINK_ID,
    });
    const shareViewer = fixture.connect("share-viewer", null, {
      auth: { shareToken: SHARE_TOKEN },
    });

    shareViewer.clientEmit("room.join", joinEvent());

    await vi.waitFor(() => expect(shareViewer.disconnected).toBe(true));
    expect(shareViewer.events("protocol.error")).toContainEqual(
      expect.objectContaining({ code: "SOCKET_NOT_MEMBER" }),
    );
  });

  it("never broadcasts when durable persistence fails", async () => {
    const fixture = createFixture({
      mutate: vi.fn().mockRejectedValue(new Error("database secret")),
    });
    fixture.roles.set(roleKey(EDITOR_ID), "editor");
    fixture.roles.set(roleKey(VIEWER_ID), "viewer");
    const editor = fixture.connect("editor", EDITOR_ID);
    const viewer = fixture.connect("viewer", VIEWER_ID);
    await join(editor);
    await join(viewer);

    editor.clientEmit(
      "scene.mutate",
      mutationEvent("30000000-0000-4000-8000-000000000021"),
    );

    await vi.waitFor(() =>
      expect(editor.events("protocol.error")).toContainEqual(
        expect.objectContaining({ code: "COLLABORATION_INTERNAL_ERROR" }),
      ),
    );
    expect(editor.events("scene.committed")).toHaveLength(0);
    expect(viewer.events("scene.committed")).toHaveLength(0);
    expect(JSON.stringify(editor.events("protocol.error"))).not.toContain(
      "database secret",
    );
  });
});

function createFixture(
  overrides: {
    chatSend?: GatewayChatService["send"];
    maxQueuedEvents?: number;
    mutate?: GatewayMutationService["mutate"];
    presenceSweepIntervalMs?: number;
    resolveToken?: (
      token: string,
    ) => Promise<{ linkId: string; drawingId: string } | null>;
  } = {},
) {
  const server = new FakeServer();
  const roles = new Map<string, Role>();
  const shareLinks = new Map<string, { linkId: string; drawingId: string }>();
  const rooms = new FakeRoomRegistry();
  const presence = new FakePresenceService();
  const preview = new FakePreviewService();
  const sessionActive = vi.fn().mockResolvedValue(true);
  const securityAudit = vi.fn().mockResolvedValue(undefined);
  const snapshot: GatewaySnapshot = {
    assetManifest: [],
    drawingId: DRAWING_ID,
    revision: 7n,
    role: "editor",
    snapshot: {
      appState: {},
      elements: [],
      source: "test",
      type: "excalidraw",
      version: 2,
    },
  };
  const defaultMutate: GatewayMutationService["mutate"] = (_binding, event) =>
    Promise.resolve(committed(event));
  const mutate = vi.fn<GatewayMutationService["mutate"]>(
    overrides.mutate ?? defaultMutate,
  );
  const defaultChatSend: GatewayChatService["send"] = (binding, event) =>
    Promise.resolve({
      id: event.messageId,
      drawingId: binding.drawingId,
      userId: binding.userId,
      authorName: "Test User",
      body: event.body,
      createdAt: NOW.toISOString(),
    });
  const chatSend = vi.fn<GatewayChatService["send"]>(
    overrides.chatSend ?? defaultChatSend,
  );
  const identityService: IdentityService = {
    resolve: (headers) => {
      const userId = readHeader(headers, "x-test-user");
      return Promise.resolve(userId ? identity(userId) : null);
    },
  };

  const gateway = attachCollaborationGateway(server as unknown as Server, {
    chatService: { send: chatSend },
    identityService,
    maxQueuedEvents: overrides.maxQueuedEvents,
    membershipResolver: {
      getRole: (drawingId, userId) =>
        Promise.resolve(roles.get(`${drawingId}:${userId}`) ?? null),
    },
    mutationService: { mutate },
    now: () => NOW,
    originPolicy: new StrictOriginPolicy([ORIGIN]),
    presenceService: presence,
    presenceSweepIntervalMs: overrides.presenceSweepIntervalMs,
    previewService: preview,
    roomRegistry: rooms,
    securityAudit,
    sessionValidityResolver: { isSessionActive: sessionActive },
    shareLinkResolver: {
      resolveToken: (token) =>
        overrides.resolveToken
          ? overrides.resolveToken(token)
          : Promise.resolve(shareLinks.get(token) ?? null),
    },
    snapshotProvider: {
      loadSnapshot: (drawingId, userId) => {
        const role = roles.get(`${drawingId}:${userId}`);
        return Promise.resolve(role ? { ...snapshot, drawingId, role } : null);
      },
      loadPublicSnapshot: (drawingId) =>
        Promise.resolve({ ...snapshot, drawingId, role: "viewer" as const }),
    },
  });

  return {
    connect(
      id: string,
      userId: string | null,
      socketOptions: { auth?: Record<string, string>; origin?: string } = {},
    ) {
      const socket = new FakeSocket(
        server,
        id,
        userId,
        socketOptions.origin,
        socketOptions.auth,
      );
      socket.setConnection(server.connect(socket));
      return socket;
    },
    chatSend,
    gateway,
    mutate,
    presence,
    preview,
    roles,
    rooms,
    securityAudit,
    server,
    sessionActive,
    shareLinks,
    snapshot,
  };
}

const join = async (socket: FakeSocket) => {
  socket.clientEmit("room.join", joinEvent());
  await vi.waitFor(() => expect(socket.events("room.ready")).toHaveLength(1));
};

const joinEvent = (): Extract<ClientRealtimeEvent, { type: "room.join" }> => ({
  clientInstanceId: CLIENT_ID,
  drawingId: DRAWING_ID,
  protocolVersion: 1,
  type: "room.join",
});

const mutationEvent = (
  mutationId: string,
): Extract<ClientRealtimeEvent, { type: "scene.mutate" }> => ({
  baseRevision: "7",
  elements: [
    {
      id: "element",
      isDeleted: false,
      type: "rectangle",
      version: 2,
      versionNonce: 3,
    },
  ],
  mutationId,
  type: "scene.mutate",
});

const chatSendEvent = (
  body: string,
): Extract<ClientRealtimeEvent, { type: "chat.send" }> => ({
  body,
  messageId: "50000000-0000-4000-8000-000000000001",
  type: "chat.send",
});

const previewEvent = (): Extract<
  ClientRealtimeEvent,
  { type: "scene.preview" }
> => ({
  baseRevision: "7",
  elements: mutationEvent("30000000-0000-4000-8000-000000000099").elements,
  previewId: "40000000-0000-4000-8000-000000000001",
  type: "scene.preview",
});

const committed = (
  event: Extract<ClientRealtimeEvent, { type: "scene.mutate" }>,
) =>
  ({
    event: {
      elements: event.elements,
      mutationId: event.mutationId,
      revision: "8",
      type: "scene.committed",
    },
    kind: "committed",
  }) as const;

const identity = (userId: string): RequestIdentity => ({
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  email: `${userId}@example.test`,
  emailVerified: true,
  image: null,
  name: userId === VIEWER_ID ? "Viewer" : "Editor",
  sessionExpiresAt: new Date("2026-07-11T11:00:00.000Z"),
  sessionId: `session-${userId}`,
  twoFactorEnabled: false,
  userId,
});

const roleKey = (userId: string) => `${DRAWING_ID}:${userId}`;

class FakeRoomRegistry {
  readonly #bindings = new Map<string, SocketAuthorizationBinding>();
  readonly #listeners = new Set<(event: GatewayRoomEvent) => void>();

  join(binding: SocketAuthorizationBinding) {
    this.#bindings.set(binding.connectionId, binding);
  }

  leave(connectionId: string) {
    const binding = this.#bindings.get(connectionId) ?? null;
    this.#bindings.delete(connectionId);
    return binding;
  }

  getBinding(connectionId: string) {
    return this.#bindings.get(connectionId) ?? null;
  }

  list(drawingId: string) {
    return [...this.#bindings.values()].filter(
      (binding) => binding.drawingId === drawingId,
    );
  }

  changeRole(drawingId: string, userId: string, role: Role) {
    const changed: GatewayRoomEvent[] = [];
    for (const [connectionId, binding] of this.#bindings) {
      if (binding.drawingId !== drawingId || binding.userId !== userId) {
        continue;
      }
      const next = Object.freeze({ ...binding, role });
      this.#bindings.set(connectionId, next);
      const event: GatewayRoomEvent = {
        binding: next,
        connectionId,
        drawingId,
        event: { role, type: "room.roleChanged" },
        type: "role-changed",
        userId,
      };
      changed.push(event);
      for (const listener of this.#listeners) {
        listener(event);
      }
    }
    return changed;
  }

  revoke(drawingId: string, userId: string) {
    const revoked: GatewayRoomEvent[] = [];
    for (const [connectionId, binding] of this.#bindings) {
      if (binding.drawingId !== drawingId || binding.userId !== userId) {
        continue;
      }
      this.#bindings.delete(connectionId);
      const event: GatewayRoomEvent = {
        connectionId,
        drawingId,
        reason: "access-revoked",
        type: "revoked",
        userId,
      };
      revoked.push(event);
      for (const listener of this.#listeners) {
        listener(event);
      }
    }
    return revoked;
  }

  requestResync(
    drawingId: string,
    revision: bigint,
    reason: "revision-restored",
  ) {
    const event: GatewayRoomEvent = {
      drawingId,
      reason,
      revision,
      type: "resync-requested",
    };
    for (const listener of this.#listeners) listener(event);
    return event;
  }

  subscribe(listener: (event: GatewayRoomEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

class FakePresenceService {
  readonly #participants = new Map<string, GatewayPresenceParticipant>();
  readonly #sweepChanges: GatewayPresenceChange[] = [];

  join(
    binding: SocketAuthorizationBinding,
    profile: { name: string; image: string | null },
  ): Promise<GatewayPresenceChange> {
    const participant: GatewayPresenceParticipant = {
      connectionId: binding.connectionId,
      image: profile.image,
      name: profile.name,
      presence: {},
      role: binding.role,
      userId: binding.userId,
    };
    this.#participants.set(binding.connectionId, participant);
    return Promise.resolve({
      connectionId: binding.connectionId,
      drawingId: binding.drawingId,
      kind: "joined",
      participant,
    });
  }

  update(
    binding: SocketAuthorizationBinding,
    event: Extract<ClientRealtimeEvent, { type: "presence.update" }>,
  ): Promise<GatewayPresenceChange> {
    const current = this.#participants.get(binding.connectionId)!;
    const { type: _type, ...presence } = event;
    void _type;
    const participant = { ...current, presence };
    this.#participants.set(binding.connectionId, participant);
    return Promise.resolve({
      connectionId: binding.connectionId,
      drawingId: binding.drawingId,
      kind: "updated",
      participant,
    });
  }

  leave(connectionId: string) {
    const participant = this.#participants.get(connectionId);
    this.#participants.delete(connectionId);
    return participant
      ? {
          connectionId,
          drawingId: DRAWING_ID,
          kind: "left" as const,
        }
      : null;
  }

  roster() {
    return [...this.#participants.values()];
  }

  sweep() {
    return this.#sweepChanges.splice(0);
  }

  expire(connectionId: string) {
    const participant = this.#participants.get(connectionId);
    if (!participant) {
      throw new Error(`Unknown presence connection: ${connectionId}`);
    }
    this.#participants.delete(connectionId);
    this.#sweepChanges.push({
      connectionId,
      drawingId: DRAWING_ID,
      kind: "left",
    });
  }
}

class FakePreviewService {
  readonly #latest = new Map<
    string,
    {
      drawingId: string;
      event: Extract<ClientRealtimeEvent, { type: "scene.preview" }>;
      excludeConnectionId: string;
    }
  >();

  clear(connectionId: string) {
    this.#latest.delete(connectionId);
  }

  latest(connectionId: string) {
    return this.#latest.get(connectionId) ?? null;
  }

  preview(
    binding: SocketAuthorizationBinding,
    event: Extract<ClientRealtimeEvent, { type: "scene.preview" }>,
  ) {
    const relay = {
      drawingId: binding.drawingId,
      event,
      excludeConnectionId: binding.connectionId,
    };
    this.#latest.set(binding.connectionId, relay);
    return Promise.resolve(relay);
  }
}

type EventHandler = (...args: unknown[]) => void;

class FakeSocket {
  readonly handshake;
  readonly received: Array<{ event: string; payload: unknown }> = [];
  readonly rooms = new Set<string>();
  readonly #handlers = new Map<string, EventHandler[]>();
  disconnected = false;
  connectError: (Error & { data?: unknown }) | null = null;
  #connection = Promise.resolve();

  constructor(
    private readonly server: FakeServer,
    readonly id: string,
    userId: string | null,
    origin = ORIGIN,
    auth: Record<string, string> = {},
  ) {
    this.handshake = {
      auth,
      headers: {
        origin,
        ...(userId ? { "x-test-user": userId } : {}),
      },
    };
  }

  on(event: string, handler: EventHandler) {
    const handlers = this.#handlers.get(event) ?? [];
    handlers.push(handler);
    this.#handlers.set(event, handlers);
    return this;
  }

  emit(event: string, payload: unknown) {
    this.received.push({ event, payload });
    return true;
  }

  clientEmit(event: string, payload: unknown) {
    void this.#connection.then(() => {
      for (const handler of this.#handlers.get(event) ?? []) {
        handler(payload);
      }
    });
  }

  events(event: string) {
    return this.received
      .filter((candidate) => candidate.event === event)
      .map((candidate) => candidate.payload);
  }

  join(room: string) {
    this.rooms.add(room);
    return Promise.resolve();
  }

  leave(room: string) {
    this.rooms.delete(room);
    return Promise.resolve();
  }

  to(room: string) {
    return this.server.operator(room, this.id);
  }

  disconnect() {
    if (this.disconnected) {
      return this;
    }
    this.disconnected = true;
    for (const handler of this.#handlers.get("disconnect") ?? []) {
      handler("server namespace disconnect");
    }
    return this;
  }

  setConnection(connection: Promise<void>) {
    this.#connection = connection.catch((caught: unknown) => {
      this.connectError =
        caught instanceof Error ? caught : new Error("Connection rejected");
      this.disconnected = true;
    });
  }
}

class FakeServer {
  readonly #sockets = new Map<string, FakeSocket>();
  #connectionHandler: ((socket: Socket) => void) | null = null;
  readonly #middlewares: Array<
    (socket: Socket, next: (error?: Error) => void) => void
  > = [];

  use(middleware: (socket: Socket, next: (error?: Error) => void) => void) {
    this.#middlewares.push(middleware);
    return this;
  }

  on(event: string, handler: (socket: Socket) => void) {
    if (event === "connection") {
      this.#connectionHandler = handler;
    }
    return this;
  }

  async connect(socket: FakeSocket) {
    this.#sockets.set(socket.id, socket);
    for (const middleware of this.#middlewares) {
      await new Promise<void>((resolve, reject) => {
        middleware(socket as unknown as Socket, (error) =>
          error ? reject(error) : resolve(),
        );
      });
    }
    this.#connectionHandler?.(socket as unknown as Socket);
  }

  to(room: string) {
    return this.operator(room);
  }

  operator(room: string, excludedConnectionId?: string) {
    const emit = (event: string, payload: unknown) => {
      for (const socket of this.#sockets.values()) {
        if (
          socket.rooms.has(room) &&
          socket.id !== excludedConnectionId &&
          !socket.disconnected
        ) {
          socket.emit(event, payload);
        }
      }
      return true;
    };
    return { emit, volatile: { emit } };
  }
}

function readHeader(
  headers: Headers | Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  const value = headers[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function connectErrorData(socket: FakeSocket) {
  return socket.connectError?.data;
}
