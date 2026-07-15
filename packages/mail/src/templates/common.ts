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
  /** Absolute HTTP(S) URL of a square brand image shown at the top of the card. */
  heroImageUrl?: string;
}

// Mirrors the web app's --font-hand / --font-body stacks (apps/web/src/app/styles.css).
// The @import below only loads in clients that support web fonts (e.g. Apple Mail);
// everyone else falls back to the same system fonts the app falls back to.
const FONT_HAND = `'Gochi Hand','Comic Sans MS','Segoe Print',cursive`;
const FONT_BODY = `'Nunito',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

export function renderActionEmail(input: TemplateShellInput): MailMessage {
  const productName = input.productName ?? "Open Excalidraw";
  const actionUrl = requireHttpUrl(input.actionUrl);
  const heroImageUrl = input.heroImageUrl
    ? requireHttpUrl(input.heroImageUrl)
    : undefined;
  const brandIcon = heroImageUrl
    ? `<img src="${escapeHtml(heroImageUrl)}" width="28" height="28" alt="" style="vertical-align:middle;margin-right:10px">`
    : "";
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
    // ponytail: div layout swapped for tables — the only markup Outlook's Word engine renders reliably.
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <style>@import url('https://fonts.googleapis.com/css2?family=Gochi+Hand&family=Nunito:wght@400;600;700&display=swap');</style>
  </head>
  <body style="margin:0;padding:0;background:#f4f5f7;color:#1b1b1f;font-family:${FONT_BODY}">
    <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(input.introduction)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7">
      <tr>
        <td align="center" style="padding:32px 16px">
          <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" align="center"><tr><td><![endif]-->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
            <tr>
              <td style="background:#ffffff;border:1px solid #e9e9ee;border-radius:12px;padding:32px">
                <p style="margin:0 0 28px;padding-bottom:20px;border-bottom:1px solid #ececf1;text-align:center">${brandIcon}<span style="font-family:${FONT_HAND};font-size:20px;letter-spacing:.015em;vertical-align:middle">${escapeHtml(productName)}</span></p>
                <h1 style="font-family:${FONT_BODY};font-size:21px;font-weight:700;line-height:1.35;margin:0 0 12px">${escapeHtml(input.heading)}</h1>
                <p style="font-size:15px;line-height:1.6;margin:0 0 28px;color:#43434f">${escapeHtml(input.introduction)}</p>
                <p style="margin:0;text-align:center"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:#6965db;color:#ffffff;text-decoration:none;font-family:${FONT_BODY};font-size:15px;font-weight:600;padding:12px 28px;border-radius:8px">${escapeHtml(input.actionLabel)}</a></p>
                <p style="font-size:13px;line-height:1.6;margin:28px 0 0;padding-top:20px;border-top:1px solid #ececf1;color:#5b5b66">If the button does not work, copy and paste this link into your browser:<br><a href="${escapeHtml(actionUrl)}" style="color:#6965db;word-break:break-all">${escapeHtml(actionUrl)}</a></p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 4px 0;font-size:12px;line-height:1.6;color:#8a8a96">${escapeHtml(closing)}<br>${escapeHtml(productName)}</td>
            </tr>
          </table>
          <!--[if mso]></td></tr></table><![endif]-->
        </td>
      </tr>
    </table>
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
