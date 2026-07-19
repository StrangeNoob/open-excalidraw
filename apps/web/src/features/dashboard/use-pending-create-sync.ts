import type { DrawingSummary } from "@open-excalidraw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { ApiError } from "../../shared/api";
import { AssetClient, AssetUploadManager } from "../assets";
import { useAuth } from "../auth";
import {
  CloudRecoveryRepository,
  ContentClient,
  VersionConflictError,
  type CloudRecoveryRecord,
} from "../persistence";
import {
  DASHBOARD_QUERY_KEY,
  DashboardApiClient,
  type DashboardApi,
} from "./dashboard-api";
import { PendingCreateDb } from "./pending-create-db";
import { useOnlineStatus } from "./use-online-status";

type PendingCreateStore = Pick<PendingCreateDb, "listByUser" | "remove">;
type RecoveryStore = Pick<CloudRecoveryRepository, "get">;
type AssetUploader = Pick<AssetUploadManager, "uploadReferenced">;
type ContentSaver = Pick<ContentClient, "save">;

export interface PendingCreateSyncOptions {
  api?: DashboardApi;
  assets?: AssetUploader;
  content?: ContentSaver;
  recovery?: RecoveryStore;
  store?: PendingCreateStore;
}

const defaultApi = new DashboardApiClient();
const defaultAssets = new AssetUploadManager({ client: new AssetClient() });
const defaultContent = new ContentClient();
const defaultRecovery = new CloudRecoveryRepository();
const defaultStore = new PendingCreateDb();

/**
 * Mounted once in the authenticated shell. On sign-in and on each
 * offline→online transition it replays every offline-created drawing as a
 * server create ({ id, title }) and then pushes its local scene — recovery
 * snapshot assets and content — so the drawing is not empty on other devices.
 * The marker clears once the content push succeeds, or is skipped (no snapshot
 * to push, or a 412 because the drawing was already edited elsewhere), and the
 * dashboard list refreshes. A 409 on create (id now owned by someone else)
 * parks that record for the session; a network failure mid-replay stops until
 * the next transition, which retries create + push end-to-end.
 */
export const usePendingCreateSync = ({
  api = defaultApi,
  assets = defaultAssets,
  content = defaultContent,
  recovery = defaultRecovery,
  store = defaultStore,
}: PendingCreateSyncOptions = {}) => {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id;
  const online = useOnlineStatus();
  // Records that 409'd this session: another user owns the id, so retrying is
  // pointless. Persists across renders; a page reload clears it.
  const skip = useRef(new Set<string>());

  useEffect(() => {
    if (!userId || !online) {
      return;
    }
    let active = true;

    // No in-flight guard: an offline→online bounce may briefly overlap two
    // passes, which is safe — the create replays idempotently server-side and
    // remove/invalidate are idempotent — whereas a guard would skip the rerun
    // and strand pending creates until the next dependency change.
    void (async () => {
      const records = await store.listByUser(userId);
      for (const record of records) {
        if (!active) {
          return;
        }
        if (skip.current.has(record.drawingId)) {
          continue;
        }
        try {
          const drawing = await api.createDrawing(
            record.title,
            record.drawingId,
          );
          // Push the local scene so the drawing is not empty on other devices.
          // No snapshot means nothing to push; a 412 means it was already
          // opened and edited elsewhere, so the local copy is stale — both
          // still clear the marker. Any other push failure propagates below and
          // leaves the marker for the next transition to retry.
          const snapshot = await recovery.get(userId, record.drawingId);
          if (snapshot) {
            await pushSnapshot(drawing, snapshot, assets, content);
          }
          await store.remove(userId, record.drawingId);
          await queryClient.invalidateQueries({
            queryKey: DASHBOARD_QUERY_KEY,
          });
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) {
            skip.current.add(record.drawingId);
            continue;
          }
          // Network failure (create or push): stop; the next transition retries.
          return;
        }
      }
    })().catch(() => undefined);

    return () => {
      active = false;
    };
  }, [api, assets, content, online, queryClient, recovery, store, userId]);
};

/**
 * Uploads the snapshot's assets, then saves its scene against the revision the
 * create returned. A 412 means the drawing was already edited elsewhere, so the
 * local snapshot is stale — swallow it and let the caller clear the marker
 * rather than clobber the newer server scene. Every other failure propagates.
 */
const pushSnapshot = async (
  drawing: DrawingSummary,
  snapshot: CloudRecoveryRecord,
  assets: AssetUploader,
  content: ContentSaver,
): Promise<void> => {
  await assets.uploadReferenced(drawing.id, snapshot.files, snapshot.assetIds);
  try {
    await content.save(
      drawing.id,
      { assetIds: [...snapshot.assetIds], scene: snapshot.scene },
      drawing.contentRevision,
      crypto.randomUUID(),
    );
  } catch (error) {
    if (!(error instanceof VersionConflictError)) {
      throw error;
    }
  }
};
