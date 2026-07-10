import type { ClientRealtimeEvent, Role } from "@open-excalidraw/contracts";
import { presenceUpdateEventSchema } from "@open-excalidraw/contracts";

import { TokenBucketRateLimiter, type Clock } from "./core/rate-limit.js";
import {
  authorizeSocketEvent,
  SocketSecurityError,
  type DrawingMembershipResolver,
  type SocketAuthorizationBinding,
  type SocketSessionValidityResolver,
} from "./security/index.js";

export type PresenceUpdateEvent = Extract<
  ClientRealtimeEvent,
  { type: "presence.update" }
>;
export type PresenceState = Omit<PresenceUpdateEvent, "type">;

export interface PresenceProfile {
  name: string;
  image: string | null;
}

export interface PresenceParticipant {
  connectionId: string;
  userId: string;
  name: string;
  image: string | null;
  role: Role;
  presence: PresenceState;
  lastHeartbeatAt: number;
  lastActivityAt: number;
}

export interface PresenceChange {
  kind: "joined" | "updated" | "idle" | "left";
  drawingId: string;
  connectionId: string;
  participant?: PresenceParticipant;
}

export class PresenceRateLimitError extends Error {
  public readonly code = "PRESENCE_RATE_LIMITED" as const;
  public constructor() {
    super("Presence update rate exceeded");
    this.name = "PresenceRateLimitError";
  }
}

const systemClock: Clock = { now: () => Date.now() };

export class PresenceService {
  readonly #participants = new Map<
    string,
    PresenceParticipant & { drawingId: string }
  >();
  readonly #clock: Clock;
  readonly #rateLimiter: TokenBucketRateLimiter;
  readonly #heartbeatTimeoutMs: number;
  readonly #idleAfterMs: number;
  readonly #awayAfterMs: number;

  public constructor(
    private readonly options: {
      sessionValidityResolver: SocketSessionValidityResolver;
      membershipResolver: DrawingMembershipResolver;
      rateLimiter?: TokenBucketRateLimiter;
      clock?: Clock;
      heartbeatTimeoutMs?: number;
      idleAfterMs?: number;
      awayAfterMs?: number;
    },
  ) {
    this.#clock = options.clock ?? systemClock;
    this.#rateLimiter =
      options.rateLimiter ??
      new TokenBucketRateLimiter({ capacity: 30, refillTokensPerSecond: 15 });
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
    this.#idleAfterMs = options.idleAfterMs ?? 60_000;
    this.#awayAfterMs = options.awayAfterMs ?? 5 * 60_000;
    if (
      this.#heartbeatTimeoutMs <= 0 ||
      this.#idleAfterMs <= 0 ||
      this.#awayAfterMs < this.#idleAfterMs
    ) {
      throw new RangeError("Presence expiry intervals are invalid");
    }
  }

  public async join(
    binding: SocketAuthorizationBinding,
    profile: PresenceProfile,
  ): Promise<PresenceChange> {
    const role = await this.#authorize(binding);
    const now = this.#clock.now();
    const participant = {
      connectionId: binding.connectionId,
      userId: binding.userId,
      name: profile.name,
      image: profile.image,
      role,
      presence: { idleState: "active" as const },
      lastHeartbeatAt: now,
      lastActivityAt: now,
      drawingId: binding.drawingId,
    };
    this.#participants.set(binding.connectionId, participant);
    return toChange("joined", participant);
  }

  public async update(
    binding: SocketAuthorizationBinding,
    event: PresenceUpdateEvent,
  ): Promise<PresenceChange> {
    const parsed = presenceUpdateEventSchema.parse(event);
    const role = await this.#authorize(binding);
    if (!this.#rateLimiter.tryConsume(binding.connectionId)) {
      throw new PresenceRateLimitError();
    }
    const existing = this.#requireParticipant(binding);
    const now = this.#clock.now();
    const participant = {
      ...existing,
      role,
      presence: { ...existing.presence, ...withoutType(parsed) },
      lastHeartbeatAt: now,
      lastActivityAt: now,
    };
    this.#participants.set(binding.connectionId, participant);
    return toChange("updated", participant);
  }

  public async heartbeat(binding: SocketAuthorizationBinding): Promise<void> {
    const role = await this.#authorize(binding);
    const existing = this.#requireParticipant(binding);
    this.#participants.set(binding.connectionId, {
      ...existing,
      role,
      lastHeartbeatAt: this.#clock.now(),
    });
  }

  public leave(connectionId: string): PresenceChange | null {
    const participant = this.#participants.get(connectionId);
    if (!participant) return null;
    this.#participants.delete(connectionId);
    this.#rateLimiter.delete(connectionId);
    return toChange("left", participant, false);
  }

  public sweep(): PresenceChange[] {
    const now = this.#clock.now();
    const changes: PresenceChange[] = [];
    for (const participant of [...this.#participants.values()]) {
      if (now - participant.lastHeartbeatAt >= this.#heartbeatTimeoutMs) {
        const change = this.leave(participant.connectionId);
        if (change) changes.push(change);
        continue;
      }
      const inactiveFor = now - participant.lastActivityAt;
      const idleState =
        inactiveFor >= this.#awayAfterMs
          ? ("away" as const)
          : inactiveFor >= this.#idleAfterMs
            ? ("idle" as const)
            : ("active" as const);
      if (participant.presence.idleState !== idleState) {
        const updated = {
          ...participant,
          presence: { ...participant.presence, idleState },
        };
        this.#participants.set(participant.connectionId, updated);
        changes.push(toChange("idle", updated));
      }
    }
    return changes;
  }

  public roster(drawingId: string): PresenceParticipant[] {
    return [...this.#participants.values()]
      .filter((participant) => participant.drawingId === drawingId)
      .map(stripDrawingId);
  }

  async #authorize(binding: SocketAuthorizationBinding): Promise<Role> {
    await authorizeSocketEvent(
      binding,
      "presence.update",
      this.options.sessionValidityResolver,
    );
    const role = await this.options.membershipResolver.getRole(
      binding.drawingId,
      binding.userId,
    );
    if (!role) {
      throw new SocketSecurityError(
        "SOCKET_NOT_MEMBER",
        "The user is no longer a member of this drawing",
      );
    }
    return role;
  }

  #requireParticipant(binding: SocketAuthorizationBinding) {
    const participant = this.#participants.get(binding.connectionId);
    if (
      !participant ||
      participant.drawingId !== binding.drawingId ||
      participant.userId !== binding.userId
    ) {
      throw new SocketSecurityError(
        "SOCKET_FORGED_AUTHORIZATION",
        "Presence connection does not match its server binding",
      );
    }
    return participant;
  }
}

function withoutType(event: PresenceUpdateEvent): PresenceState {
  const { type: _type, ...presence } = event;
  void _type;
  return presence;
}

function stripDrawingId(
  participant: PresenceParticipant & { drawingId: string },
): PresenceParticipant {
  const { drawingId: _drawingId, ...publicParticipant } = participant;
  void _drawingId;
  return publicParticipant;
}

function toChange(
  kind: PresenceChange["kind"],
  participant: PresenceParticipant & { drawingId: string },
  includeParticipant = true,
): PresenceChange {
  return {
    kind,
    drawingId: participant.drawingId,
    connectionId: participant.connectionId,
    ...(includeParticipant ? { participant: stripDrawingId(participant) } : {}),
  };
}
