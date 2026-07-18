import type { ProblemDetails } from "@open-excalidraw/contracts";

export type LibraryErrorCode = "AUTHENTICATION_REQUIRED";

export class LibraryDomainError extends Error {
  public constructor(
    public readonly code: LibraryErrorCode,
    public readonly status: number,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "LibraryDomainError";
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
