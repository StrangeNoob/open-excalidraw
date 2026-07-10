import type { MailMessage } from "../types.js";
import { renderActionEmail } from "./common.js";

export interface PasswordResetEmailInput {
  to: string;
  resetUrl: string;
  productName?: string;
}

export function renderPasswordResetEmail(
  input: PasswordResetEmailInput,
): MailMessage {
  return renderActionEmail({
    to: input.to,
    subject: "Reset your password",
    heading: "Reset your password",
    introduction: "Use the secure link below to choose a new password.",
    actionLabel: "Reset password",
    actionUrl: input.resetUrl,
    productName: input.productName,
  });
}
