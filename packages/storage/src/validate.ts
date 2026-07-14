import { InvalidStorageKeyError, StorageIntegrityError } from "./errors.js";

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const DEFAULT_MAX_OBJECT_BYTES = 50 * 1024 * 1024;

export function validateStorageKey(key: string): void {
  if (
    key.length === 0 ||
    key.length > 1024 ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.includes("\\") ||
    key.includes("\0")
  ) {
    throw new InvalidStorageKeyError();
  }

  const segments = key.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.length > 255,
    )
  ) {
    throw new InvalidStorageKeyError();
  }
}

export function normalizeExpectedSha256(value?: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new StorageIntegrityError();
  }
  return normalized;
}

/** Validate an implementation-wide byte limit and apply the shared default. */
export function validateMaxObjectBytes(value?: number): number {
  const resolved = value ?? DEFAULT_MAX_OBJECT_BYTES;
  if (!Number.isSafeInteger(resolved)) {
    throw new RangeError("maxObjectBytes must be a safe integer");
  }
  if (resolved <= 0) {
    throw new RangeError("maxObjectBytes must be greater than zero");
  }
  return resolved;
}

export function effectiveByteLimit(
  requestedLimit: number | undefined,
  maxObjectBytes: number,
): number {
  if (requestedLimit === undefined) {
    return maxObjectBytes;
  }
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  return Math.min(requestedLimit, maxObjectBytes);
}
