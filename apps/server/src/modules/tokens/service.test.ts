import { createHash } from "node:crypto";

import type { PersonalAccessToken } from "@open-excalidraw/contracts";
import { describe, expect, it, vi } from "vitest";

import { TokenService } from "./service.js";
import type { TokenOwner, TokenRepository } from "./types.js";

const sampleToken: PersonalAccessToken = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "ci",
  lastFour: "abcd",
  createdAt: "2026-07-01T00:00:00.000Z",
  expiresAt: null,
  lastUsedAt: null,
};

function fakeRepository(
  overrides: Partial<TokenRepository> = {},
): TokenRepository {
  return {
    insert: vi.fn().mockResolvedValue(sampleToken),
    list: vi.fn().mockResolvedValue([]),
    revoke: vi.fn().mockResolvedValue(true),
    resolveOwner: vi.fn().mockResolvedValue(null),
    touchLastUsed: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const owner: TokenOwner = {
  userId: "22222222-2222-4222-8222-222222222222",
  email: "owner@example.test",
  name: "Owner",
  image: null,
  emailVerified: true,
  twoFactorEnabled: false,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("TokenService", () => {
  it("mints a prefixed secret and stores only its sha-256 hash", async () => {
    const insert = vi.fn().mockResolvedValue(sampleToken);
    const service = new TokenService(fakeRepository({ insert }));

    const result = await service.create({
      userId: owner.userId,
      requestId: "req",
      body: { name: "ci", expiresInDays: 30 },
    });

    expect(result.secret).toMatch(/^oepat_[A-Za-z0-9_-]{43}$/);
    const insertArgs = insert.mock.calls[0]![0];
    expect(insertArgs.lastFour).toBe(result.secret.slice(-4));
    expect(insertArgs.expiresInDays).toBe(30);
    expect(insertArgs.tokenHash).toEqual(
      createHash("sha256").update(result.secret, "utf8").digest(),
    );
    // The hash is 32 bytes and the plaintext is never handed to the repository.
    expect(insertArgs.tokenHash).toHaveLength(32);
  });

  it("resolves a valid secret to a token-authenticated identity", async () => {
    const touchLastUsed = vi.fn().mockResolvedValue(undefined);
    const service = new TokenService(
      fakeRepository({
        resolveOwner: vi.fn().mockResolvedValue(owner),
        touchLastUsed,
      }),
    );

    const identity = await service.resolveIdentity("oepat_whatever");

    expect(identity).toMatchObject({
      userId: owner.userId,
      email: owner.email,
      authKind: "token",
    });
    expect(identity).not.toHaveProperty("sessionId");
    expect(touchLastUsed).toHaveBeenCalledOnce();
  });

  it("resolves to null for an unknown secret and skips the usage bump", async () => {
    const touchLastUsed = vi.fn().mockResolvedValue(undefined);
    const service = new TokenService(fakeRepository({ touchLastUsed }));

    expect(await service.resolveIdentity("oepat_missing")).toBeNull();
    expect(touchLastUsed).not.toHaveBeenCalled();
  });

  it("reports a failed usage bump without failing resolution", async () => {
    const onTouchError = vi.fn();
    const repository = fakeRepository({
      resolveOwner: vi.fn().mockResolvedValue(owner),
      touchLastUsed: vi.fn().mockRejectedValue(new Error("db down")),
    });
    const service = new TokenService(repository, { onTouchError });

    const identity = await service.resolveIdentity("oepat_whatever");
    expect(identity).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onTouchError).toHaveBeenCalledOnce();
  });

  it("throws TOKEN_NOT_FOUND when revoking an absent token", async () => {
    const repository = fakeRepository({
      revoke: vi.fn().mockResolvedValue(false),
    });
    const service = new TokenService(repository);

    await expect(
      service.revoke({ userId: owner.userId, tokenId: "x", requestId: "r" }),
    ).rejects.toMatchObject({ code: "TOKEN_NOT_FOUND" });
  });
});
