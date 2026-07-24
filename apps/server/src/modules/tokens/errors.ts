import type { ProblemDetails } from "@open-excalidraw/contracts";

export type TokenErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "TOKEN_MANAGEMENT_REQUIRES_SESSION"
  | "TOKEN_LIMIT_REACHED"
  | "TOKEN_NOT_FOUND";

export class TokenDomainError extends Error {
  public constructor(
    public readonly code: TokenErrorCode,
    public readonly status: number,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "TokenDomainError";
  }

  public toProblem(requestId: string): ProblemDetails {
    return {
      code: this.code,
      status: this.status,
      title: this.message,
      requestId,
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}
