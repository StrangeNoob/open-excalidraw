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

export const drawingTagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(CONTRACT_LIMITS.drawingTagCharacters);

export const drawingTagsSchema = z
  .array(drawingTagSchema)
  .max(CONTRACT_LIMITS.drawingTagsPerDrawing);

export const drawingSummarySchema = z
  .object({
    id: uuidSchema,
    title: drawingTitleSchema,
    ownerUserId: uuidSchema,
    ownerName: z.string().min(1).max(120),
    role: roleSchema,
    // Per-user private tags of the requesting user; defaulted for older
    // server responses that predate tagging.
    tags: drawingTagsSchema.default([]),
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

export const setDrawingTagsRequestSchema = z
  .object({
    tags: drawingTagsSchema,
  })
  .strict();

export type DrawingSummary = z.infer<typeof drawingSummarySchema>;
export type DrawingListResponse = z.infer<typeof drawingListResponseSchema>;
export type CreateDrawingRequest = z.infer<typeof createDrawingRequestSchema>;
export type SetDrawingTagsRequest = z.infer<typeof setDrawingTagsRequestSchema>;
