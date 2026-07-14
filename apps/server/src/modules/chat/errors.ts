import type { ProblemDetails } from "@open-excalidraw/contracts";

export type ChatErrorCode = "AUTHENTICATION_REQUIRED" | "DRAWING_NOT_FOUND";

export class ChatDomainError extends Error {
  public constructor(
    public readonly code: ChatErrorCode,
    public readonly status: number,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "ChatDomainError";
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

export class ChatRateLimitError extends Error {
  public readonly code = "CHAT_RATE_LIMITED" as const;
  public readonly retryable = true;

  public constructor() {
    super("Chat message rate exceeded");
    this.name = "ChatRateLimitError";
  }
}
