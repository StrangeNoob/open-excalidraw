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
    // Defaulted for older server responses that predate tagging.
    tags: drawingTagsSchema.default([]).meta({
      description: "The requesting user's private tags.",
    }),
    contentRevision: revisionSchema,
    metadataRevision: revisionSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    // Defaulted for older servers that predate thumbnails.
    thumbnailUpdatedAt: isoDateTimeSchema
      .nullable()
      .default(null)
      .meta({
        description:
          "When the dashboard thumbnail was last replaced; null until a " +
          "client has rendered one.",
      }),
    // Defaulted for older server responses that predate templates.
    isTemplate: z.boolean().default(false).meta({
      description:
        "Templates appear in the dashboard's “New from template” list.",
    }),
  })
  .strict();

export const drawingListResponseSchema = z
  .object({
    owned: z.array(drawingSummarySchema),
    shared: z.array(drawingSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const trashedDrawingSchema = drawingSummarySchema.extend({
  deletedAt: isoDateTimeSchema.meta({
    description: "When the drawing was moved to the trash.",
  }),
});

export const trashListResponseSchema = z
  .object({
    drawings: z.array(trashedDrawingSchema),
  })
  .strict();

export const createDrawingRequestSchema = z
  .object({
    title: drawingTitleSchema,
    idempotencyKey: uuidSchema.optional(),
  })
  .strict();

export const duplicateDrawingRequestSchema = z
  .object({
    idempotencyKey: uuidSchema.optional(),
  })
  .strict();

export const updateDrawingRequestSchema = z
  .object({
    title: drawingTitleSchema,
    metadataRevision: revisionSchema,
    isTemplate: z.boolean().optional(),
  })
  .strict();

export const setDrawingTagsRequestSchema = z
  .object({
    tags: drawingTagsSchema,
  })
  .strict();

export type DrawingSummary = z.infer<typeof drawingSummarySchema>;
export type DrawingListResponse = z.infer<typeof drawingListResponseSchema>;
export type TrashedDrawing = z.infer<typeof trashedDrawingSchema>;
export type TrashListResponse = z.infer<typeof trashListResponseSchema>;
export type CreateDrawingRequest = z.infer<typeof createDrawingRequestSchema>;
export type DuplicateDrawingRequest = z.infer<
  typeof duplicateDrawingRequestSchema
>;
export type SetDrawingTagsRequest = z.infer<typeof setDrawingTagsRequestSchema>;
