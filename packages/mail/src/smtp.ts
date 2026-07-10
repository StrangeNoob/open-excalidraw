import nodemailer from "nodemailer";

import {
  MailConfigurationError,
  type MailDeliveryResult,
  type MailFailureReason,
  type Mailer,
  type MailLogger,
  type MailMessage,
} from "./types.js";

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface SmtpMailerConfig {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  user?: string;
  password?: string;
  /** Require STARTTLS when using a non-TLS socket. Defaults to true. */
  requireTls?: boolean;
  rejectUnauthorized?: boolean;
  tlsServername?: string;
  timeoutMs?: number;
}

export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  auth?: { user: string; pass: string };
  tls: {
    rejectUnauthorized: boolean;
    servername: string;
  };
}

export interface SmtpTransportMessage extends MailMessage {
  from: string;
}

export interface SmtpTransportResult {
  messageId?: string;
}

export interface SmtpTransport {
  sendMail(message: SmtpTransportMessage): Promise<SmtpTransportResult>;
}

export type SmtpTransportFactory = (
  options: SmtpTransportOptions,
) => SmtpTransport;

export interface SmtpMailerDependencies {
  createTransport?: SmtpTransportFactory;
  logger?: MailLogger;
}

export class SmtpMailer implements Mailer {
  readonly #from: string;
  readonly #transport: SmtpTransport;
  readonly #logger?: MailLogger;

  public constructor(
    config: SmtpMailerConfig,
    dependencies: SmtpMailerDependencies = {},
  ) {
    validateConfig(config);
    const options = buildTransportOptions(config);
    const createTransport =
      dependencies.createTransport ?? defaultTransportFactory;

    this.#from = config.from;
    this.#transport = createTransport(options);
    this.#logger = dependencies.logger;
  }

  public async send(message: MailMessage): Promise<MailDeliveryResult> {
    try {
      const result = await this.#transport.sendMail({
        from: this.#from,
        ...message,
      });
      return result.messageId
        ? { status: "sent", messageId: result.messageId }
        : { status: "sent" };
    } catch (error) {
      const failure = classifySmtpFailure(error);
      this.#logger?.warn({ event: "mail.delivery_failed", ...failure });
      return { status: "failed", ...failure };
    }
  }
}

export function buildTransportOptions(
  config: SmtpMailerConfig,
): SmtpTransportOptions {
  const timeout = clampTimeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const options: SmtpTransportOptions = {
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTls ?? !config.secure,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
    tls: {
      rejectUnauthorized: config.rejectUnauthorized ?? true,
      servername: config.tlsServername ?? config.host,
    },
  };

  if (config.user && config.password) {
    options.auth = { user: config.user, pass: config.password };
  }

  return options;
}

function defaultTransportFactory(options: SmtpTransportOptions): SmtpTransport {
  return nodemailer.createTransport(options);
}

function validateConfig(config: SmtpMailerConfig): void {
  if (config.host.trim().length === 0) {
    throw new MailConfigurationError("SMTP host is required");
  }
  if (
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65_535
  ) {
    throw new MailConfigurationError("SMTP port must be between 1 and 65535");
  }
  if (config.from.trim().length === 0) {
    throw new MailConfigurationError("SMTP sender is required");
  }
  if (Boolean(config.user) !== Boolean(config.password)) {
    throw new MailConfigurationError(
      "SMTP user and password must either both be set or both be absent",
    );
  }
  if (
    config.timeoutMs !== undefined &&
    (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)
  ) {
    throw new MailConfigurationError("SMTP timeout must be a positive number");
  }
}

function clampTimeout(timeout: number): number {
  return Math.min(
    MAX_TIMEOUT_MS,
    Math.max(MIN_TIMEOUT_MS, Math.trunc(timeout)),
  );
}

function classifySmtpFailure(error: unknown): {
  reason: MailFailureReason;
  retryable: boolean;
  code: Extract<MailDeliveryResult, { status: "failed" }>["code"];
} {
  const errorCode = readErrorCode(error);
  const responseCode = readResponseCode(error);

  if (
    errorCode === "ETIMEDOUT" ||
    errorCode === "ETIMEOUT" ||
    errorCode === "ECONNECTION"
  ) {
    return { reason: "timeout", retryable: true, code: "SMTP_TIMEOUT" };
  }
  if (errorCode === "EAUTH") {
    return {
      reason: "authentication",
      retryable: false,
      code: "SMTP_AUTHENTICATION",
    };
  }
  if (responseCode !== undefined && responseCode >= 500) {
    return { reason: "rejected", retryable: false, code: "SMTP_REJECTED" };
  }
  if (responseCode !== undefined && responseCode >= 400) {
    return { reason: "rejected", retryable: true, code: "SMTP_REJECTED" };
  }
  return { reason: "transport", retryable: true, code: "SMTP_TRANSPORT" };
}

function readErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function readResponseCode(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "responseCode" in error &&
    typeof error.responseCode === "number"
  ) {
    return error.responseCode;
  }
  return undefined;
}
