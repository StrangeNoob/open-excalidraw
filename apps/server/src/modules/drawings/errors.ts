import type { ProblemDetails } from "@open-excalidraw/contracts";

export type DrawingErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "DRAWING_NOT_FOUND"
  | "FORBIDDEN"
  | "METADATA_VERSION_CONFLICT"
  | "OWNER_CANNOT_LEAVE"
  | "INVALID_OWNERSHIP_TARGET";

export class DrawingDomainError extends Error {
  public constructor(
    public readonly code: DrawingErrorCode,
    public readonly status: number,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "DrawingDomainError";
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
