import type { Role } from "@open-excalidraw/contracts";
import type { IncomingHttpHeaders } from "node:http";

import type { IdentityService, RequestIdentity } from "../../auth/identity.js";
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
): asserts identity is RequestIdentity {
  if (!identity) {
    throw new SocketSecurityError(
      "SOCKET_UNAUTHENTICATED",
      "An authenticated session is required",
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

export function withServerRole(
  binding: SocketAuthorizationBinding,
  role: Role,
): SocketAuthorizationBinding {
  return Object.freeze({ ...binding, role });
}
