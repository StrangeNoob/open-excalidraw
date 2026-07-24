import { createHash, randomBytes } from "node:crypto";

import {
  PERSONAL_ACCESS_TOKEN_PREFIX,
  personalAccessTokenCreateSchema,
  type PersonalAccessTokenCreated,
  type PersonalAccessTokenList,
} from "@open-excalidraw/contracts";

import type { RequestIdentity } from "../auth/identity.js";
import { TokenDomainError } from "./errors.js";
import type { TokenRepository } from "./types.js";

/** Per-user token cap. A leaked account should not be able to mint unbounded keys. */
const MAX_TOKENS = 25;

// 32 random bytes -> 43 base64url chars; the prefix makes leaked strings
// attributable and lets the identity seam cheaply detect a token bearer.
function generateSecret(): string {
  return PERSONAL_ACCESS_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export interface TokenServiceOptions {
  /**
   * Surfaces a failed best-effort last_used_at bump. The bump never fails the
   * request, but the error is reported here rather than silently swallowed.
   */
  onTouchError?: (error: unknown) => void;
}

export class TokenService {
  private readonly onTouchError: (error: unknown) => void;

  public constructor(
    private readonly repository: TokenRepository,
    options: TokenServiceOptions = {},
  ) {
    this.onTouchError = options.onTouchError ?? (() => {});
  }

  public async create(input: {
    userId: string;
    requestId: string;
    body: unknown;
  }): Promise<PersonalAccessTokenCreated> {
    const { name, expiresInDays } = personalAccessTokenCreateSchema.parse(
      input.body,
    );
    const secret = generateSecret();
    const token = await this.repository.insert({
      userId: input.userId,
      name,
      tokenHash: hashSecret(secret),
      lastFour: secret.slice(-4),
      expiresInDays,
      requestId: input.requestId,
      maxTokens: MAX_TOKENS,
    });
    // The plaintext secret leaves the server exactly once, here.
    return { token, secret };
  }

  public async list(userId: string): Promise<PersonalAccessTokenList> {
    return { tokens: await this.repository.list(userId) };
  }

  public async revoke(input: {
    userId: string;
    tokenId: string;
    requestId: string;
  }): Promise<void> {
    const revoked = await this.repository.revoke(input);
    if (!revoked) {
      throw new TokenDomainError(
        "TOKEN_NOT_FOUND",
        404,
        "Personal access token not found",
      );
    }
  }

  /**
   * Resolve a presented bearer secret to a token-authenticated identity, or null
   * when unknown, expired, revoked, or the owner is disabled. Wired into the
   * identity seam as the token path.
   */
  public async resolveIdentity(
    secret: string,
  ): Promise<RequestIdentity | null> {
    const hash = hashSecret(secret);
    const owner = await this.repository.resolveOwner(hash);
    if (!owner) {
      return null;
    }
    // Fire-and-forget coarse usage bump: it must never fail the request, and its
    // rejection is reported, not swallowed.
    void this.repository.touchLastUsed(hash).catch(this.onTouchError);
    return {
      userId: owner.userId,
      email: owner.email,
      name: owner.name,
      image: owner.image,
      emailVerified: owner.emailVerified,
      twoFactorEnabled: owner.twoFactorEnabled,
      createdAt: owner.createdAt,
      authKind: "token",
    };
  }
}
