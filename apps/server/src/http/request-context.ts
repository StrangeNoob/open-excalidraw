import { randomUUID } from "node:crypto";

import type { Request, Response } from "express";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export function safeRequestId(value: string | undefined): string {
  const candidate = value?.trim().slice(0, 128);
  return candidate && REQUEST_ID_PATTERN.test(candidate)
    ? candidate
    : randomUUID();
}

export function requestIdFor(request: Request, response: Response): string {
  const assigned = (response.locals as Record<string, unknown>).requestId;
  return typeof assigned === "string" && REQUEST_ID_PATTERN.test(assigned)
    ? assigned
    : safeRequestId(request.get("x-request-id"));
}
