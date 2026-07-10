import type { IncomingHttpHeaders } from "node:http";

import { SocketSecurityError } from "./errors.js";

export interface SocketHeadersLike {
  headers: IncomingHttpHeaders | Headers;
}

export class StrictOriginPolicy {
  readonly #allowedOrigins: ReadonlySet<string>;

  public constructor(allowedOrigins: readonly string[]) {
    if (allowedOrigins.length === 0) {
      throw new TypeError("At least one trusted socket origin is required");
    }
    this.#allowedOrigins = new Set(allowedOrigins.map(parseConfiguredOrigin));
  }

  public assertAllowed(headers: IncomingHttpHeaders | Headers): string {
    const origin = readOrigin(headers);
    if (!origin) {
      throw new SocketSecurityError(
        "SOCKET_ORIGIN_DENIED",
        "A trusted Origin header is required",
      );
    }

    let normalized: string;
    try {
      normalized = parseRequestOrigin(origin);
    } catch {
      throw new SocketSecurityError(
        "SOCKET_ORIGIN_DENIED",
        "The socket Origin header is invalid",
      );
    }

    if (!this.#allowedOrigins.has(normalized)) {
      throw new SocketSecurityError(
        "SOCKET_ORIGIN_DENIED",
        "The socket Origin is not trusted",
      );
    }
    return normalized;
  }
}

function readOrigin(headers: IncomingHttpHeaders | Headers): string | null {
  if (headers instanceof Headers) {
    return headers.get("origin");
  }
  const value = headers.origin;
  return typeof value === "string" ? value : null;
}

function parseConfiguredOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError(`Invalid trusted socket origin: ${value}`);
  }
  return parsed.origin;
}

function parseRequestOrigin(value: string): string {
  if (value === "null" || value.includes(",")) {
    throw new TypeError("Invalid origin");
  }
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("Invalid origin");
  }
  return parsed.origin;
}
