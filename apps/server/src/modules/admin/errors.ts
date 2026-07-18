import type { ProblemDetails } from "@open-excalidraw/contracts";

export type AdminErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "ADMIN_ACCESS_REQUIRED"
  | "USER_NOT_FOUND"
  | "CANNOT_TARGET_SELF";

export class AdminDomainError extends Error {
  public constructor(
    public readonly code: AdminErrorCode,
    public readonly status: number,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "AdminDomainError";
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
