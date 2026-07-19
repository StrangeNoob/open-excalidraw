import type { Role } from "@open-excalidraw/contracts";
import { describe, expect, it } from "vitest";

import type {
  IdentityService,
  RequestIdentity,
} from "../src/modules/auth/identity.js";
import {
  authorizeShareSocketJoin,
  authorizeSocketEvent,
  authorizeSocketJoin,
  SocketSecurityError,
  StrictOriginPolicy,
  type DrawingMembershipResolver,
  type ShareLinkResolver,
} from "../src/modules/collaboration/security/index.js";

const drawingId = "a0d1c2e3-f456-4789-a012-3456789abcde";
const now = new Date("2026-07-11T10:00:00.000Z");
const trustedOrigin = "https://draw.example.test";

describe("socket authorization boundary", () => {
  it("binds identity and role only from session and membership", async () => {
    const binding = await join({ role: "editor" });

    expect(binding).toMatchObject({
      connectionId: "socket-1",
      drawingId,
      userId: "10000000-0000-4000-8000-000000000001",
      role: "editor",
      sessionId: "session-1",
    });
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it.each([
    { auth: { userId: "attacker" }, claim: "userId" },
    { auth: { role: "owner" }, claim: "role" },
    { auth: { sessionId: "stolen" }, claim: "sessionId" },
    { auth: { drawingId }, claim: "drawingId" },
  ])("rejects a forged $claim socket claim", async ({ auth }) => {
    await expect(join({ auth, role: "viewer" })).rejects.toMatchObject({
      code: "SOCKET_FORGED_AUTHORIZATION",
    });
  });

  it("rejects missing sessions and nonmembers", async () => {
    await expect(join({ identity: null })).rejects.toMatchObject({
      code: "SOCKET_UNAUTHENTICATED",
    });
    await expect(join({ role: null })).rejects.toMatchObject({
      code: "SOCKET_NOT_MEMBER",
    });
  });

  it("rejects sessions expired at or before authorization time", async () => {
    await expect(
      join({ identity: makeIdentity({ sessionExpiresAt: new Date(now) }) }),
    ).rejects.toMatchObject({ code: "SOCKET_SESSION_EXPIRED" });
  });

  it.each([
    null,
    "null",
    "https://evil.example.test",
    "https://draw.example.test.evil.test",
    "https://draw.example.test/path",
    "https://draw.example.test, https://evil.example.test",
  ])("rejects an untrusted or malformed origin: %s", async (origin) => {
    await expect(join({ origin })).rejects.toMatchObject({
      code: "SOCKET_ORIGIN_DENIED",
    });
  });

  it("allows viewer presence but rejects raw viewer scene traffic", async () => {
    const viewer = await join({ role: "viewer" });
    const activeSession = sessionValidity(true);

    await expect(
      authorizeSocketEvent(viewer, "presence.update", activeSession, now),
    ).resolves.toBeUndefined();
    await expect(
      authorizeSocketEvent(viewer, "scene.preview", activeSession, now),
    ).rejects.toMatchObject({ code: "SOCKET_EVENT_FORBIDDEN" });
    await expect(
      authorizeSocketEvent(viewer, "scene.mutate", activeSession, now),
    ).rejects.toMatchObject({ code: "SOCKET_EVENT_FORBIDDEN" });
  });

  it("rejects an event after its still-unexpired session is revoked", async () => {
    const editor = await join({ role: "editor" });
    const revokedSession = sessionValidity(false);

    await expect(
      authorizeSocketEvent(editor, "scene.mutate", revokedSession, now),
    ).rejects.toMatchObject({ code: "SOCKET_SESSION_REVOKED" });
    expect(revokedSession.isSessionActive).toHaveBeenCalledWith(
      "session-1",
      "10000000-0000-4000-8000-000000000001",
    );
  });

  it("rechecks expiry for every event on a long-lived socket", async () => {
    const editor = await join({ role: "editor" });

    await expect(
      authorizeSocketEvent(
        editor,
        "scene.mutate",
        sessionValidity(true),
        new Date("2026-07-11T11:00:01.000Z"),
      ),
    ).rejects.toMatchObject({ code: "SOCKET_SESSION_EXPIRED" });
  });

  it("uses a stable typed error for gateway mapping", () => {
    const error = new SocketSecurityError(
      "SOCKET_EVENT_FORBIDDEN",
      "forbidden",
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SocketSecurityError");
  });
});

describe("share-link socket authorization", () => {
  const shareToken = "s".repeat(43);
  const linkId = "60000000-0000-4000-8000-000000000001";

  it("binds a frozen anonymous viewer from an active token", async () => {
    const binding = await shareJoin({ auth: { shareToken } });

    expect(binding).toMatchObject({
      connectionId: "socket-1",
      drawingId,
      role: "viewer",
      shareLinkId: linkId,
      sessionId: `share:${linkId}`,
      userId: `share:${linkId}`,
    });
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it("rejects unknown or revoked tokens", async () => {
    await expect(
      shareJoin({ auth: { shareToken }, link: null }),
    ).rejects.toMatchObject({ code: "SOCKET_NOT_MEMBER" });
  });

  it("rejects a token bound to a different drawing", async () => {
    await expect(
      shareJoin({
        auth: { shareToken },
        link: { drawingId: "b0d1c2e3-f456-4789-a012-3456789abcde", linkId },
      }),
    ).rejects.toMatchObject({ code: "SOCKET_NOT_MEMBER" });
  });

  it("rejects malformed tokens without consulting the resolver", async () => {
    const resolveToken = vi.fn();
    await expect(
      shareJoin({
        auth: { shareToken: "short" },
        resolver: { resolveToken },
      }),
    ).rejects.toMatchObject({ code: "SOCKET_UNAUTHENTICATED" });
    expect(resolveToken).not.toHaveBeenCalled();
  });

  it("still rejects untrusted origins and forged claims", async () => {
    await expect(
      shareJoin({ auth: { shareToken }, origin: "https://evil.example.test" }),
    ).rejects.toMatchObject({ code: "SOCKET_ORIGIN_DENIED" });
    await expect(
      shareJoin({ auth: { shareToken, role: "owner" } }),
    ).rejects.toMatchObject({ code: "SOCKET_FORGED_AUTHORIZATION" });
  });

  interface ShareJoinOptions {
    auth?: unknown;
    link?: { drawingId: string; linkId: string } | null;
    origin?: string;
    resolver?: ShareLinkResolver;
  }

  function shareJoin(options: ShareJoinOptions = {}) {
    const link =
      options.link === undefined ? { drawingId, linkId } : options.link;
    return authorizeShareSocketJoin({
      connectionId: "socket-1",
      drawingId,
      handshake: {
        auth: options.auth,
        headers: { origin: options.origin ?? trustedOrigin },
      },
      originPolicy: new StrictOriginPolicy([trustedOrigin]),
      shareLinkResolver: options.resolver ?? {
        resolveToken: () => Promise.resolve(link),
      },
    });
  }
});

interface JoinOptions {
  auth?: unknown;
  identity?: RequestIdentity | null;
  origin?: string | null;
  role?: Role | null;
}

async function join(options: JoinOptions = {}) {
  const identityService: IdentityService = {
    resolve: () =>
      Promise.resolve(
        options.identity === undefined ? makeIdentity() : options.identity,
      ),
  };
  const membershipResolver: DrawingMembershipResolver = {
    getRole: () =>
      Promise.resolve(options.role === undefined ? "owner" : options.role),
  };
  const headers: Record<string, string> = {};
  const origin = options.origin === undefined ? trustedOrigin : options.origin;
  if (origin !== null) {
    headers.origin = origin;
  }

  return authorizeSocketJoin({
    connectionId: "socket-1",
    drawingId,
    handshake: { headers, auth: options.auth },
    identityService,
    membershipResolver,
    originPolicy: new StrictOriginPolicy([trustedOrigin]),
    now,
  });
}

function makeIdentity(
  overrides: Partial<RequestIdentity> = {},
): RequestIdentity {
  return {
    userId: "10000000-0000-4000-8000-000000000001",
    email: "member@example.test",
    name: "Member",
    image: null,
    emailVerified: true,
    twoFactorEnabled: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    sessionId: "session-1",
    sessionExpiresAt: new Date("2026-07-11T11:00:00.000Z"),
    ...overrides,
  };
}

function sessionValidity(active: boolean) {
  return {
    isSessionActive: vi.fn().mockResolvedValue(active),
  };
}
