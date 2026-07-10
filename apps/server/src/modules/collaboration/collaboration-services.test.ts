import { randomUUID } from "node:crypto";

import type { Role } from "@open-excalidraw/contracts";

import { MinimumIntervalRateLimiter, type Clock } from "./core/index.js";
import { ReconciliationLimitError } from "./core/reconcile.js";
import { MutationService } from "./mutation-service.js";
import { PresenceService } from "./presence-service.js";
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
