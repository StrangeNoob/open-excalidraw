import type { MailDeliveryResult, Mailer, MailMessage } from "./types.js";

/**
 * Explicit no-op adapter used when SMTP is absent. Callers can surface the
 * associated verification/reset/invitation URL for manual copying.
 */
export class DisabledMailer implements Mailer {
  public send(message: MailMessage): Promise<MailDeliveryResult> {
    void message;
    return Promise.resolve({
      status: "disabled",
      manualActionRequired: true,
    });
  }
}
