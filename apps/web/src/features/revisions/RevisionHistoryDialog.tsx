import { useCallback, useEffect, useState } from "react";

import {
  RevisionClient,
  type RestoreResponse,
  type RevisionEntry,
  type RevisionSource,
} from "./api";

export interface RevisionHistoryDialogProps {
  canRestore: boolean;
  client?: RevisionSource;
  drawingId: string;
  onClose: () => void;
  onRestore?: (
    revision: string,
    client: RevisionSource,
  ) => Promise<RestoreResponse>;
  onRestored?: (result: RestoreResponse) => void;
  open: boolean;
}

const defaultClient = new RevisionClient();

export const RevisionHistoryDialog = ({
  canRestore,
  client = defaultClient,
  drawingId,
  onClose,
  onRestore,
  onRestored,
  open,
}: RevisionHistoryDialogProps) => {
  const [revisions, setRevisions] = useState<RevisionEntry[]>([]);
  const [confirming, setConfirming] = useState<RevisionEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await client.list(drawingId);
      setError(null);
      setRevisions(result.revisions);
    } catch (caught) {
      setError(message(caught, "Could not load revision history."));
    }
  }, [client, drawingId]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    queueMicrotask(() => {
      if (active) void load();
    });
    return () => {
      active = false;
    };
  }, [load, open]);

  if (!open) return null;

  const restore = async () => {
    if (!confirming) return;
    setBusy(true);
    setError(null);
    try {
      const result = onRestore
        ? await onRestore(confirming.revision, client)
        : await client.restore(drawingId, confirming.revision);
      setConfirming(null);
      onRestored?.(result);
    } catch (caught) {
      setError(message(caught, "Could not restore this revision."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="workspace-modal-backdrop">
      <section
        aria-labelledby="revision-dialog-title"
        aria-modal="true"
        className="workspace-modal"
        role="dialog"
      >
        <header>
          <div>
            <h2 id="revision-dialog-title">Revision history</h2>
            <p>Recent server checkpoints for this drawing.</p>
          </div>
          <button
            aria-label="Close revision history"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </header>

        {error ? <p role="alert">{error}</p> : null}
        {revisions.length === 0 && !error ? (
          <p aria-live="polite">No revision checkpoints yet.</p>
        ) : null}
        <ol className="revision-list">
          {revisions.map((revision) => (
            <li key={`${revision.revision}:${revision.createdAt}`}>
              <span>
                <strong>Revision {revision.revision}</strong>
                <small>
                  {revision.reason === "restore" ? "Restored" : "Checkpoint"} ·{" "}
                  {formatTimestamp(revision.createdAt)}
                </small>
              </span>
              {canRestore ? (
                <button
                  disabled={busy}
                  onClick={() => setConfirming(revision)}
                  type="button"
                >
                  Restore
                </button>
              ) : null}
            </li>
          ))}
        </ol>

        {confirming ? (
          <section
            aria-label="Confirm revision restore"
            className="revision-confirm"
          >
            <p>
              Restore revision {confirming.revision}? The current drawing
              remains in history as a newer revision.
            </p>
            <div>
              <button
                disabled={busy}
                onClick={() => setConfirming(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                disabled={busy}
                onClick={() => void restore()}
                type="button"
              >
                {busy ? "Restoring…" : "Restore revision"}
              </button>
            </div>
          </section>
        ) : null}
      </section>
    </div>
  );
};

const formatTimestamp = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

const message = (caught: unknown, fallback: string) =>
  caught instanceof Error ? caught.message : fallback;
