export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type MailFailureReason =
  "authentication" | "timeout" | "rejected" | "transport";

export type MailDeliveryResult =
  | {
      status: "sent";
      messageId?: string;
    }
  | {
      status: "disabled";
      manualActionRequired: true;
    }
  | {
      status: "failed";
      reason: MailFailureReason;
      retryable: boolean;
      /** Stable, non-secret code suitable for logs and metrics. */
      code:
        | "SMTP_AUTHENTICATION"
        | "SMTP_TIMEOUT"
        | "SMTP_REJECTED"
        | "SMTP_TRANSPORT";
    };

export interface Mailer {
  send(message: MailMessage): Promise<MailDeliveryResult>;
}

export interface MailLogEvent {
  event: "mail.delivery_failed";
  reason: MailFailureReason;
  retryable: boolean;
  code: Extract<MailDeliveryResult, { status: "failed" }>["code"];
}

/** The mail package deliberately exposes only secret-free structured events. */
export interface MailLogger {
  warn(event: MailLogEvent): void;
}

export class MailConfigurationError extends Error {
  public readonly code = "MAIL_CONFIGURATION_ERROR" as const;

  public constructor(message: string) {
    super(message);
    this.name = "MailConfigurationError";
  }
}
