import { z } from "zod";

import {
  fileIdSchema,
  isoDateTimeSchema,
  uuidSchema,
} from "./common/primitives.js";

export const assetMetadataSchema = z
  .object({
    id: uuidSchema,
    drawingId: uuidSchema,
    fileId: fileIdSchema,
    mimeType: z.string().min(1).max(255),
    byteSize: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    fileVersion: z.number().int().positive().nullable(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const assetManifestSchema = z.array(assetMetadataSchema);

export type AssetMetadata = z.infer<typeof assetMetadataSchema>;
