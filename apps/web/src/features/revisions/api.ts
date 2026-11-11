import { revisionSchema } from "@open-excalidraw/contracts";
import { z } from "zod";

import { HttpApiClient } from "../../shared/api";

const revisionEntrySchema = z
  .object({
    authorUserId: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
    reason: z.enum(["checkpoint", "restore"]),
    revision: revisionSchema,
  })
  .strict();

const revisionListSchema = z
  .object({ revisions: z.array(revisionEntrySchema) })
  .strict();

const restoreResponseSchema = z
  .object({
    revision: revisionSchema,
    savedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type RevisionEntry = z.infer<typeof revisionEntrySchema>;
export type RestoreResponse = z.infer<typeof restoreResponseSchema>;

export interface RevisionSource {
  list(drawingId: string): Promise<{ revisions: RevisionEntry[] }>;
  restore(drawingId: string, revision: string): Promise<RestoreResponse>;
}

export class RevisionClient implements RevisionSource {
  constructor(private readonly api = new HttpApiClient()) {}

  list(drawingId: string) {
    return this.api.request(
      `/v1/drawings/${encodeURIComponent(drawingId)}/revisions`,
      { method: "GET" },
      revisionListSchema,
    );
  }

  restore(drawingId: string, revision: string) {
    return this.api.request(
      `/v1/drawings/${encodeURIComponent(drawingId)}/revisions/${encodeURIComponent(revision)}/restore`,
      { method: "POST" },
      restoreResponseSchema,
    );
  }
}
