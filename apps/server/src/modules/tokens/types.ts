import type { PersonalAccessToken } from "@open-excalidraw/contracts";

/** The owner fields a resolved token needs to build a token RequestIdentity. */
export interface TokenOwner {
  userId: string;
  email: string;
  name: string;
  image: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  createdAt: Date;
}

export interface TokenRepository {
  /**
   * Insert a token and its audit event in one transaction, enforcing the
   * per-user cap atomically. Throws TokenDomainError TOKEN_LIMIT_REACHED when
   * the user already holds `maxTokens` tokens.
   */
  insert(input: {
    userId: string;
    name: string;
    tokenHash: Buffer;
    lastFour: string;
    expiresInDays: number | null;
    requestId: string;
    maxTokens: number;
  }): Promise<PersonalAccessToken>;

  /** The caller's own tokens, newest first. */
  list(userId: string): Promise<PersonalAccessToken[]>;

  /**
   * Delete the caller's token and write its revocation audit event in one
   * transaction. Returns false when no such token belongs to the user.
   */
  revoke(input: {
    userId: string;
    tokenId: string;
    requestId: string;
  }): Promise<boolean>;

  /**
   * Resolve a token hash to its owner when the token is unexpired and the owner
   * is not disabled; null otherwise.
   */
  resolveOwner(tokenHash: Buffer): Promise<TokenOwner | null>;

  /** Coarsely bump last_used_at (at most hourly). Best-effort telemetry. */
  touchLastUsed(tokenHash: Buffer): Promise<void>;
}
