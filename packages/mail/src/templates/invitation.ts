import type { MailMessage } from "../types.js";
import { renderActionEmail, sanitizeHeaderText } from "./common.js";

export interface InvitationEmailInput {
  to: string;
  invitationUrl: string;
  inviterName: string;
  drawingTitle: string;
  role: "editor" | "viewer";
  productName?: string;
}

export function renderInvitationEmail(
  input: InvitationEmailInput,
): MailMessage {
  const inviterName = sanitizeHeaderText(input.inviterName);
  const drawingTitle = sanitizeHeaderText(input.drawingTitle);
  const article = input.role === "editor" ? "an" : "a";

  return renderActionEmail({
    to: input.to,
    subject: `${inviterName} invited you to ${drawingTitle}`,
    heading: "You have been invited",
    introduction: `${inviterName} invited you to join “${drawingTitle}” as ${article} ${input.role}.`,
    actionLabel: "Open invitation",
    actionUrl: input.invitationUrl,
    productName: input.productName,
    closing:
      "This invitation is personal. Do not forward the link. It will expire after the configured invitation period.",
  });
}
