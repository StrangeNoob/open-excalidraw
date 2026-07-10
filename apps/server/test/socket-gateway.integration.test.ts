import type { ClientRealtimeEvent, Role } from "@open-excalidraw/contracts";
import type { Server, Socket } from "socket.io";

import type {
  IdentityService,
  RequestIdentity,
} from "../src/modules/auth/identity.js";
import {
  attachCollaborationGateway,
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
const EDITOR_ID = "10000000-0000-4000-8000-000000000001";
const VIEWER_ID = "10000000-0000-4000-8000-000000000002";
const CLIENT_ID = "20000000-0000-4000-8000-000000000001";
const ORIGIN = "https://draw.example.test";
const NOW = new Date("2026-07-11T10:00:00.000Z");

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
    maxQueuedEvents?: number;
    mutate?: GatewayMutationService["mutate"];
    presenceSweepIntervalMs?: number;
  } = {},
) {
  const server = new FakeServer();
  const roles = new Map<string, Role>();
  const rooms = new FakeRoomRegistry();
  const presence = new FakePresenceService();
  const preview = new FakePreviewService();
  const sessionActive = vi.fn().mockResolvedValue(true);
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
  const identityService: IdentityService = {
    resolve: (headers) => {
      const userId = readHeader(headers, "x-test-user");
      return Promise.resolve(userId ? identity(userId) : null);
    },
  };

  const gateway = attachCollaborationGateway(server as unknown as Server, {
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
    sessionValidityResolver: { isSessionActive: sessionActive },
    snapshotProvider: {
      loadSnapshot: (drawingId, userId) => {
        const role = roles.get(`${drawingId}:${userId}`);
        return Promise.resolve(role ? { ...snapshot, drawingId, role } : null);
      },
    },
  });

  return {
    connect(
      id: string,
      userId: string | null,
      socketOptions: { origin?: string } = {},
    ) {
      const socket = new FakeSocket(server, id, userId, socketOptions.origin);
      socket.setConnection(server.connect(socket));
      return socket;
    },
    gateway,
    mutate,
    presence,
    preview,
    roles,
    rooms,
    server,
    sessionActive,
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
  ) {
    this.handshake = {
      auth: {},
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
