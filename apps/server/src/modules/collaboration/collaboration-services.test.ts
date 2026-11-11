import { randomUUID } from "node:crypto";

import type { Role } from "@open-excalidraw/contracts";

import {
  MinimumIntervalRateLimiter,
  TokenBucketRateLimiter,
  type Clock,
} from "./core/index.js";
import { ReconciliationLimitError } from "./core/reconcile.js";
import { MutationService } from "./mutation-service.js";
import { PresenceRateLimitError, PresenceService } from "./presence-service.js";
import { PreviewService } from "./preview-service.js";
import { RoomRegistry } from "./room-registry.js";
import type {
  DrawingMembershipResolver,
  SocketAuthorizationBinding,
  SocketSessionValidityResolver,
} from "./security/index.js";

const drawingId = randomUUID();
const userId = randomUUID();

describe("collaboration ephemeral services", () => {
  it("never returns a publishable mutation when persistence fails", async () => {
    const service = new MutationService({
      repository: {
        loadSnapshot: () => Promise.resolve(null),
        persist: () => Promise.reject(new Error("database unavailable")),
      },
      sessionValidityResolver: activeSessions,
    });

    await expect(
      service.mutate(binding("editor"), {
        type: "scene.mutate",
        mutationId: randomUUID(),
        baseRevision: "0",
        elements: [element("failed")],
      }),
    ).rejects.toThrow("database unavailable");
  });

  it("rejects deeply nested passthrough payloads before calling persistence", async () => {
    const persist = vi.fn();
    const service = new MutationService({
      repository: {
        loadSnapshot: () => Promise.resolve(null),
        persist,
      },
      sessionValidityResolver: activeSessions,
    });
    let customData: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 20_000; depth += 1) {
      customData = { child: customData };
    }

    await expect(
      service.mutate(binding("editor"), {
        type: "scene.mutate",
        mutationId: randomUUID(),
        baseRevision: "0",
        elements: [{ ...element("deep"), customData }],
      }),
    ).rejects.toBeInstanceOf(ReconciliationLimitError);
    expect(persist).not.toHaveBeenCalled();
  });

  it("relays editor previews without persistence and rejects viewer previews", async () => {
    const roles = roleResolver("editor");
    const clock = new MutableClock();
    const service = new PreviewService({
      sessionValidityResolver: activeSessions,
      membershipResolver: roles,
      rateLimiter: new MinimumIntervalRateLimiter(100, clock),
    });
    const editor = binding("editor", "editor-connection");
    const event = {
      type: "scene.preview" as const,
      previewId: randomUUID(),
      baseRevision: "5",
      elements: [element("preview")],
    };
    await expect(service.preview(editor, event)).resolves.toEqual({
      drawingId,
      excludeConnectionId: editor.connectionId,
      event,
    });
    expect(service.latest(editor.connectionId)?.event.previewId).toBe(
      event.previewId,
    );

    roles.role = "viewer";
    await expect(
      service.preview(binding("viewer"), event),
    ).rejects.toMatchObject({
      code: "SOCKET_EVENT_FORBIDDEN",
    });
  });

  it("supports viewer presence, cursor updates, idle transitions, and heartbeat expiry", async () => {
    const clock = new MutableClock();
    const roles = roleResolver("viewer");
    const service = new PresenceService({
      sessionValidityResolver: activeSessions,
      membershipResolver: roles,
      clock,
      heartbeatTimeoutMs: 1_000,
      idleAfterMs: 100,
      awayAfterMs: 500,
    });
    const viewer = binding("viewer");
    expect(
      await service.join(viewer, { name: "Viewer", image: null }),
    ).toMatchObject({
      kind: "joined",
      participant: { role: "viewer" },
    });
    expect(
      await service.update(viewer, {
        type: "presence.update",
        pointer: { x: 10, y: 20, tool: "pointer" },
        button: "down",
      }),
    ).toMatchObject({
      kind: "updated",
      participant: { presence: { pointer: { x: 10, y: 20 } } },
    });

    clock.advance(100);
    expect(service.sweep()).toEqual([
      expect.objectContaining({
        kind: "idle",
        participant: expect.objectContaining({
          presence: expect.objectContaining({ idleState: "idle" }),
        }),
      }),
    ]);
    clock.advance(900);
    expect(service.sweep()).toEqual([
      expect.objectContaining({
        kind: "left",
        connectionId: viewer.connectionId,
      }),
    ]);
    expect(service.roster(drawingId)).toEqual([]);
  });

  it("keeps rate-limited connections alive for the heartbeat sweep", async () => {
    const clock = new MutableClock();
    const service = new PresenceService({
      sessionValidityResolver: activeSessions,
      membershipResolver: roleResolver("editor"),
      rateLimiter: new TokenBucketRateLimiter({
        capacity: 1,
        refillTokensPerSecond: 0.000001,
        clock,
      }),
      clock,
      heartbeatTimeoutMs: 1_000,
      idleAfterMs: 10_000,
      awayAfterMs: 50_000,
    });
    const editor = binding("editor");
    await service.join(editor, { name: "Editor", image: null });

    const update = () =>
      service.update(editor, { type: "presence.update", idleState: "active" });
    // Exhaust the one-token bucket so every later update is rejected.
    await update();
    await expect(update()).rejects.toBeInstanceOf(PresenceRateLimitError);

    // Stay chatty-but-rate-limited past the heartbeat timeout: the sweep
    // must not expire a connection the limiter has just heard from.
    clock.advance(900);
    await expect(update()).rejects.toBeInstanceOf(PresenceRateLimitError);
    clock.advance(900);
    expect(service.sweep().filter(({ kind }) => kind === "left")).toEqual([]);
    expect(service.roster(drawingId)).toHaveLength(1);

    // Gone silent: past the timeout with no traffic at all, it expires.
    clock.advance(1_100);
    expect(service.sweep()).toContainEqual(
      expect.objectContaining({ kind: "left" }),
    );
  });

  it("updates roles and removes revoked bindings before notifying subscribers", () => {
    const registry = new RoomRegistry();
    const first = binding("editor", "first");
    const second = binding("editor", "second");
    registry.join(first);
    registry.join(second);
    const received: string[] = [];
    registry.subscribe((event) => {
      received.push(event.type);
      if (event.type === "revoked") {
        expect(registry.getBinding(event.connectionId)).toBeNull();
      }
    });
    registry.subscribe(() => {
      throw new Error("broken transport listener");
    });

    expect(registry.changeRole(drawingId, userId, "viewer")).toHaveLength(2);
    expect(
      registry.list(drawingId).every((item) => item.role === "viewer"),
    ).toBe(true);
    expect(registry.revoke(drawingId, userId)).toHaveLength(2);
    expect(registry.list(drawingId)).toEqual([]);
    expect(received).toEqual([
      "role-changed",
      "role-changed",
      "revoked",
      "revoked",
    ]);
  });
});

const activeSessions: SocketSessionValidityResolver = {
  isSessionActive: () => Promise.resolve(true),
};

function binding(
  role: Role,
  connectionId = "connection",
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

function roleResolver(initialRole: Role) {
  const resolver: DrawingMembershipResolver & { role: Role | null } = {
    role: initialRole,
    getRole() {
      return Promise.resolve(this.role);
    },
  };
  return resolver;
}

function element(id: string) {
  return {
    id,
    type: "rectangle",
    version: 1,
    versionNonce: 1,
    isDeleted: false,
  };
}

class MutableClock implements Clock {
  #now = 0;
  public now() {
    return this.#now;
  }
  public advance(milliseconds: number) {
    this.#now += milliseconds;
  }
}
