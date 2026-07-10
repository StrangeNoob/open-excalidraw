import {
  buildTransportOptions,
  SmtpMailer,
  type SmtpTransportMessage,
  type SmtpTransportOptions,
} from "../src/smtp.js";
import type { MailLogEvent } from "../src/types.js";

const message = {
  to: "person@example.com",
  subject: "Subject",
  text: "Text",
  html: "<p>HTML</p>",
};

describe("SmtpMailer", () => {
  it("enforces TLS verification and bounded transport timeouts", async () => {
    let options: SmtpTransportOptions | undefined;
    let delivered: SmtpTransportMessage | undefined;
    const mailer = new SmtpMailer(
      {
        host: "smtp.example.com",
        port: 587,
        secure: false,
        from: "Open Excalidraw <noreply@example.com>",
        user: "smtp-user",
        password: "smtp-password",
        timeoutMs: 600_000,
      },
      {
        createTransport: (receivedOptions) => {
          options = receivedOptions;
          return {
            sendMail(receivedMessage) {
              delivered = receivedMessage;
              return Promise.resolve({ messageId: "message-1" });
            },
          };
        },
      },
    );

    await expect(mailer.send(message)).resolves.toEqual({
      status: "sent",
      messageId: "message-1",
    });
    expect(options).toEqual({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      requireTLS: true,
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 30_000,
      auth: { user: "smtp-user", pass: "smtp-password" },
      tls: { rejectUnauthorized: true, servername: "smtp.example.com" },
    });
    expect(delivered).toEqual({
      from: "Open Excalidraw <noreply@example.com>",
      ...message,
    });
  });

  it("uses direct TLS without redundantly requiring STARTTLS", () => {
    expect(
      buildTransportOptions({
        host: "smtp.example.com",
        port: 465,
        secure: true,
        from: "sender@example.com",
      }),
    ).toMatchObject({
      secure: true,
      requireTLS: false,
      connectionTimeout: 10_000,
      tls: { rejectUnauthorized: true },
    });
  });

  it("returns and logs only a typed, secret-free timeout failure", async () => {
    const logEvents: MailLogEvent[] = [];
    const secret = "smtp-password-do-not-log";
    const mailer = new SmtpMailer(
      {
        host: "smtp.example.com",
        port: 587,
        secure: false,
        from: "sender@example.com",
        user: "smtp-user",
        password: secret,
      },
      {
        createTransport: () => ({
          sendMail() {
            return Promise.reject(
              Object.assign(new Error(`socket failed with ${secret}`), {
                code: "ETIMEDOUT",
              }),
            );
          },
        }),
        logger: { warn: (event) => logEvents.push(event) },
      },
    );

    const result = await mailer.send(message);

    expect(result).toEqual({
      status: "failed",
      reason: "timeout",
      retryable: true,
      code: "SMTP_TIMEOUT",
    });
    expect(logEvents).toEqual([
      {
        event: "mail.delivery_failed",
        reason: "timeout",
        retryable: true,
        code: "SMTP_TIMEOUT",
      },
    ]);
    expect(JSON.stringify({ result, logEvents })).not.toContain(secret);
  });

  it.each([
    [{ code: "EAUTH" }, "authentication", false, "SMTP_AUTHENTICATION"],
    [{ responseCode: 550 }, "rejected", false, "SMTP_REJECTED"],
    [{ responseCode: 451 }, "rejected", true, "SMTP_REJECTED"],
    [{ code: "ESOCKET" }, "transport", true, "SMTP_TRANSPORT"],
  ] as const)(
    "classifies transport failure %#",
    async (transportError, reason, retryable, code) => {
      const mailer = new SmtpMailer(
        {
          host: "smtp.example.com",
          port: 587,
          secure: false,
          from: "sender@example.com",
        },
        {
          createTransport: () => ({
            sendMail() {
              return Promise.reject(
                transportError instanceof Error
                  ? transportError
                  : Object.assign(
                      new Error("SMTP test failure"),
                      transportError,
                    ),
              );
            },
          }),
        },
      );

      await expect(mailer.send(message)).resolves.toEqual({
        status: "failed",
        reason,
        retryable,
        code,
      });
    },
  );
});
