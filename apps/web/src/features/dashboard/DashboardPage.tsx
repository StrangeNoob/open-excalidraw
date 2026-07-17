import type {
  DrawingListResponse,
  DrawingSummary,
} from "@open-excalidraw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { getDrawingCapabilities } from "../access";
import {
  DASHBOARD_QUERY_KEY,
  DashboardApiClient,
  TRASH_QUERY_KEY,
  type DashboardApi,
} from "./dashboard-api";
import { useOnlineStatus } from "./use-online-status";

const MAX_TAGS = 20;
const defaultDashboardApi = new DashboardApiClient();

const parseTags = (value: string): string[] => [
  ...new Set(
    value
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean),
  ),
];

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

const DrawingCard = ({
  drawing,
  onDelete,
  onDuplicate,
  onEditTags,
  onOpen,
  onRename,
  onSetTemplate,
  offline,
  pending,
}: {
  drawing: DrawingSummary;
  onDelete: (drawing: DrawingSummary) => void;
  onDuplicate: (drawing: DrawingSummary) => void;
  onEditTags: (drawing: DrawingSummary, tags: string[]) => void;
  onOpen: (drawing: DrawingSummary) => void;
  onRename: (drawing: DrawingSummary, title: string) => void;
  onSetTemplate: (drawing: DrawingSummary, isTemplate: boolean) => void;
  offline: boolean;
  pending: boolean;
}) => {
  const capabilities = getDrawingCapabilities(drawing.role);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(drawing.title);
  const [editingTags, setEditingTags] = useState(false);
  const [tagsInput, setTagsInput] = useState(drawing.tags.join(", "));
  const [tagsError, setTagsError] = useState<string | null>(null);

  const submitTags = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextTags = parseTags(tagsInput);

    if (nextTags.length > MAX_TAGS) {
      setTagsError(`Use at most ${MAX_TAGS} tags.`);
      return;
    }

    setTagsError(null);
    setEditingTags(false);

    if (nextTags.join("\n") === drawing.tags.join("\n")) {
      setTagsInput(drawing.tags.join(", "));
      return;
    }

    onEditTags(drawing, nextTags);
  };

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
      {drawing.thumbnailUpdatedAt ? (
        <img
          alt=""
          className="drawing-card-thumbnail"
          // Remount per version: onError hides the node, and a reused node
          // would keep a replacement thumbnail hidden.
          key={drawing.thumbnailUpdatedAt}
          loading="lazy"
          onError={(event) => {
            // A 404 (e.g. thumbnail replaced mid-render) degrades to the
            // text-only card.
            event.currentTarget.hidden = true;
          }}
          src={`/api/v1/drawings/${drawing.id}/thumbnail?v=${encodeURIComponent(
            drawing.thumbnailUpdatedAt,
          )}`}
        />
      ) : null}
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
        {drawing.isTemplate ? (
          <span className="role-badge template-badge">template</span>
        ) : null}
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

      {editingTags ? (
        <form
          aria-label={`Edit tags of ${drawing.title}`}
          onSubmit={submitTags}
        >
          <label>
            Tags (comma-separated)
            <input
              autoFocus
              onChange={(event) => setTagsInput(event.target.value)}
              placeholder="ideas, sprint-12"
              value={tagsInput}
            />
          </label>
          {tagsError ? <p role="alert">{tagsError}</p> : null}
          <button disabled={pending || offline} type="submit">
            Save
          </button>
          <button
            onClick={() => {
              setTagsInput(drawing.tags.join(", "));
              setTagsError(null);
              setEditingTags(false);
            }}
            type="button"
          >
            Cancel
          </button>
        </form>
      ) : drawing.tags.length > 0 ? (
        <ul aria-label="Tags" className="tag-list">
          {drawing.tags.map((tag) => (
            <li className="tag-chip" key={tag}>
              {tag}
            </li>
          ))}
        </ul>
      ) : null}

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
        <button
          disabled={pending || offline}
          onClick={() => onDuplicate(drawing)}
          type="button"
        >
          Duplicate
        </button>
        {/* The template flag is drawing-level metadata, so it follows the
            same capability as renaming. */}
        {capabilities.renameDrawing ? (
          <button
            disabled={pending || offline}
            onClick={() => onSetTemplate(drawing, !drawing.isTemplate)}
            type="button"
          >
            {drawing.isTemplate ? "Remove template" : "Make template"}
          </button>
        ) : null}
        <button
          disabled={pending || offline}
          onClick={() => {
            setTagsInput(drawing.tags.join(", "));
            setTagsError(null);
            setEditingTags(true);
          }}
          type="button"
        >
          Edit tags
        </button>
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
  onDuplicate,
  onEditTags,
  onOpen,
  onRename,
  onSetTemplate,
  offline,
  pending,
  title,
}: {
  drawings: DrawingSummary[];
  emptyMessage: string;
  onDelete: (drawing: DrawingSummary) => void;
  onDuplicate: (drawing: DrawingSummary) => void;
  onEditTags: (drawing: DrawingSummary, tags: string[]) => void;
  onOpen: (drawing: DrawingSummary) => void;
  onRename: (drawing: DrawingSummary, title: string) => void;
  onSetTemplate: (drawing: DrawingSummary, isTemplate: boolean) => void;
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
            onDuplicate={onDuplicate}
            onEditTags={onEditTags}
            onOpen={onOpen}
            onRename={onRename}
            onSetTemplate={onSetTemplate}
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
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState("");
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

  const duplicateDrawing = useMutation({
    mutationFn: (drawing: DrawingSummary) => api.duplicateDrawing(drawing),
    onError: (error) => setActionError(error.message),
    onSuccess: (drawing) => {
      setActionError(null);
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

  const setTemplate = useMutation({
    mutationFn: ({
      drawing,
      isTemplate,
    }: {
      drawing: DrawingSummary;
      isTemplate: boolean;
    }) => api.setTemplate(drawing, isTemplate),
    onError: (error) => setActionError(error.message),
    onSuccess: (drawing) => {
      setActionError(null);
      queryClient.setQueryData<DrawingListResponse>(
        DASHBOARD_QUERY_KEY,
        (current) => replaceDrawing(current, drawing),
      );
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

  const setTags = useMutation({
    mutationFn: ({
      drawing,
      tags,
    }: {
      drawing: DrawingSummary;
      tags: string[];
    }) => api.setTags(drawing, tags),
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
      // A previously viewed trash list is now stale; TrashPage does the
      // symmetric invalidation when restoring.
      void queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY });
    },
  });

  const pending =
    createDrawing.isPending ||
    duplicateDrawing.isPending ||
    renameDrawing.isPending ||
    setTags.isPending ||
    setTemplate.isPending ||
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
      globalThis.confirm(
        `Move “${drawing.title}” to the trash? Trashed drawings are deleted forever after 7 days.`,
      )
    ) {
      deleteDrawing.mutate(drawing);
    }
  };

  const templates = dashboard.data
    ? [...dashboard.data.owned, ...dashboard.data.shared].filter(
        (drawing) => drawing.isTemplate,
      )
    : [];

  const submitFromTemplate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const template =
      templates.find((drawing) => drawing.id === templateId) ?? templates[0];
    if (template) {
      duplicateDrawing.mutate(template);
    }
  };

  const allTags = dashboard.data
    ? [
        ...new Set(
          [...dashboard.data.owned, ...dashboard.data.shared].flatMap(
            (drawing) => drawing.tags,
          ),
        ),
      ].sort()
    : [];
  // A filter can outlive its tag (e.g. the last tagged drawing was untagged).
  const activeTag = tagFilter && allTags.includes(tagFilter) ? tagFilter : null;
  const byTag = (drawings: DrawingSummary[]) =>
    activeTag
      ? drawings.filter((drawing) => drawing.tags.includes(activeTag))
      : drawings;

  return (
    <main className="dashboard-page">
      <header className="dashboard-header">
        <div>
          <p className="dashboard-eyebrow">Open Excalidraw</p>
          <h1>Your drawings</h1>
          <Link to="/app/settings">Settings</Link>
          {" · "}
          <Link to="/app/trash">Trash</Link>
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
        {templates.length > 0 ? (
          <form className="create-drawing" onSubmit={submitFromTemplate}>
            <label>
              New from template
              <select
                onChange={(event) => setTemplateId(event.target.value)}
                value={
                  templates.some((drawing) => drawing.id === templateId)
                    ? templateId
                    : (templates[0]?.id ?? "")
                }
              >
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.title}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={pending || !online} type="submit">
              Create from template
            </button>
          </form>
        ) : null}
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
        <>
          {allTags.length > 0 ? (
            <nav aria-label="Filter by tag" className="tag-filter-bar">
              {/* ponytail: single-select filter; multi-select if anyone asks */}
              <button
                aria-pressed={activeTag === null}
                className="tag-chip"
                onClick={() => setTagFilter(null)}
                type="button"
              >
                All
              </button>
              {allTags.map((tag) => (
                <button
                  aria-pressed={activeTag === tag}
                  className="tag-chip"
                  key={tag}
                  onClick={() =>
                    setTagFilter((current) => (current === tag ? null : tag))
                  }
                  type="button"
                >
                  {tag}
                </button>
              ))}
            </nav>
          ) : null}
          <div className="dashboard-sections">
            <DrawingSection
              drawings={byTag(dashboard.data.owned)}
              emptyMessage={
                activeTag
                  ? `No owned drawings tagged “${activeTag}”.`
                  : "Create your first drawing to get started."
              }
              onDelete={requestDelete}
              onDuplicate={(drawing) => duplicateDrawing.mutate(drawing)}
              onEditTags={(drawing, tags) => setTags.mutate({ drawing, tags })}
              onOpen={(drawing) =>
                (onOpenDrawing ?? ((next) => navigate(`/drawings/${next.id}`)))(
                  drawing,
                )
              }
              onRename={(drawing, title) =>
                renameDrawing.mutate({ drawing, title })
              }
              onSetTemplate={(drawing, isTemplate) =>
                setTemplate.mutate({ drawing, isTemplate })
              }
              offline={!online}
              pending={pending}
              title="Owned"
            />
            <DrawingSection
              drawings={byTag(dashboard.data.shared)}
              emptyMessage={
                activeTag
                  ? `No shared drawings tagged “${activeTag}”.`
                  : "Drawings shared with you will appear here."
              }
              onDelete={requestDelete}
              onDuplicate={(drawing) => duplicateDrawing.mutate(drawing)}
              onEditTags={(drawing, tags) => setTags.mutate({ drawing, tags })}
              onOpen={(drawing) =>
                (onOpenDrawing ?? ((next) => navigate(`/drawings/${next.id}`)))(
                  drawing,
                )
              }
              onRename={(drawing, title) =>
                renameDrawing.mutate({ drawing, title })
              }
              onSetTemplate={(drawing, isTemplate) =>
                setTemplate.mutate({ drawing, isTemplate })
              }
              offline={!online}
              pending={pending}
              title="Shared"
            />
          </div>
        </>
      )}
    </main>
  );
};
