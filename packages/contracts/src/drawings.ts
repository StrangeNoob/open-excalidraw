import { z } from "zod";

import {
  isoDateTimeSchema,
  revisionSchema,
  roleSchema,
  uuidSchema,
} from "./common/primitives.js";
import { CONTRACT_LIMITS } from "./limits.js";

export const drawingTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(CONTRACT_LIMITS.drawingTitleCharacters);

export const drawingSummarySchema = z
  .object({
    id: uuidSchema,
    title: drawingTitleSchema,
    ownerUserId: uuidSchema,
    ownerName: z.string().min(1).max(120),
    role: roleSchema,
    contentRevision: revisionSchema,
    metadataRevision: revisionSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const drawingListResponseSchema = z
  .object({
    owned: z.array(drawingSummarySchema),
    shared: z.array(drawingSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const createDrawingRequestSchema = z
  .object({
    title: drawingTitleSchema,
    idempotencyKey: uuidSchema.optional(),
  })
  .strict();

export const updateDrawingRequestSchema = z
  .object({
    title: drawingTitleSchema,
    metadataRevision: revisionSchema,
  })
  .strict();

export type DrawingSummary = z.infer<typeof drawingSummarySchema>;
export type DrawingListResponse = z.infer<typeof drawingListResponseSchema>;
export type CreateDrawingRequest = z.infer<typeof createDrawingRequestSchema>;
