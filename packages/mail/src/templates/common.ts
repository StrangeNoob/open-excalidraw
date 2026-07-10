import type { MailMessage } from "../types.js";

export interface TemplateShellInput {
  to: string;
  subject: string;
  heading: string;
  introduction: string;
  actionLabel: string;
  actionUrl: string;
  productName?: string;
  closing?: string;
}

export function renderActionEmail(input: TemplateShellInput): MailMessage {
  const productName = input.productName ?? "Open Excalidraw";
  const actionUrl = requireHttpUrl(input.actionUrl);
  const closing =
    input.closing ?? "If you did not request this, you can ignore this email.";

  return {
    to: input.to,
    subject: input.subject,
    text: [
      input.heading,
      "",
      input.introduction,
      "",
      `${input.actionLabel}: ${actionUrl}`,
      "",
      closing,
      "",
      productName,
    ].join("\n"),
    html: `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f4f5f7;color:#1b1b1f;font-family:Arial,sans-serif">
    <main style="max-width:600px;margin:0 auto;padding:32px 20px">
      <section style="background:#fff;border-radius:12px;padding:28px">
        <p style="margin:0 0 20px;font-weight:700">${escapeHtml(productName)}</p>
        <h1 style="font-size:24px;margin:0 0 16px">${escapeHtml(input.heading)}</h1>
        <p style="line-height:1.5;margin:0 0 24px">${escapeHtml(input.introduction)}</p>
        <p style="margin:0 0 24px">
          <a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:#6965db;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px">${escapeHtml(input.actionLabel)}</a>
        </p>
        <p style="line-height:1.5;color:#5b5b66;margin:0">${escapeHtml(closing)}</p>
      </section>
    </main>
  </body>
</html>`,
  };
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}

export function sanitizeHeaderText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function requireHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Email action URLs must be absolute HTTP(S) URLs");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Email action URLs must use HTTP or HTTPS");
  }
  return url.toString();
}
