import type { ProblemDetails } from "@open-excalidraw/contracts";

export type ExportErrorCode =
  "AUTHENTICATION_REQUIRED" | "EXPORT_TOO_LARGE" | "EXPORT_UNAVAILABLE";

export class ExportDomainError extends Error {
  public constructor(
    public readonly code: ExportErrorCode,
    public readonly status: number,
    message: string,
    public readonly detail?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExportDomainError";
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
