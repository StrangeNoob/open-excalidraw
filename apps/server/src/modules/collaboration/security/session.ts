import type { Role } from "@open-excalidraw/contracts";
import type { IncomingHttpHeaders } from "node:http";

import type {
  IdentityService,
  RequestIdentity,
  SessionIdentity,
} from "../../auth/identity.js";
import { SocketSecurityError } from "./errors.js";
import type { StrictOriginPolicy } from "./origin.js";

export interface SocketHandshakeLike {
  headers: IncomingHttpHeaders | Headers;
  auth?: unknown;
}

export interface DrawingMembershipResolver {
  getRole(drawingId: string, userId: string): Promise<Role | null>;
}

export interface SocketAuthorizationBinding {
  connectionId: string;
  drawingId: string;
  userId: string;
  sessionId: string;
  sessionExpiresAt: Date;
  role: Role;
  /** Present only for anonymous share-link viewers (receive-only sockets). */
  shareLinkId?: string;
}

export interface AuthorizeSocketJoinInput {
  connectionId: string;
  drawingId: string;
  handshake: SocketHandshakeLike;
  identityService: IdentityService;
  membershipResolver: DrawingMembershipResolver;
  originPolicy: StrictOriginPolicy;
  now?: Date;
}

const clientAuthorizationClaims = new Set([
  "drawingId",
  "email",
  "role",
  "sessionId",
  "userId",
]);

export async function authorizeSocketJoin(
  input: AuthorizeSocketJoinInput,
): Promise<SocketAuthorizationBinding> {
  input.originPolicy.assertAllowed(input.handshake.headers);
  assertNoClientAuthorizationClaims(input.handshake.auth);

  const identity = await input.identityService.resolve(input.handshake.headers);
  assertActiveIdentity(identity, input.now ?? new Date());

  const role = await input.membershipResolver.getRole(
    input.drawingId,
    identity.userId,
  );
  if (!role) {
    throw new SocketSecurityError(
      "SOCKET_NOT_MEMBER",
      "The authenticated user is not a member of this drawing",
    );
  }

  return Object.freeze({
    connectionId: input.connectionId,
    drawingId: input.drawingId,
    userId: identity.userId,
    sessionId: identity.sessionId,
    sessionExpiresAt: new Date(identity.sessionExpiresAt),
    role,
  });
}

export function assertActiveIdentity(
  identity: RequestIdentity | null,
  now: Date,
): asserts identity is SessionIdentity {
  if (!identity) {
    throw new SocketSecurityError(
      "SOCKET_UNAUTHENTICATED",
      "An authenticated session is required",
    );
  }
  // A personal access token is for REST automation only; it carries no session
  // and must never open a realtime collaboration socket.
  if (identity.authKind === "token" || !identity.sessionExpiresAt) {
    throw new SocketSecurityError(
      "REALTIME_REQUIRES_SESSION",
      "A personal access token cannot open a realtime session",
    );
  }
  if (
    !Number.isFinite(identity.sessionExpiresAt.getTime()) ||
    identity.sessionExpiresAt.getTime() <= now.getTime()
  ) {
    throw new SocketSecurityError(
      "SOCKET_SESSION_EXPIRED",
      "The authenticated session has expired",
    );
  }
}

export function assertNoClientAuthorizationClaims(auth: unknown): void {
  if (auth === null || auth === undefined) {
    return;
  }
  if (typeof auth !== "object" || Array.isArray(auth)) {
    throw new SocketSecurityError(
      "SOCKET_FORGED_AUTHORIZATION",
      "Socket auth metadata must not contain authorization claims",
    );
  }

  for (const key of Object.keys(auth)) {
    if (clientAuthorizationClaims.has(key)) {
      throw new SocketSecurityError(
        "SOCKET_FORGED_AUTHORIZATION",
        `Client-provided ${key} is not an authorization source`,
      );
    }
  }
}

export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface ShareLinkResolver {
  resolveToken(
    token: string,
  ): Promise<{ linkId: string; drawingId: string } | null>;
}

export function shareUserId(linkId: string): string {
  return `share:${linkId}`;
}

export function shareTokenFromHandshake(auth: unknown): string | null {
  if (typeof auth !== "object" || auth === null || Array.isArray(auth)) {
    return null;
  }
  const token = (auth as Record<string, unknown>).shareToken;
  return typeof token === "string" && SHARE_TOKEN_PATTERN.test(token)
    ? token
    : null;
}

// Share bindings never expire by time; revocation is pushed through the room
// registry when the owner revokes or regenerates the link.
const SHARE_BINDING_EXPIRY_MS = 8_640_000_000_000_000;

export interface AuthorizeShareSocketJoinInput {
  connectionId: string;
  drawingId: string;
  handshake: SocketHandshakeLike;
  originPolicy: StrictOriginPolicy;
  shareLinkResolver: ShareLinkResolver;
}

export async function authorizeShareSocketJoin(
  input: AuthorizeShareSocketJoinInput,
): Promise<SocketAuthorizationBinding> {
  input.originPolicy.assertAllowed(input.handshake.headers);
  assertNoClientAuthorizationClaims(input.handshake.auth);

  const token = shareTokenFromHandshake(input.handshake.auth);
  if (!token) {
    throw new SocketSecurityError(
      "SOCKET_UNAUTHENTICATED",
      "A valid share token is required",
    );
  }
  const link = await input.shareLinkResolver.resolveToken(token);
  if (!link || link.drawingId !== input.drawingId) {
    throw new SocketSecurityError(
      "SOCKET_NOT_MEMBER",
      "The share link is not active for this drawing",
    );
  }

  return Object.freeze({
    connectionId: input.connectionId,
    drawingId: input.drawingId,
    userId: shareUserId(link.linkId),
    sessionId: shareUserId(link.linkId),
    sessionExpiresAt: new Date(SHARE_BINDING_EXPIRY_MS),
    role: "viewer" as const,
    shareLinkId: link.linkId,
  });
}

export function withServerRole(
  binding: SocketAuthorizationBinding,
  role: Role,
): SocketAuthorizationBinding {
  return Object.freeze({ ...binding, role });
}
