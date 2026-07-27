import type { MailMessage } from "../types.js";
import { renderActionEmail, sanitizeHeaderText } from "./common.js";

export interface MentionEmailInput {
  to: string;
  drawingUrl: string;
  senderName: string;
  drawingTitle: string;
  productName?: string;
  heroImageUrl?: string;
}

/**
 * Notifies a mentioned member who is not in the drawing. The message body is
 * deliberately absent: chat content must not end up in mail provider storage.
 */
export function renderMentionEmail(input: MentionEmailInput): MailMessage {
  const senderName = sanitizeHeaderText(input.senderName);
  const drawingTitle = sanitizeHeaderText(input.drawingTitle);

  return renderActionEmail({
    to: input.to,
    subject: `${senderName} mentioned you in “${drawingTitle}”`,
    heading: "You were mentioned",
    introduction: `${senderName} mentioned you in the chat of “${drawingTitle}”.`,
    actionLabel: "Open drawing",
    actionUrl: input.drawingUrl,
    productName: input.productName,
    heroImageUrl: input.heroImageUrl,
    closing:
      "You are receiving this because you are a member of this drawing. You can turn mention emails off in your notification settings.",
  });
}
