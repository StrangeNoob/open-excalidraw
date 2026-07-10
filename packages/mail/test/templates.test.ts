import { renderInvitationEmail } from "../src/templates/invitation.js";
import { renderPasswordResetEmail } from "../src/templates/password-reset.js";
import { renderVerificationEmail } from "../src/templates/verification.js";

describe("mail templates", () => {
  it("escapes invitation user content in HTML and strips subject newlines", () => {
    const email = renderInvitationEmail({
      to: "guest@example.com",
      invitationUrl: "https://draw.example.com/invite/token?next=a&mode=b",
      inviterName: "Alice\r\nBcc: attacker@example.com <script>",
      drawingTitle: 'Roadmap </a><img src=x onerror="bad">',
      role: "viewer",
      productName: "Draw & Share",
    });

    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.html).toContain("Draw &amp; Share");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("&lt;img src=x onerror=&quot;bad&quot;&gt;");
    expect(email.html).toContain("next=a&amp;mode=b");
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img src=x");
    expect(email.text).toContain("as a viewer");
  });

  it("renders verification and reset action links", () => {
    expect(
      renderVerificationEmail({
        to: "person@example.com",
        verificationUrl: "https://draw.example.com/verify/token",
      }),
    ).toMatchObject({
      to: "person@example.com",
      subject: "Verify your email address",
    });
    expect(
      renderPasswordResetEmail({
        to: "person@example.com",
        resetUrl: "https://draw.example.com/reset/token",
      }).html,
    ).toContain("Reset password");
  });

  it("rejects non-HTTP action URLs", () => {
    expect(() =>
      renderPasswordResetEmail({
        to: "person@example.com",
        resetUrl: "javascript:alert(1)",
      }),
    ).toThrow(/HTTP or HTTPS/);
  });
});
