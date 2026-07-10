import type { MailMessage } from "../types.js";
import { renderActionEmail } from "./common.js";

export interface VerificationEmailInput {
  to: string;
  verificationUrl: string;
  productName?: string;
}

export function renderVerificationEmail(
  input: VerificationEmailInput,
): MailMessage {
  return renderActionEmail({
    to: input.to,
    subject: "Verify your email address",
    heading: "Verify your email address",
    introduction:
      "Confirm this email address to finish setting up your account.",
    actionLabel: "Verify email",
    actionUrl: input.verificationUrl,
    productName: input.productName,
  });
}
