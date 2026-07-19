import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { ApiError } from "../../shared/api";
import { useAuth } from "../auth";
import {
  DASHBOARD_QUERY_KEY,
  DashboardApiClient,
  type DashboardApi,
} from "./dashboard-api";
import { PendingCreateDb } from "./pending-create-db";
import { useOnlineStatus } from "./use-online-status";

type PendingCreateStore = Pick<PendingCreateDb, "listByUser" | "remove">;

export interface PendingCreateSyncOptions {
  api?: DashboardApi;
  store?: PendingCreateStore;
}

const defaultApi = new DashboardApiClient();
const defaultStore = new PendingCreateDb();

/**
 * Mounted once in the authenticated shell. On sign-in and on each
 * offline→online transition it replays every offline-created drawing as a
 * server create ({ id, title }), clearing its marker and refreshing the
 * dashboard list. A 409 (id now owned by someone else) parks that record for
 * the session; a network failure just stops until the next transition.
 */
export const usePendingCreateSync = ({
  api = defaultApi,
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
          // v1: the server holds an empty scene for this drawing until it is
          // next opened, when the collaboration outbox rebases the offline
          // edits back onto it.
          await api.createDrawing(record.title, record.drawingId);
          await store.remove(userId, record.drawingId);
          await queryClient.invalidateQueries({
            queryKey: DASHBOARD_QUERY_KEY,
          });
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) {
            skip.current.add(record.drawingId);
            continue;
          }
          // Network failure: stop; the next online transition retries.
          return;
        }
      }
    })().catch(() => undefined);

    return () => {
      active = false;
    };
  }, [api, online, queryClient, store, userId]);
};
