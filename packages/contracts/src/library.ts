import { z } from "zod";

import { CONTRACT_LIMITS } from "./limits.js";

export const libraryItemSchema = z
  .object({ id: z.string().min(1).max(256) })
  .passthrough();

export const libraryResponseSchema = z
  .object({
    items: z.array(libraryItemSchema).max(CONTRACT_LIMITS.libraryItemsPerUser),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const saveLibraryRequestSchema = z
  .object({
    items: z.array(libraryItemSchema).max(CONTRACT_LIMITS.libraryItemsPerUser),
  })
  .strict();

export type LibraryItem = z.infer<typeof libraryItemSchema>;
export type LibraryResponse = z.infer<typeof libraryResponseSchema>;
export type SaveLibraryRequest = z.infer<typeof saveLibraryRequestSchema>;
