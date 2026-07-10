import {
  scenePreviewEventSchema,
  type ClientRealtimeEvent,
} from "@open-excalidraw/contracts";

import { MinimumIntervalRateLimiter } from "./core/rate-limit.js";
import {
  authorizeSocketEvent,
  SocketSecurityError,
  type DrawingMembershipResolver,
  type SocketAuthorizationBinding,
  type SocketSessionValidityResolver,
} from "./security/index.js";

export type ScenePreviewEvent = Extract<
  ClientRealtimeEvent,
  { type: "scene.preview" }
>;

export interface PreviewRelay {
  drawingId: string;
  excludeConnectionId: string;
  event: ScenePreviewEvent;
}

export class PreviewRateLimitError extends Error {
  public readonly code = "PREVIEW_RATE_LIMITED" as const;
  public constructor() {
    super("Scene previews may be published at most every 100 milliseconds");
    this.name = "PreviewRateLimitError";
  }
}

export class PreviewService {
  readonly #latestByConnection = new Map<string, PreviewRelay>();
  readonly #rateLimiter: MinimumIntervalRateLimiter;

  public constructor(
    private readonly options: {
      sessionValidityResolver: SocketSessionValidityResolver;
      membershipResolver: DrawingMembershipResolver;
      rateLimiter?: MinimumIntervalRateLimiter;
    },
  ) {
    this.#rateLimiter =
      options.rateLimiter ?? new MinimumIntervalRateLimiter(100);
  }

  public async preview(
    binding: SocketAuthorizationBinding,
    event: ScenePreviewEvent,
  ): Promise<PreviewRelay> {
    const parsed = scenePreviewEventSchema.parse(event);
    await authorizeSocketEvent(
      binding,
      "scene.preview",
      this.options.sessionValidityResolver,
    );
    const liveRole = await this.options.membershipResolver.getRole(
      binding.drawingId,
      binding.userId,
    );
    if (!liveRole) {
      throw new SocketSecurityError(
        "SOCKET_NOT_MEMBER",
        "The user is no longer a member of this drawing",
      );
    }
    if (liveRole === "viewer") {
      throw new SocketSecurityError(
        "SOCKET_EVENT_FORBIDDEN",
        "Viewers cannot publish scene previews",
      );
    }
    if (!this.#rateLimiter.tryConsume(binding.connectionId)) {
      throw new PreviewRateLimitError();
    }
    const relay = {
      drawingId: binding.drawingId,
      excludeConnectionId: binding.connectionId,
      event: parsed,
    };
    this.#latestByConnection.set(binding.connectionId, relay);
    return relay;
  }

  public latest(connectionId: string): PreviewRelay | null {
    return this.#latestByConnection.get(connectionId) ?? null;
  }

  public clear(connectionId: string): void {
    this.#latestByConnection.delete(connectionId);
    this.#rateLimiter.delete(connectionId);
  }
}
