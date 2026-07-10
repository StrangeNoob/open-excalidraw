import type { ProblemDetails } from "@open-excalidraw/contracts";

export type ContentErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "DRAWING_NOT_FOUND"
  | "FORBIDDEN"
  | "PRECONDITION_REQUIRED"
  | "INVALID_REVISION"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_MISMATCH"
  | "SCENE_TOO_LARGE"
  | "DUPLICATE_ASSET_ID"
  | "ASSET_MANIFEST_MISMATCH"
  | "MISSING_ASSET"
  | "REVISION_NOT_FOUND";

export class ContentDomainError extends Error {
  public constructor(
    public readonly code: ContentErrorCode,
    public readonly status: number,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "ContentDomainError";
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
