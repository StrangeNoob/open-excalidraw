import type {
  ContentResponse,
  Role,
  SaveContentRequest,
  SceneEnvelope,
} from "@open-excalidraw/contracts";

export interface ContentAccess {
  role: Role;
}

export interface StoredContent {
  revision: bigint;
  scene: SceneEnvelope;
  assetIds: string[];
  savedAt: Date;
}

export interface SaveContentInput {
  drawingId: string;
  actorUserId: string;
  expectedRevision: bigint;
  mutationId: string;
  payloadHash: Buffer;
  scene: SceneEnvelope;
  sceneBytes: number;
  assetIds: string[];
  checkpointIntervalMs: number;
  auditRequestId?: string;
}

export type SaveContentResult =
  | { status: "saved" | "replayed"; revision: bigint; savedAt: Date }
  | { status: "not-found" }
  | { status: "forbidden" }
  | { status: "conflict"; currentRevision: bigint }
  | { status: "idempotency-mismatch" }
  | { status: "missing-assets"; fileIds: string[] };

export interface RevisionRecord {
  revision: bigint;
  reason: "checkpoint" | "restore";
  // Null when the authoring account was deleted (ON DELETE SET NULL, 0011).
  authorUserId: string | null;
  createdAt: Date;
}

export type RestoreRevisionResult =
  | { status: "restored"; revision: bigint; savedAt: Date }
  | { status: "not-found" }
  | { status: "forbidden" }
  | { status: "revision-not-found" }
  | { status: "missing-assets"; fileIds: string[] };

export interface ContentRepository {
  load(drawingId: string, userId: string): Promise<StoredContent | null>;
  save(input: SaveContentInput): Promise<SaveContentResult>;
  listRevisions(
    drawingId: string,
    userId: string,
  ): Promise<RevisionRecord[] | null>;
  restore(input: {
    drawingId: string;
    actorUserId: string;
    revision: bigint;
    auditRequestId?: string;
  }): Promise<RestoreRevisionResult>;
}

export const toContentResponse = (content: StoredContent): ContentResponse => ({
  revision: content.revision.toString(),
  scene: content.scene,
  assetIds: content.assetIds,
  savedAt: content.savedAt.toISOString(),
});

export interface PreparedSave {
  request: SaveContentRequest;
  sceneBytes: number;
  assetIds: string[];
  payloadHash: Buffer;
}
