import type { Role } from "@open-excalidraw/contracts";

import { SocketSecurityError } from "./errors.js";
import type { SocketAuthorizationBinding } from "./session.js";

export type BoundClientEventType =
  "chat.send" | "presence.update" | "scene.mutate" | "scene.preview";

/**
 * Must consult live session state or an authoritative revocation registry.
 * Cached socket expiry alone is deliberately insufficient.
 */
export interface SocketSessionValidityResolver {
  isSessionActive(sessionId: string, userId: string): Promise<boolean>;
}

const allowedEventsByRole = {
  owner: ["chat.send", "presence.update", "scene.mutate", "scene.preview"],
  editor: ["chat.send", "presence.update", "scene.mutate", "scene.preview"],
  // Viewers may talk: commenting on a drawing is the point of view access.
  viewer: ["chat.send", "presence.update"],
} as const satisfies Record<Role, readonly BoundClientEventType[]>;

function canPublishSocketEvent(
  role: Role,
  eventType: BoundClientEventType,
): boolean {
  return (
    allowedEventsByRole[role] as readonly BoundClientEventType[]
  ).includes(eventType);
}

export async function authorizeSocketEvent(
  binding: SocketAuthorizationBinding,
  eventType: BoundClientEventType,
  sessionValidityResolver: SocketSessionValidityResolver,
  now = new Date(),
): Promise<void> {
  if (binding.sessionExpiresAt.getTime() <= now.getTime()) {
    throw new SocketSecurityError(
      "SOCKET_SESSION_EXPIRED",
      "The socket session has expired",
    );
  }
  if (
    !(await sessionValidityResolver.isSessionActive(
      binding.sessionId,
      binding.userId,
    ))
  ) {
    throw new SocketSecurityError(
      "SOCKET_SESSION_REVOKED",
      "The socket session is no longer active",
    );
  }
  if (!canPublishSocketEvent(binding.role, eventType)) {
    throw new SocketSecurityError(
      "SOCKET_EVENT_FORBIDDEN",
      `${binding.role} sockets cannot publish ${eventType}`,
    );
  }
}
