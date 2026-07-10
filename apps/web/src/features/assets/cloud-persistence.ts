import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { SaveContentRequest } from "@open-excalidraw/contracts";

import type { AutosaveSnapshot, ContentClient } from "../persistence";
import type { AssetUploadManager } from "./asset-client";

export interface CloudSceneSnapshot extends AutosaveSnapshot {
  files: BinaryFiles;
  request: SaveContentRequest;
}

/** Enforces the invariant that every referenced blob exists before scene commit. */
export class CloudPersistence {
  constructor(
    readonly drawingId: string,
    readonly content: Pick<ContentClient, "save">,
    readonly assets: Pick<AssetUploadManager, "uploadReferenced">,
  ) {}

  async persist(
    snapshot: AutosaveSnapshot,
    revision: string,
    idempotencyKey: string,
  ) {
    const cloud = snapshot as CloudSceneSnapshot;
    await this.assets.uploadReferenced(
      this.drawingId,
      cloud.files,
      cloud.request.assetIds,
    );
    return this.content.save(
      this.drawingId,
      cloud.request,
      revision,
      idempotencyKey,
    );
  }
}
