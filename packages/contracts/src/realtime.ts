import { z } from "zod";

import { assetManifestSchema } from "./assets.js";
import { revisionSchema, roleSchema, uuidSchema } from "./common/primitives.js";
import { excalidrawElementSchema, sceneEnvelopeSchema } from "./content.js";
import { CONTRACT_LIMITS } from "./limits.js";

export const protocolVersionSchema = z.literal(1);

export const sharedSceneStateSchema = z
  .object({
    viewBackgroundColor: z.string().max(64).optional(),
    gridSize: z.number().int().positive().nullable().optional(),
    gridStep: z.number().int().positive().optional(),
  })
  .strict();

export const collaboratorSchema = z
  .object({
    connectionId: z.string().min(1).max(128),
    userId: uuidSchema,
    name: z.string().min(1).max(120),
    image: z.string().url().nullable(),
    role: roleSchema,
  })
  .strict();

export const roomJoinEventSchema = z
  .object({
    type: z.literal("room.join"),
    protocolVersion: protocolVersionSchema,
    drawingId: uuidSchema,
    clientInstanceId: uuidSchema,
    lastRevision: revisionSchema.optional(),
  })
  .strict();

export const roomReadyEventSchema = z
  .object({
    type: z.literal("room.ready"),
    connectionId: z.string().min(1).max(128),
    role: roleSchema,
    revision: revisionSchema,
    snapshot: sceneEnvelopeSchema,
    assetManifest: assetManifestSchema.max(
      CONTRACT_LIMITS.assetManifestEntries,
    ),
    collaborators: z.array(collaboratorSchema),
  })
  .strict();

const patchElementsSchema = z
  .array(excalidrawElementSchema)
  .max(CONTRACT_LIMITS.elementsPerPatch);

export const scenePreviewEventSchema = z
  .object({
    type: z.literal("scene.preview"),
    previewId: uuidSchema,
    baseRevision: revisionSchema,
    elements: patchElementsSchema,
  })
  .strict();

export const sceneMutateEventSchema = z
  .object({
    type: z.literal("scene.mutate"),
    mutationId: uuidSchema,
    baseRevision: revisionSchema,
    elements: patchElementsSchema,
    sharedSceneState: sharedSceneStateSchema.optional(),
  })
  .strict();

export const sceneCommittedEventSchema = z
  .object({
    type: z.literal("scene.committed"),
    mutationId: uuidSchema,
    revision: revisionSchema,
    elements: patchElementsSchema,
    sharedSceneState: sharedSceneStateSchema.optional(),
  })
  .strict();

export const sceneAckEventSchema = z
  .object({
    type: z.literal("scene.ack"),
    mutationId: uuidSchema,
    revision: revisionSchema,
    status: z.enum(["noop", "duplicate"]),
  })
  .strict();

export const presenceUpdateEventSchema = z
  .object({
    type: z.literal("presence.update"),
    pointer: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        tool: z.enum(["pointer", "laser"]),
      })
      .strict()
      .optional(),
    button: z.enum(["down", "up"]).optional(),
    selectedElementIds: z.record(z.string(), z.literal(true)).optional(),
    idleState: z.enum(["active", "idle", "away"]).optional(),
  })
  .strict();

export const roomRoleChangedEventSchema = z
  .object({
    type: z.literal("room.roleChanged"),
    role: roleSchema,
  })
  .strict();

export const roomResyncRequiredEventSchema = z
  .object({
    type: z.literal("room.resyncRequired"),
    revision: revisionSchema,
    reason: z.enum([
      "revision-gap",
      "revision-restored",
      "stale-preview",
      "server-restart",
    ]),
  })
  .strict();

export const protocolErrorEventSchema = z
  .object({
    type: z.literal("protocol.error"),
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(1_024),
    retryable: z.boolean(),
    requestId: z.string().min(1).max(128),
  })
  .strict();

export const clientRealtimeEventSchema = z.discriminatedUnion("type", [
  roomJoinEventSchema,
  scenePreviewEventSchema,
  sceneMutateEventSchema,
  presenceUpdateEventSchema,
]);

export const serverRealtimeEventSchema = z.discriminatedUnion("type", [
  roomReadyEventSchema,
  scenePreviewEventSchema,
  sceneCommittedEventSchema,
  sceneAckEventSchema,
  roomRoleChangedEventSchema,
  roomResyncRequiredEventSchema,
  protocolErrorEventSchema,
]);

export type ClientRealtimeEvent = z.infer<typeof clientRealtimeEventSchema>;
export type ServerRealtimeEvent = z.infer<typeof serverRealtimeEventSchema>;
