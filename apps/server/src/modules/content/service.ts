import { createHash } from "node:crypto";

import {
  CONTRACT_LIMITS,
  saveContentRequestSchema,
  type ContentResponse,
  type SaveContentRequest,
} from "@open-excalidraw/contracts";

import { ContentDomainError } from "./errors.js";
import {
  toContentResponse,
  type ContentRepository,
  type PreparedSave,
  type RevisionRecord,
} from "./types.js";

const DEFAULT_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1_000;

export class ContentService {
  public constructor(
    private readonly repository: ContentRepository,
    private readonly checkpointIntervalMs = DEFAULT_CHECKPOINT_INTERVAL_MS,
    private readonly events?: {
      restored(drawingId: string, revision: bigint): void;
    },
  ) {
    if (
      !Number.isSafeInteger(checkpointIntervalMs) ||
      checkpointIntervalMs < 0
    ) {
      throw new RangeError(
        "checkpointIntervalMs must be a non-negative integer",
      );
    }
  }

  public async load(
    userId: string,
    drawingId: string,
  ): Promise<ContentResponse> {
    const content = await this.repository.load(drawingId, userId);
    if (!content) throw notFound();
    return toContentResponse(content);
  }

  public async save(
    userId: string,
    drawingId: string,
    expectedRevision: bigint,
    mutationId: string,
    body: unknown,
    auditRequestId?: string,
  ): Promise<{ revision: string; savedAt: string }> {
    const prepared = prepareSave(body);
    const result = await this.repository.save({
      drawingId,
      actorUserId: userId,
      expectedRevision,
      mutationId,
      payloadHash: prepared.payloadHash,
      scene: prepared.request.scene,
      sceneBytes: prepared.sceneBytes,
      assetIds: prepared.assetIds,
      checkpointIntervalMs: this.checkpointIntervalMs,
      ...(auditRequestId ? { auditRequestId } : {}),
    });
    switch (result.status) {
      case "saved":
      case "replayed":
        return {
          revision: result.revision.toString(),
          savedAt: result.savedAt.toISOString(),
        };
      case "not-found":
        throw notFound();
      case "forbidden":
        throw forbidden();
      case "conflict":
        throw new ContentDomainError(
          "VERSION_CONFLICT",
          412,
          "The drawing has changed",
          `The current content revision is ${result.currentRevision.toString()}.`,
        );
      case "idempotency-mismatch":
        throw new ContentDomainError(
          "IDEMPOTENCY_MISMATCH",
          409,
          "Idempotency key was already used",
          "Use a new idempotency key for a different scene payload.",
        );
      case "missing-assets":
        throw new ContentDomainError(
          "MISSING_ASSET",
          422,
          "The scene references unavailable assets",
          `Upload these assets before saving: ${result.fileIds.join(", ")}.`,
        );
    }
  }

  public async listRevisions(userId: string, drawingId: string) {
    const revisions = await this.repository.listRevisions(drawingId, userId);
    if (!revisions) throw notFound();
    return { revisions: revisions.map(toRevisionResponse) };
  }

  public async restore(
    userId: string,
    drawingId: string,
    revision: bigint,
    auditRequestId?: string,
  ) {
    const result = await this.repository.restore({
      drawingId,
      actorUserId: userId,
      revision,
      ...(auditRequestId ? { auditRequestId } : {}),
    });
    switch (result.status) {
      case "restored":
        this.events?.restored(drawingId, result.revision);
        return {
          revision: result.revision.toString(),
          savedAt: result.savedAt.toISOString(),
        };
      case "not-found":
        throw notFound();
      case "forbidden":
        throw forbidden();
      case "revision-not-found":
        throw new ContentDomainError(
          "REVISION_NOT_FOUND",
          404,
          "Revision not found",
        );
      case "missing-assets":
        throw new ContentDomainError(
          "MISSING_ASSET",
          422,
          "The revision references unavailable assets",
          `Unavailable assets: ${result.fileIds.join(", ")}.`,
        );
    }
  }
}

export function prepareSave(body: unknown): PreparedSave {
  const request = saveContentRequestSchema.parse(body);
  const assetIds = [...request.assetIds].sort();
  if (new Set(assetIds).size !== assetIds.length) {
    throw new ContentDomainError(
      "DUPLICATE_ASSET_ID",
      400,
      "Asset IDs must be unique",
    );
  }
  const referenced = collectReferencedAssetIds(request);
  if (
    referenced.length !== assetIds.length ||
    referenced.some((fileId, index) => fileId !== assetIds[index])
  ) {
    throw new ContentDomainError(
      "ASSET_MANIFEST_MISMATCH",
      422,
      "The asset manifest does not match the scene",
    );
  }
  const serializedScene = JSON.stringify(request.scene);
  const sceneBytes = Buffer.byteLength(serializedScene);
  if (sceneBytes > CONTRACT_LIMITS.sceneBytes) {
    throw new ContentDomainError(
      "SCENE_TOO_LARGE",
      413,
      "The scene exceeds the maximum size",
      `Scenes may contain at most ${CONTRACT_LIMITS.sceneBytes} bytes.`,
    );
  }
  const payloadHash = createHash("sha256")
    .update(JSON.stringify({ scene: request.scene, assetIds }))
    .digest();
  return { request, sceneBytes, assetIds, payloadHash };
}

function collectReferencedAssetIds(request: SaveContentRequest): string[] {
  const ids = new Set<string>();
  for (const element of request.scene.elements) {
    const fileId = element.fileId;
    if (typeof fileId === "string" && fileId.length > 0) ids.add(fileId);
  }
  return [...ids].sort();
}

function toRevisionResponse(revision: RevisionRecord) {
  return {
    revision: revision.revision.toString(),
    reason: revision.reason,
    authorUserId: revision.authorUserId,
    createdAt: revision.createdAt.toISOString(),
  };
}

const notFound = () =>
  new ContentDomainError("DRAWING_NOT_FOUND", 404, "Drawing not found");

const forbidden = () =>
  new ContentDomainError(
    "FORBIDDEN",
    403,
    "You do not have permission to modify this drawing",
  );
