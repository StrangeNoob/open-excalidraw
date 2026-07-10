import type {
  DrawingListResponse,
  DrawingSummary,
} from "@open-excalidraw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { getDrawingCapabilities } from "../access";
import { DashboardApiClient, type DashboardApi } from "./dashboard-api";

const DASHBOARD_QUERY_KEY = ["drawings", "dashboard"] as const;
const defaultDashboardApi = new DashboardApiClient();

const replaceDrawing = (
  dashboard: DrawingListResponse | undefined,
  replacement: DrawingSummary,
): DrawingListResponse | undefined => {
  if (!dashboard) {
    return dashboard;
  }

  return {
    ...dashboard,
    owned: dashboard.owned.map((drawing) =>
      drawing.id === replacement.id ? replacement : drawing,
    ),
    shared: dashboard.shared.map((drawing) =>
      drawing.id === replacement.id ? replacement : drawing,
    ),
  };
};

const useOnlineStatus = () => {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);

    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);

  return online;
};

const DrawingCard = ({
  drawing,
  onDelete,
  onOpen,
  onRename,
  offline,
  pending,
}: {
  drawing: DrawingSummary;
  onDelete: (drawing: DrawingSummary) => void;
  onOpen: (drawing: DrawingSummary) => void;
  onRename: (drawing: DrawingSummary, title: string) => void;
  offline: boolean;
  pending: boolean;
}) => {
  const capabilities = getDrawingCapabilities(drawing.role);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(drawing.title);

  const submitRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextTitle = title.trim();

    if (!nextTitle || nextTitle === drawing.title) {
      setTitle(drawing.title);
      setRenaming(false);
      return;
    }

    onRename(drawing, nextTitle);
    setRenaming(false);
  };

  return (
    <article className="drawing-card">
      <div className="drawing-card-heading">
        {renaming ? (
          <form aria-label={`Rename ${drawing.title}`} onSubmit={submitRename}>
            <label>
              New title
              <input
                autoFocus
                maxLength={120}
                onChange={(event) => setTitle(event.target.value)}
                value={title}
              />
            </label>
            <button disabled={pending || offline} type="submit">
              Save
            </button>
            <button
              onClick={() => {
                setTitle(drawing.title);
                setRenaming(false);
              }}
              type="button"
            >
              Cancel
            </button>
          </form>
        ) : (
          <h3>{drawing.title}</h3>
        )}
        <span className={`role-badge role-badge-${drawing.role}`}>
          {drawing.role}
        </span>
      </div>

      <dl>
        <div>
          <dt>Owner</dt>
          <dd>{drawing.ownerName}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>
            <time dateTime={drawing.updatedAt}>
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(drawing.updatedAt))}
            </time>
          </dd>
        </div>
      </dl>

      <div className="drawing-card-actions">
        <button
          disabled={pending}
          onClick={() => onOpen(drawing)}
          type="button"
        >
          Open
        </button>
        {capabilities.renameDrawing ? (
          <button
            disabled={pending || offline}
            onClick={() => setRenaming(true)}
            type="button"
          >
            Rename
          </button>
        ) : null}
        {capabilities.deleteDrawing ? (
          <button
            className="danger-button"
            disabled={pending || offline}
            onClick={() => onDelete(drawing)}
            type="button"
          >
            Delete
          </button>
        ) : null}
      </div>
    </article>
  );
};

const DrawingSection = ({
  drawings,
  emptyMessage,
  onDelete,
  onOpen,
  onRename,
  offline,
  pending,
  title,
}: {
  drawings: DrawingSummary[];
  emptyMessage: string;
  onDelete: (drawing: DrawingSummary) => void;
  onOpen: (drawing: DrawingSummary) => void;
  onRename: (drawing: DrawingSummary, title: string) => void;
  offline: boolean;
  pending: boolean;
  title: string;
}) => (
  <section aria-labelledby={`${title.toLowerCase()}-drawings-heading`}>
    <h2 id={`${title.toLowerCase()}-drawings-heading`}>{title}</h2>
    {drawings.length === 0 ? (
      <p className="dashboard-empty">{emptyMessage}</p>
    ) : (
      <div className="drawing-grid">
        {drawings.map((drawing) => (
          <DrawingCard
            drawing={drawing}
            key={drawing.id}
            onDelete={onDelete}
            onOpen={onOpen}
            onRename={onRename}
            offline={offline}
            pending={pending}
          />
        ))}
      </div>
    )}
  </section>
);

export interface DashboardPageProps {
  api?: DashboardApi;
  onOpenDrawing?: (drawing: DrawingSummary) => void;
}

export const DashboardPage = ({
  api = defaultDashboardApi,
  onOpenDrawing,
}: DashboardPageProps) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const online = useOnlineStatus();
  const [newTitle, setNewTitle] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const dashboard = useQuery({
    queryFn: () => api.listDrawings(),
    queryKey: DASHBOARD_QUERY_KEY,
  });

  const createDrawing = useMutation({
    mutationFn: (title: string) => api.createDrawing(title),
    onError: (error) => setActionError(error.message),
    onSuccess: (drawing) => {
      setActionError(null);
      setNewTitle("");
      queryClient.setQueryData<DrawingListResponse>(
        DASHBOARD_QUERY_KEY,
        (current) =>
          current
            ? { ...current, owned: [drawing, ...current.owned] }
            : { nextCursor: null, owned: [drawing], shared: [] },
      );
      (onOpenDrawing ?? ((next) => navigate(`/drawings/${next.id}`)))(drawing);
    },
  });

  const renameDrawing = useMutation({
    mutationFn: ({
      drawing,
      title,
    }: {
      drawing: DrawingSummary;
      title: string;
    }) => api.renameDrawing(drawing, title),
    onError: (error) => setActionError(error.message),
    onSuccess: (drawing) => {
      setActionError(null);
      queryClient.setQueryData<DrawingListResponse>(
        DASHBOARD_QUERY_KEY,
        (current) => replaceDrawing(current, drawing),
      );
    },
  });

  const deleteDrawing = useMutation({
    mutationFn: (drawing: DrawingSummary) => api.deleteDrawing(drawing),
    onError: (error) => setActionError(error.message),
    onSuccess: (_, deleted) => {
      setActionError(null);
      queryClient.setQueryData<DrawingListResponse>(
        DASHBOARD_QUERY_KEY,
        (current) =>
          current
            ? {
                ...current,
                owned: current.owned.filter(({ id }) => id !== deleted.id),
                shared: current.shared.filter(({ id }) => id !== deleted.id),
              }
            : current,
      );
    },
  });

  const pending =
    createDrawing.isPending ||
    renameDrawing.isPending ||
    deleteDrawing.isPending;

  const submitCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = newTitle.trim();

    if (!title) {
      setActionError("Enter a drawing title.");
      return;
    }

    createDrawing.mutate(title);
  };

  const requestDelete = (drawing: DrawingSummary) => {
    if (
      globalThis.confirm(`Delete “${drawing.title}”? This cannot be undone.`)
    ) {
      deleteDrawing.mutate(drawing);
    }
  };

  return (
    <main className="dashboard-page">
      <header className="dashboard-header">
        <div>
          <p className="dashboard-eyebrow">Open Excalidraw</p>
          <h1>Your drawings</h1>
        </div>
        <form className="create-drawing" onSubmit={submitCreate}>
          <label>
            New drawing title
            <input
              maxLength={120}
              onChange={(event) => setNewTitle(event.target.value)}
              placeholder="Sprint planning"
              value={newTitle}
            />
          </label>
          <button disabled={pending || !online} type="submit">
            Create drawing
          </button>
        </form>
      </header>

      {!online ? (
        <p className="dashboard-notice" role="status">
          You are offline. Existing dashboard data is shown read-only.
        </p>
      ) : null}
      {actionError ? <p role="alert">{actionError}</p> : null}

      {dashboard.isPending ? (
        <p aria-live="polite">Loading drawings…</p>
      ) : dashboard.isError ? (
        <section className="dashboard-error" role="alert">
          <h2>Could not load your drawings</h2>
          <p>{dashboard.error.message}</p>
          <button onClick={() => void dashboard.refetch()} type="button">
            Try again
          </button>
        </section>
      ) : (
        <div className="dashboard-sections">
          <DrawingSection
            drawings={dashboard.data.owned}
            emptyMessage="Create your first drawing to get started."
            onDelete={requestDelete}
            onOpen={(drawing) =>
              (onOpenDrawing ?? ((next) => navigate(`/drawings/${next.id}`)))(
                drawing,
              )
            }
            onRename={(drawing, title) =>
              renameDrawing.mutate({ drawing, title })
            }
            offline={!online}
            pending={pending}
            title="Owned"
          />
          <DrawingSection
            drawings={dashboard.data.shared}
            emptyMessage="Drawings shared with you will appear here."
            onDelete={requestDelete}
            onOpen={(drawing) =>
              (onOpenDrawing ?? ((next) => navigate(`/drawings/${next.id}`)))(
                drawing,
              )
            }
            onRename={(drawing, title) =>
              renameDrawing.mutate({ drawing, title })
            }
            offline={!online}
            pending={pending}
            title="Shared"
          />
        </div>
      )}
    </main>
  );
};
