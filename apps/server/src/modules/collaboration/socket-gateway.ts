import {
  presenceUpdateEventSchema,
  roomJoinEventSchema,
  sceneMutateEventSchema,
  scenePreviewEventSchema,
  type ClientRealtimeEvent,
  type ServerRealtimeEvent,
} from "@open-excalidraw/contracts";
import { randomUUID } from "node:crypto";
import type { Server, Socket } from "socket.io";
import { ZodError, type ZodType } from "zod";

import type { IdentityService } from "../auth/identity.js";
import { ReconciliationLimitError } from "./core/reconcile.js";
import {
  authorizeSocketEvent,
  authorizeSocketJoin,
  assertActiveIdentity,
  assertNoClientAuthorizationClaims,
  SocketSecurityError,
  withServerRole,
  type DrawingMembershipResolver,
  type SocketAuthorizationBinding,
  type SocketSessionValidityResolver,
  type StrictOriginPolicy,
} from "./security/index.js";

type ScenePreviewEvent = Extract<
  ClientRealtimeEvent,
  { type: "scene.preview" }
>;
type SceneMutateEvent = Extract<ClientRealtimeEvent, { type: "scene.mutate" }>;
type PresenceUpdateEvent = Extract<
  ClientRealtimeEvent,
  { type: "presence.update" }
>;
type RoomReadyEvent = Extract<ServerRealtimeEvent, { type: "room.ready" }>;
type SceneCommittedEvent = Extract<
  ServerRealtimeEvent,
  { type: "scene.committed" }
>;
type SceneAckEvent = Extract<ServerRealtimeEvent, { type: "scene.ack" }>;
type Collaborator = RoomReadyEvent["collaborators"][number];

export type GatewayMutationOutcome =
  | { kind: "committed"; event: SceneCommittedEvent }
  | { kind: "ack"; event: SceneAckEvent };

export interface GatewayMutationService {
  mutate(
    binding: SocketAuthorizationBinding,
    event: SceneMutateEvent,
  ): Promise<GatewayMutationOutcome>;
}

export interface GatewayPreviewService {
  clear(connectionId: string): void;
  latest(connectionId: string): { drawingId: string } | null;
  preview(
    binding: SocketAuthorizationBinding,
    event: ScenePreviewEvent,
  ): Promise<{
    drawingId: string;
    event: ScenePreviewEvent;
    excludeConnectionId: string;
  }>;
}

export interface GatewayPresenceParticipant {
  connectionId: string;
  userId: string;
  name: string;
  image: string | null;
  role: SocketAuthorizationBinding["role"];
  presence: Omit<PresenceUpdateEvent, "type">;
}

export interface GatewayPresenceChange {
  connectionId: string;
  drawingId: string;
  kind: "joined" | "updated" | "idle" | "left";
  participant?: GatewayPresenceParticipant;
}

export interface GatewayPresenceService {
  join(
    binding: SocketAuthorizationBinding,
    profile: { name: string; image: string | null },
  ): Promise<GatewayPresenceChange>;
  update(
    binding: SocketAuthorizationBinding,
    event: PresenceUpdateEvent,
  ): Promise<GatewayPresenceChange>;
  leave(connectionId: string): GatewayPresenceChange | null;
  roster(drawingId: string): readonly GatewayPresenceParticipant[];
  sweep(): GatewayPresenceChange[];
}

export type GatewayRoomEvent =
  | {
      type: "resync-requested";
      drawingId: string;
      revision: bigint;
      reason: "revision-restored";
    }
  | {
      type: "role-changed";
      connectionId: string;
      drawingId: string;
      userId: string;
      binding: SocketAuthorizationBinding;
      event: {
        type: "room.roleChanged";
        role: SocketAuthorizationBinding["role"];
      };
    }
  | {
      type: "revoked";
      connectionId: string;
      drawingId: string;
      userId: string;
      reason: "access-revoked";
    };

export interface GatewayRoomRegistry {
  join(binding: SocketAuthorizationBinding): void;
  leave(connectionId: string): SocketAuthorizationBinding | null;
  getBinding(connectionId: string): SocketAuthorizationBinding | null;
  list(drawingId: string): readonly SocketAuthorizationBinding[];
  changeRole(
    drawingId: string,
    userId: string,
    role: SocketAuthorizationBinding["role"],
  ): readonly GatewayRoomEvent[];
  revoke(drawingId: string, userId: string): readonly GatewayRoomEvent[];
  requestResync(
    drawingId: string,
    revision: bigint,
    reason: "revision-restored",
  ): GatewayRoomEvent;
  subscribe(listener: (event: GatewayRoomEvent) => void): () => void;
}

export interface GatewaySnapshot {
  assetManifest: RoomReadyEvent["assetManifest"];
  drawingId: string;
  revision: bigint;
  role: SocketAuthorizationBinding["role"];
  snapshot: RoomReadyEvent["snapshot"];
}

export interface CollaborationSnapshotProvider {
  loadSnapshot(
    drawingId: string,
    userId: string,
  ): Promise<GatewaySnapshot | null>;
}

export interface CollaborationGatewayOptions {
  identityService: IdentityService;
  membershipResolver: DrawingMembershipResolver;
  mutationService: GatewayMutationService;
  originPolicy: StrictOriginPolicy;
  presenceService: GatewayPresenceService;
  previewService: GatewayPreviewService;
  roomRegistry: GatewayRoomRegistry;
  sessionValidityResolver: SocketSessionValidityResolver;
  snapshotProvider: CollaborationSnapshotProvider;
  securityAudit?: (event: {
    action: "scene.mutate" | "scene.preview";
    actorUserId: string;
    drawingId: string;
    requestId: string;
  }) => Promise<void>;
  maxQueuedEvents?: number;
  maxProtocolViolations?: number;
  presenceSweepIntervalMs?: number;
  now?: () => Date;
}

export interface CollaborationGateway {
  close(): void;
  connectionCount(): number;
}

const ROOM_PREFIX = "drawing:";

/**
 * Attaches a dependency-injected, server-authoritative collaboration gateway.
 * The global server owns the Socket.IO instance and calls close during shutdown.
 */
export function attachCollaborationGateway(
  io: Server,
  options: CollaborationGatewayOptions,
): CollaborationGateway {
  const sockets = new Map<string, Socket>();
  const queues = new Map<string, BoundedSerialQueue>();
  const bindings = new Map<string, SocketAuthorizationBinding>();
  const now = options.now ?? (() => new Date());
  const maxQueuedEvents = options.maxQueuedEvents ?? 64;
  const maxProtocolViolations = options.maxProtocolViolations ?? 3;
  assertPositiveInteger(maxQueuedEvents, "maxQueuedEvents");
  assertPositiveInteger(maxProtocolViolations, "maxProtocolViolations");
  const presenceSweepIntervalMs = options.presenceSweepIntervalMs ?? 15_000;
  assertPositiveInteger(presenceSweepIntervalMs, "presenceSweepIntervalMs");

  io.use((socket, next) => {
    void authenticateUpgrade(socket, options, now())
      .then(() => next())
      .catch((caught: unknown) => next(toSocketConnectError(caught)));
  });

  const emitRoster = (drawingId: string) => {
    io.to(roomName(drawingId)).emit("presence.roster", {
      collaborators: collaboratorsFor(
        options.presenceService.roster(drawingId),
        options.roomRegistry,
      ),
    });
  };

  const unsubscribeRoomEvents = options.roomRegistry.subscribe((event) => {
    if (event.type === "resync-requested") {
      io.to(roomName(event.drawingId)).emit("room.resyncRequired", {
        type: "room.resyncRequired",
        reason: event.reason,
        revision: event.revision.toString(),
      });
      return;
    }
    const socket = sockets.get(event.connectionId);
    if (!socket) {
      return;
    }

    if (event.type === "role-changed") {
      bindings.set(event.connectionId, event.binding);
      emitServerEvent(socket, event.event);
      emitRoster(event.drawingId);
      return;
    }

    emitProtocolError(
      socket,
      "SOCKET_MEMBERSHIP_REVOKED",
      "Drawing access was revoked",
      false,
    );
    queues.get(socket.id)?.close();
    const binding = bindings.get(event.connectionId);
    const hadPreview = Boolean(
      options.previewService.latest(event.connectionId),
    );
    options.previewService.clear(event.connectionId);
    options.presenceService.leave(event.connectionId);
    bindings.delete(event.connectionId);
    void socket.leave(roomName(event.drawingId));
    socket.disconnect(true);
    emitRoster(event.drawingId);
    if (binding && hadPreview) {
      void requestRoomResync(io, binding, options).catch(() => undefined);
    }
  });

  const presenceSweep = setInterval(() => {
    for (const change of options.presenceService.sweep()) {
      if (change.kind === "left") {
        const socket = sockets.get(change.connectionId);
        const binding = bindings.get(change.connectionId);
        queues.get(change.connectionId)?.close();
        void (
          socket && binding
            ? clearPreviewAndRequestResync(socket, binding, options)
            : Promise.resolve()
        )
          .catch(() => undefined)
          .finally(() => {
            options.previewService.clear(change.connectionId);
            options.roomRegistry.leave(change.connectionId);
            bindings.delete(change.connectionId);
            socket?.disconnect(true);
            emitRoster(change.drawingId);
          });
      } else if (change.participant) {
        io.to(roomName(change.drawingId)).emit("presence.updated", {
          connectionId: change.connectionId,
          presence: {
            type: "presence.update",
            ...change.participant.presence,
          },
        });
      }
      if (change.kind !== "left") {
        emitRoster(change.drawingId);
      }
    }
  }, presenceSweepIntervalMs);
  presenceSweep.unref();

  io.on("connection", (socket) => {
    sockets.set(socket.id, socket);
    let violations = 0;
    let disposed = false;

    const queue = new BoundedSerialQueue(maxQueuedEvents, () => {
      emitProtocolError(
        socket,
        "SOCKET_BACKPRESSURE_LIMIT",
        "Too many collaboration events are pending",
        true,
      );
      socket.disconnect(true);
    });
    queues.set(socket.id, queue);

    const handleError = async (
      caught: unknown,
      auditAction?: "scene.mutate" | "scene.preview",
    ) => {
      if (disposed) {
        return;
      }
      const protocol = toProtocolError(caught);
      const requestId = randomUUID();
      emitProtocolError(
        socket,
        protocol.code,
        protocol.message,
        protocol.retryable,
        requestId,
      );

      if (protocol.code === "SOCKET_EVENT_FORBIDDEN" && auditAction) {
        const binding = options.roomRegistry.getBinding(socket.id);
        if (binding) {
          await options
            .securityAudit?.({
              action: auditAction,
              actorUserId: binding.userId,
              drawingId: binding.drawingId,
              requestId,
            })
            .catch(() => undefined);
        }
      }

      if (protocol.disconnect) {
        queue.close();
        socket.disconnect(true);
        return;
      }
      if (protocol.violation) {
        violations += 1;
        if (violations >= maxProtocolViolations) {
          queue.close();
          socket.disconnect(true);
        }
      }
    };

    const enqueue = (
      task: () => Promise<void>,
      auditAction?: "scene.mutate" | "scene.preview",
    ) => {
      queue.enqueue(async () => {
        try {
          await task();
        } catch (caught) {
          await handleError(caught, auditAction);
        }
      });
    };

    socket.on("room.join", (raw: unknown) => {
      enqueue(async () => {
        const event = parseEvent(roomJoinEventSchema, raw);
        bindings.delete(socket.id);
        await leaveCurrentRoom(socket, options, emitRoster);

        let binding = await authorizeSocketJoin({
          connectionId: socket.id,
          drawingId: event.drawingId,
          handshake: socket.handshake,
          identityService: options.identityService,
          membershipResolver: options.membershipResolver,
          originPolicy: options.originPolicy,
          now: now(),
        });
        const identity = await options.identityService.resolve(
          socket.handshake.headers,
        );
        if (
          !identity ||
          identity.userId !== binding.userId ||
          identity.sessionId !== binding.sessionId
        ) {
          throw new GatewayError(
            "SOCKET_SESSION_CHANGED",
            "The session changed while the room was joining",
            false,
            true,
          );
        }

        const snapshot = await options.snapshotProvider.loadSnapshot(
          binding.drawingId,
          binding.userId,
        );
        if (!snapshot) {
          throw new GatewayError(
            "SOCKET_NOT_MEMBER",
            "The drawing is unavailable or access was revoked",
            false,
            true,
          );
        }
        if (snapshot.role !== binding.role) {
          binding = withServerRole(binding, snapshot.role);
        }

        options.roomRegistry.join(binding);
        bindings.set(binding.connectionId, binding);
        await socket.join(roomName(binding.drawingId));
        try {
          await options.presenceService.join(binding, {
            image: identity.image,
            name: identity.name,
          });
        } catch (caught) {
          options.roomRegistry.leave(binding.connectionId);
          bindings.delete(binding.connectionId);
          await socket.leave(roomName(binding.drawingId));
          throw caught;
        }

        if (
          event.lastRevision !== undefined &&
          event.lastRevision !== snapshot.revision.toString()
        ) {
          emitServerEvent(socket, {
            type: "room.resyncRequired",
            reason: "revision-gap",
            revision: snapshot.revision.toString(),
          });
        }
        emitServerEvent(socket, {
          type: "room.ready",
          assetManifest: snapshot.assetManifest,
          collaborators: collaboratorsFor(
            options.presenceService.roster(binding.drawingId),
            options.roomRegistry,
          ),
          connectionId: binding.connectionId,
          revision: snapshot.revision.toString(),
          role: binding.role,
          snapshot: snapshot.snapshot,
        });
        emitRoster(binding.drawingId);
      });
    });

    socket.on("scene.preview", (raw: unknown) => {
      enqueue(async () => {
        const event = parseEvent(scenePreviewEventSchema, raw);
        const binding = await authorizeCurrent(
          socket,
          "scene.preview",
          options,
          now(),
        );
        const relay = await options.previewService.preview(binding, event);
        socket
          .to(roomName(relay.drawingId))
          .volatile.emit(relay.event.type, relay.event);
      }, "scene.preview");
    });

    socket.on("scene.mutate", (raw: unknown) => {
      enqueue(async () => {
        const event = parseEvent(sceneMutateEventSchema, raw);
        const binding = await authorizeCurrent(
          socket,
          "scene.mutate",
          options,
          now(),
        );
        const outcome = await options.mutationService.mutate(binding, event);
        if (outcome.kind === "committed") {
          // This is deliberately the only committed publish point. The durable
          // service has resolved after its database transaction committed.
          io.to(roomName(binding.drawingId)).emit(
            outcome.event.type,
            outcome.event,
          );
          return;
        }
        emitServerEvent(socket, outcome.event);
      }, "scene.mutate");
    });

    socket.on("presence.update", (raw: unknown) => {
      enqueue(async () => {
        const event = parseEvent(presenceUpdateEventSchema, raw);
        const binding = await authorizeCurrent(
          socket,
          "presence.update",
          options,
          now(),
        );
        const change = await options.presenceService.update(binding, event);
        socket.to(roomName(change.drawingId)).emit("presence.updated", {
          connectionId: change.connectionId,
          presence: event,
        });
        if (change.kind === "idle") {
          emitRoster(change.drawingId);
        }
      });
    });

    socket.on("disconnect", () => {
      disposed = true;
      queue.close();
      bindings.delete(socket.id);
      queues.delete(socket.id);
      sockets.delete(socket.id);
      void leaveCurrentRoom(socket, options, emitRoster);
    });
  });

  return {
    close() {
      clearInterval(presenceSweep);
      unsubscribeRoomEvents();
      for (const queue of queues.values()) {
        queue.close();
      }
      for (const socket of sockets.values()) {
        socket.disconnect(true);
      }
      queues.clear();
      sockets.clear();
      bindings.clear();
    },
    connectionCount: () => sockets.size,
  };
}

async function authorizeCurrent(
  socket: Socket,
  eventType: "presence.update" | "scene.mutate" | "scene.preview",
  options: CollaborationGatewayOptions,
  now: Date,
): Promise<SocketAuthorizationBinding> {
  let binding = options.roomRegistry.getBinding(socket.id);
  if (!binding) {
    throw new GatewayError(
      "SOCKET_NOT_JOINED",
      "Join a drawing before publishing collaboration events",
      false,
      false,
      true,
    );
  }

  const currentRole = await options.membershipResolver.getRole(
    binding.drawingId,
    binding.userId,
  );
  if (!currentRole) {
    options.roomRegistry.revoke(binding.drawingId, binding.userId);
    throw new GatewayError(
      "SOCKET_MEMBERSHIP_REVOKED",
      "Drawing access was revoked",
      false,
      true,
    );
  }
  if (currentRole !== binding.role) {
    options.roomRegistry.changeRole(
      binding.drawingId,
      binding.userId,
      currentRole,
    );
    binding =
      options.roomRegistry.getBinding(socket.id) ??
      withServerRole(binding, currentRole);
  }

  await authorizeSocketEvent(
    binding,
    eventType,
    options.sessionValidityResolver,
    now,
  );
  return binding;
}

async function leaveCurrentRoom(
  socket: Socket,
  options: CollaborationGatewayOptions,
  emitRoster: (drawingId: string) => void,
): Promise<void> {
  const binding = options.roomRegistry.leave(socket.id);
  if (!binding) {
    options.previewService.clear(socket.id);
    options.presenceService.leave(socket.id);
    return;
  }
  await clearPreviewAndRequestResync(socket, binding, options);
  options.presenceService.leave(socket.id);
  await socket.leave(roomName(binding.drawingId));
  emitRoster(binding.drawingId);
}

async function authenticateUpgrade(
  socket: Socket,
  options: CollaborationGatewayOptions,
  now: Date,
): Promise<void> {
  options.originPolicy.assertAllowed(socket.handshake.headers);
  assertNoClientAuthorizationClaims(socket.handshake.auth);
  const identity = await options.identityService.resolve(
    socket.handshake.headers,
  );
  assertActiveIdentity(identity, now);
}

async function clearPreviewAndRequestResync(
  socket: Socket,
  binding: SocketAuthorizationBinding,
  options: CollaborationGatewayOptions,
): Promise<void> {
  const preview = options.previewService.latest(binding.connectionId);
  options.previewService.clear(binding.connectionId);
  if (!preview) {
    return;
  }

  const snapshotBinding =
    options.roomRegistry
      .list(binding.drawingId)
      .find((candidate) => candidate.connectionId !== binding.connectionId) ??
    binding;
  let snapshot: GatewaySnapshot | null;
  try {
    snapshot = await options.snapshotProvider.loadSnapshot(
      snapshotBinding.drawingId,
      snapshotBinding.userId,
    );
  } catch {
    // Preview cleanup is mandatory; resync is best effort during disconnect.
    return;
  }
  if (!snapshot) {
    return;
  }
  socket.to(roomName(binding.drawingId)).emit("room.resyncRequired", {
    type: "room.resyncRequired",
    reason: "stale-preview",
    revision: snapshot.revision.toString(),
  });
}

async function requestRoomResync(
  io: Server,
  binding: SocketAuthorizationBinding,
  options: CollaborationGatewayOptions,
): Promise<void> {
  const snapshotBinding =
    options.roomRegistry
      .list(binding.drawingId)
      .find((candidate) => candidate.connectionId !== binding.connectionId) ??
    binding;
  const snapshot = await options.snapshotProvider.loadSnapshot(
    snapshotBinding.drawingId,
    snapshotBinding.userId,
  );
  if (!snapshot) return;
  io.to(roomName(binding.drawingId)).emit("room.resyncRequired", {
    type: "room.resyncRequired",
    reason: "stale-preview",
    revision: snapshot.revision.toString(),
  });
}

function collaboratorsFor(
  participants: readonly GatewayPresenceParticipant[],
  rooms: GatewayRoomRegistry,
): Collaborator[] {
  return participants.map((participant) => ({
    connectionId: participant.connectionId,
    image: participant.image,
    name: participant.name,
    role: rooms.getBinding(participant.connectionId)?.role ?? participant.role,
    userId: participant.userId,
  }));
}

function parseEvent<T>(schema: ZodType<T>, raw: unknown): T {
  return schema.parse(raw);
}

function emitServerEvent(socket: Socket, event: ServerRealtimeEvent): void {
  socket.emit(event.type, event);
}

function emitProtocolError(
  socket: Socket,
  code: string,
  message: string,
  retryable: boolean,
  requestId = randomUUID(),
): void {
  emitServerEvent(socket, {
    type: "protocol.error",
    code: code.slice(0, 128) || "PROTOCOL_ERROR",
    message: message.slice(0, 1_024) || "Collaboration request failed",
    requestId,
    retryable,
  });
}

interface MappedProtocolError {
  code: string;
  disconnect: boolean;
  message: string;
  retryable: boolean;
  violation: boolean;
}

function toProtocolError(caught: unknown): MappedProtocolError {
  if (caught instanceof GatewayError) {
    return caught;
  }
  if (caught instanceof SocketSecurityError) {
    return {
      code: caught.code,
      disconnect:
        caught.code === "SOCKET_SESSION_EXPIRED" ||
        caught.code === "SOCKET_SESSION_REVOKED" ||
        caught.code === "SOCKET_UNAUTHENTICATED" ||
        caught.code === "SOCKET_NOT_MEMBER",
      message: caught.message,
      retryable: false,
      violation:
        caught.code === "SOCKET_EVENT_FORBIDDEN" ||
        caught.code === "SOCKET_FORGED_AUTHORIZATION" ||
        caught.code === "SOCKET_ORIGIN_DENIED",
    };
  }
  if (caught instanceof ZodError) {
    return {
      code: "PROTOCOL_INVALID_EVENT",
      disconnect: false,
      message: "The collaboration event payload is invalid",
      retryable: false,
      violation: true,
    };
  }
  if (caught instanceof ReconciliationLimitError) {
    return {
      code: "ELEMENT_STRUCTURE_LIMIT_EXCEEDED",
      disconnect: false,
      message: caught.message,
      retryable: false,
      violation: false,
    };
  }
  const candidate = caught as {
    code?: unknown;
    message?: unknown;
    retryable?: unknown;
  };
  const safeCode =
    typeof candidate?.code === "string" &&
    SAFE_DOMAIN_ERROR_CODES.has(candidate.code)
      ? candidate.code
      : null;
  return {
    code: safeCode ?? "COLLABORATION_INTERNAL_ERROR",
    disconnect: false,
    message:
      safeCode && typeof candidate?.message === "string"
        ? candidate.message
        : "The collaboration event could not be processed",
    retryable:
      safeCode && typeof candidate?.retryable === "boolean"
        ? candidate.retryable
        : true,
    violation: false,
  };
}

const SAFE_DOMAIN_ERROR_CODES = new Set([
  "FUTURE_REVISION",
  "ELEMENT_LIMIT_EXCEEDED",
  "ASSET_LIMIT_EXCEEDED",
  "MISSING_ASSET",
  "MUTATION_ID_MISMATCH",
  "PRESENCE_RATE_LIMITED",
  "PREVIEW_RATE_LIMITED",
  "SCENE_TOO_LARGE",
]);

function toSocketConnectError(caught: unknown): Error & { data: unknown } {
  const protocol = toProtocolError(caught);
  const error = new Error(protocol.message) as Error & { data: unknown };
  error.data = {
    code: protocol.code,
    message: protocol.message,
    requestId: randomUUID(),
    retryable: protocol.retryable,
    type: "protocol.error",
  };
  return error;
}

class GatewayError extends Error implements MappedProtocolError {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly disconnect: boolean,
    public readonly violation = false,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

class BoundedSerialQueue {
  #tail = Promise.resolve();
  #pending = 0;
  #closed = false;

  public constructor(
    private readonly maximum: number,
    private readonly onOverflow: () => void,
  ) {}

  public enqueue(task: () => Promise<void>): void {
    if (this.#closed) {
      return;
    }
    if (this.#pending >= this.maximum) {
      this.#closed = true;
      this.onOverflow();
      return;
    }

    this.#pending += 1;
    this.#tail = this.#tail
      .then(() => (this.#closed ? undefined : task()))
      .catch(() => undefined)
      .finally(() => {
        this.#pending -= 1;
      });
  }

  public close(): void {
    this.#closed = true;
  }
}

function roomName(drawingId: string): string {
  return `${ROOM_PREFIX}${drawingId}`;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}
