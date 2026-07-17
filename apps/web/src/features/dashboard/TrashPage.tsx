import type {
  TrashedDrawing,
  TrashListResponse,
} from "@open-excalidraw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import {
  DASHBOARD_QUERY_KEY,
  DashboardApiClient,
  TRASH_QUERY_KEY,
  type DashboardApi,
} from "./dashboard-api";
import { useOnlineStatus } from "./use-online-status";

const defaultTrashApi = new DashboardApiClient();

const deletedWhen = (deletedAt: string): string => {
  // Clamped: a deletedAt slightly ahead of the client clock (routine skew)
  // must render "today", not "tomorrow".
  const days = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(deletedAt)) / 86_400_000),
  );
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    -days,
    "day",
  );
};

export interface TrashPageProps {
  api?: DashboardApi;
}

export const TrashPage = ({ api = defaultTrashApi }: TrashPageProps) => {
  const queryClient = useQueryClient();
  const online = useOnlineStatus();
  const [actionError, setActionError] = useState<string | null>(null);
  const trash = useQuery({
    queryFn: () => api.listTrash(),
    queryKey: TRASH_QUERY_KEY,
  });

  const removeFromTrashCache = (removedId: string) => {
    queryClient.setQueryData<TrashListResponse>(TRASH_QUERY_KEY, (current) =>
      current
        ? { drawings: current.drawings.filter(({ id }) => id !== removedId) }
        : current,
    );
  };

  const restoreDrawing = useMutation({
    mutationFn: (drawing: TrashedDrawing) => api.restoreDrawing(drawing),
    onError: (error) => setActionError(error.message),
    onSuccess: (restored) => {
      setActionError(null);
      removeFromTrashCache(restored.id);
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY });
    },
  });

  const purgeDrawing = useMutation({
    mutationFn: (drawing: TrashedDrawing) => api.purgeDrawing(drawing),
    onError: (error) => setActionError(error.message),
    onSuccess: (_, purged) => {
      setActionError(null);
      removeFromTrashCache(purged.id);
    },
  });

  const pending = restoreDrawing.isPending || purgeDrawing.isPending;

  const requestPurge = (drawing: TrashedDrawing) => {
    if (
      globalThis.confirm(
        `Permanently delete “${drawing.title}”? This cannot be undone.`,
      )
    ) {
      purgeDrawing.mutate(drawing);
    }
  };

  return (
    <main className="dashboard-page">
      <header className="dashboard-header">
        <div>
          <p className="dashboard-eyebrow">Open Excalidraw</p>
          <h1>Trash</h1>
          <Link to="/app">Back to dashboard</Link>
        </div>
      </header>

      <p className="dashboard-notice">
        Items in the trash are permanently deleted automatically after 7 days.
      </p>
      {!online ? (
        <p className="dashboard-notice" role="status">
          You are offline. The trash is shown read-only.
        </p>
      ) : null}
      {actionError ? <p role="alert">{actionError}</p> : null}

      {trash.isPending ? (
        <p aria-live="polite">Loading trash…</p>
      ) : trash.isError ? (
        <section className="dashboard-error" role="alert">
          <h2>Could not load the trash</h2>
          <p>{trash.error.message}</p>
          <button onClick={() => void trash.refetch()} type="button">
            Try again
          </button>
        </section>
      ) : trash.data.drawings.length === 0 ? (
        <p className="dashboard-empty">The trash is empty.</p>
      ) : (
        <div className="drawing-grid">
          {trash.data.drawings.map((drawing) => (
            <article className="drawing-card" key={drawing.id}>
              <div className="drawing-card-heading">
                <h3>{drawing.title}</h3>
              </div>
              <dl>
                <div>
                  <dt>Deleted</dt>
                  <dd>
                    <time dateTime={drawing.deletedAt}>
                      {deletedWhen(drawing.deletedAt)}
                    </time>
                  </dd>
                </div>
              </dl>
              <div className="drawing-card-actions">
                <button
                  disabled={pending || !online}
                  onClick={() => restoreDrawing.mutate(drawing)}
                  type="button"
                >
                  Restore
                </button>
                <button
                  className="danger-button"
                  disabled={pending || !online}
                  onClick={() => requestPurge(drawing)}
                  type="button"
                >
                  Delete forever
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
};
