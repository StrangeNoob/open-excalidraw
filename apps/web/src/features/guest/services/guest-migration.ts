import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import {
  drawingSummarySchema,
  type DrawingSummary,
  type SaveContentRequest,
} from "@open-excalidraw/contracts";
import { z } from "zod";

import {
  AssetClient,
  AssetUploadManager,
  collectAssetReferences,
} from "../../assets";
import { ContentClient } from "../../persistence";
import { HttpApiClient } from "../../../shared/api";
import type {
  CompleteGuestMigrationInput,
  GuestMigrationRecord,
  GuestSceneRecord,
} from "../model";

export interface GuestMigrationRepository {
  getAssets(
    drawingId: string,
    fileIds?: readonly string[],
  ): Promise<BinaryFiles>;
  getMigrationMarker(
    userId: string,
    drawingId: string,
  ): Promise<GuestMigrationRecord | undefined>;
  loadScene(drawingId: string): Promise<GuestSceneRecord | undefined>;
  markMigrationComplete(
    input: CompleteGuestMigrationInput,
  ): Promise<GuestMigrationRecord>;
}

export interface GuestMigrationCloud {
  createDrawing(
    title: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<Pick<DrawingSummary, "id" | "contentRevision" | "ownerUserId">>;
  saveContent(
    drawingId: string,
    request: SaveContentRequest,
    revision: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<{ revision: string }>;
  uploadAssets(
    drawingId: string,
    files: BinaryFiles,
    fileIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface GuestMigrationScope {
  getActiveUserId: () => string | null;
  signal?: AbortSignal;
}

export class GuestMigrationScopeError extends Error {
  constructor(message = "The authenticated account changed during migration") {
    super(message);
    this.name = "GuestMigrationScopeError";
  }
}

export interface GuestMigrationCandidate {
  alreadyMigrated: boolean;
  drawingId: string;
  localRevision: number;
  title: string;
}

export class GuestMigrationService {
  constructor(
    readonly repository: GuestMigrationRepository,
    readonly cloud: GuestMigrationCloud,
    readonly createStableKey: (value: string) => Promise<string> = stableUuid,
  ) {}

  async inspect(
    userId: string,
    drawingId: string,
  ): Promise<GuestMigrationCandidate | null> {
    const scene = await this.repository.loadScene(drawingId);
    if (!scene) {
      return null;
    }
    const marker = await this.repository.getMigrationMarker(userId, drawingId);
    return {
      alreadyMigrated: Boolean(
        marker && marker.migratedLocalRevision >= scene.revision,
      ),
      drawingId,
      localRevision: scene.revision,
      title: scene.title,
    };
  }

  async migrate(
    userId: string,
    drawingId: string,
    scope: GuestMigrationScope,
  ): Promise<GuestMigrationRecord> {
    assertMigrationScope(userId, scope);
    const scene = await this.repository.loadScene(drawingId);
    assertMigrationScope(userId, scope);
    if (!scene) {
      throw new Error("The local drawing no longer exists");
    }
    const existing = await this.repository.getMigrationMarker(
      userId,
      drawingId,
    );
    assertMigrationScope(userId, scope);
    if (existing && existing.migratedLocalRevision >= scene.revision) {
      return existing;
    }

    // Clone once so changes that occur during network work form a later revision.
    const frozen = JSON.parse(JSON.stringify(scene)) as GuestSceneRecord;
    const assetIds = collectAssetReferences(frozen.scene.elements ?? []);
    const files = await this.repository.getAssets(drawingId, assetIds);
    assertMigrationScope(userId, scope);
    const createKey = await this.createStableKey(
      `guest:${userId}:${drawingId}:create`,
    );
    assertMigrationScope(userId, scope);
    const drawing = await this.cloud.createDrawing(
      frozen.title,
      createKey,
      scope.signal,
    );
    assertMigrationScope(userId, scope);
    if (drawing.ownerUserId !== userId) {
      throw new GuestMigrationScopeError(
        "The created drawing belongs to a different account",
      );
    }

    await this.cloud.uploadAssets(drawing.id, files, assetIds, scope.signal);
    assertMigrationScope(userId, scope);
    const request = toSaveRequest(frozen, assetIds);
    const contentKey = await this.createStableKey(
      `guest:${userId}:${drawingId}:revision:${frozen.revision}`,
    );
    assertMigrationScope(userId, scope);
    await this.cloud.saveContent(
      drawing.id,
      request,
      drawing.contentRevision,
      contentKey,
      scope.signal,
    );
    assertMigrationScope(userId, scope);

    // This is intentionally last: every failure above leaves the guest intact.
    const marker = await this.repository.markMigrationComplete({
      drawingId,
      migratedLocalRevision: frozen.revision,
      targetCloudDrawingId: drawing.id,
      userId,
    });
    assertMigrationScope(userId, scope);
    return marker;
  }
}

const drawingMutationResponseSchema = z.union([
  drawingSummarySchema,
  z.object({ drawing: drawingSummarySchema }).strict(),
]);

/** Default HTTP adapter; injecting GuestMigrationCloud keeps the workflow testable. */
export class GuestMigrationCloudClient implements GuestMigrationCloud {
  constructor(
    readonly api = new HttpApiClient(),
    readonly content = new ContentClient(),
    readonly assets = new AssetUploadManager({
      client: new AssetClient(),
    }),
  ) {}

  async createDrawing(
    title: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) {
    const response = await this.api.request(
      "/v1/drawings",
      {
        body: JSON.stringify({ idempotencyKey, title }),
        method: "POST",
        signal,
      },
      drawingMutationResponseSchema,
    );
    const drawing = "drawing" in response ? response.drawing : response;
    return {
      id: drawing.id,
      contentRevision: drawing.contentRevision,
      ownerUserId: drawing.ownerUserId,
    };
  }

  saveContent(
    drawingId: string,
    request: SaveContentRequest,
    revision: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) {
    return this.content.save(
      drawingId,
      request,
      revision,
      idempotencyKey,
      signal,
    );
  }

  async uploadAssets(
    drawingId: string,
    files: BinaryFiles,
    fileIds: readonly string[],
    signal?: AbortSignal,
  ) {
    await this.assets.uploadReferenced(drawingId, files, fileIds, signal);
  }
}

const toSaveRequest = (
  record: GuestSceneRecord,
  assetIds: readonly string[],
): SaveContentRequest => ({
  assetIds: [...assetIds],
  scene: {
    appState: record.scene.appState ?? {},
    elements: (record.scene.elements ??
      []) as unknown as SaveContentRequest["scene"]["elements"],
    source: "https://open-excalidraw.local",
    type: "excalidraw",
    version: 2,
  },
});

export const stableUuid = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...hash.slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const assertMigrationScope = (
  expectedUserId: string,
  scope: GuestMigrationScope,
) => {
  scope.signal?.throwIfAborted();
  if (scope.getActiveUserId() !== expectedUserId) {
    throw new GuestMigrationScopeError();
  }
};
