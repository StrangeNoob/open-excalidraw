import type { ProblemDetails } from "@open-excalidraw/contracts";

export type SharingErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "DRAWING_NOT_FOUND"
  | "FORBIDDEN"
  | "MEMBER_NOT_FOUND"
  | "INVITATION_NOT_FOUND"
  | "SHARE_LINK_NOT_FOUND"
  | "INVITATION_EXPIRED"
  | "INVITATION_USED"
  | "INVITATION_REVOKED"
  | "INVITATION_EMAIL_MISMATCH"
  | "EMAIL_VERIFICATION_REQUIRED";

export class SharingDomainError extends Error {
  public constructor(
    public readonly code: SharingErrorCode,
    public readonly status: number,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "SharingDomainError";
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
