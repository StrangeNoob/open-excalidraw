import { z } from "zod";

import { fileIdSchema, revisionSchema } from "./common/primitives";
import { CONTRACT_LIMITS } from "./limits";

export const excalidrawElementSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.string().min(1).max(64),
    version: z.number().int().nonnegative(),
    versionNonce: z.number().int(),
    isDeleted: z.boolean(),
    index: z.string().nullable().optional(),
  })
  .passthrough();

export const sceneAppStateSchema = z.record(z.string(), z.unknown());

export const sceneEnvelopeSchema = z
  .object({
    type: z.literal("excalidraw"),
    version: z.number().int().nonnegative(),
    source: z.string().max(2_048),
    elements: z
      .array(excalidrawElementSchema)
      .max(CONTRACT_LIMITS.elementsPerScene),
    appState: sceneAppStateSchema,
  })
  .strict();

export const contentResponseSchema = z
  .object({
    revision: revisionSchema,
    scene: sceneEnvelopeSchema,
    assetIds: z.array(fileIdSchema).max(CONTRACT_LIMITS.assetManifestEntries),
    savedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const saveContentRequestSchema = z
  .object({
    scene: sceneEnvelopeSchema,
    assetIds: z.array(fileIdSchema).max(CONTRACT_LIMITS.assetManifestEntries),
  })
  .strict();

export const saveContentResponseSchema = z
  .object({
    revision: revisionSchema,
    savedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ExcalidrawElementDTO = z.infer<typeof excalidrawElementSchema>;
export type SceneEnvelope = z.infer<typeof sceneEnvelopeSchema>;
export type ContentResponse = z.infer<typeof contentResponseSchema>;
export type SaveContentRequest = z.infer<typeof saveContentRequestSchema>;
