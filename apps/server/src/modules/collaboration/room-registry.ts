import type { Role } from "@open-excalidraw/contracts";

import {
  withServerRole,
  type SocketAuthorizationBinding,
} from "./security/session.js";

export type RoomRegistryEvent =
  | {
      type: "resync-requested";
      drawingId: string;
      revision: bigint;
      reason: "revision-restored";
    }
  | {
      type: "role-changed";
      drawingId: string;
      userId: string;
      connectionId: string;
      binding: SocketAuthorizationBinding;
      event: { type: "room.roleChanged"; role: Role };
    }
  | {
      type: "revoked";
      drawingId: string;
      userId: string;
      connectionId: string;
      reason: "access-revoked";
    };

export type RoomRegistryListener = (event: RoomRegistryEvent) => void;

export class RoomRegistry {
  readonly #byConnection = new Map<string, SocketAuthorizationBinding>();
  readonly #roomConnections = new Map<string, Set<string>>();
  readonly #listeners = new Set<RoomRegistryListener>();

  public join(binding: SocketAuthorizationBinding): void {
    this.leave(binding.connectionId);
    this.#byConnection.set(binding.connectionId, binding);
    const room = this.#roomConnections.get(binding.drawingId) ?? new Set();
    room.add(binding.connectionId);
    this.#roomConnections.set(binding.drawingId, room);
  }

  public leave(connectionId: string): SocketAuthorizationBinding | null {
    const binding = this.#byConnection.get(connectionId);
    if (!binding) return null;
    this.#byConnection.delete(connectionId);
    const room = this.#roomConnections.get(binding.drawingId);
    room?.delete(connectionId);
    if (room?.size === 0) this.#roomConnections.delete(binding.drawingId);
    return binding;
  }

  public connectionCount(): number {
    return this.#byConnection.size;
  }

  public getBinding(connectionId: string): SocketAuthorizationBinding | null {
    return this.#byConnection.get(connectionId) ?? null;
  }

  public list(drawingId: string): SocketAuthorizationBinding[] {
    const room = this.#roomConnections.get(drawingId);
    if (!room) return [];
    return [...room]
      .map((connectionId) => this.#byConnection.get(connectionId))
      .filter((binding): binding is SocketAuthorizationBinding =>
        Boolean(binding),
      );
  }

  public changeRole(drawingId: string, userId: string, role: Role) {
    const events: Extract<RoomRegistryEvent, { type: "role-changed" }>[] = [];
    for (const binding of this.#matching(drawingId, userId)) {
      const updated = withServerRole(binding, role);
      this.#byConnection.set(binding.connectionId, updated);
      const event = {
        type: "role-changed" as const,
        drawingId,
        userId,
        connectionId: binding.connectionId,
        binding: updated,
        event: { type: "room.roleChanged" as const, role },
      };
      events.push(event);
      this.#notify(event);
    }
    return events;
  }

  public revoke(drawingId: string, userId: string) {
    const events: Extract<RoomRegistryEvent, { type: "revoked" }>[] = [];
    for (const binding of this.#matching(drawingId, userId)) {
      this.leave(binding.connectionId);
      const event = {
        type: "revoked" as const,
        drawingId,
        userId,
        connectionId: binding.connectionId,
        reason: "access-revoked" as const,
      };
      events.push(event);
      this.#notify(event);
    }
    return events;
  }

  public subscribe(listener: RoomRegistryListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public requestResync(
    drawingId: string,
    revision: bigint,
    reason: "revision-restored",
  ) {
    const event = {
      type: "resync-requested" as const,
      drawingId,
      revision,
      reason,
    };
    this.#notify(event);
    return event;
  }

  #matching(drawingId: string, userId: string) {
    return this.list(drawingId).filter((binding) => binding.userId === userId);
  }

  #notify(event: RoomRegistryEvent) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Registry state and other subscribers must not be left partially
        // updated because one transport listener failed.
      }
    }
  }
}
