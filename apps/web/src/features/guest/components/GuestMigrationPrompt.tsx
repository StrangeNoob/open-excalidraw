import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type {
  GuestMigrationCandidate,
  GuestMigrationService,
} from "../services";

export interface GuestMigrationPromptProps {
  drawingId: string;
  onMigrated: (cloudDrawingId: string) => void;
  service: Pick<GuestMigrationService, "inspect" | "migrate">;
  userId: string;
}

export const GuestMigrationPrompt = ({
  drawingId,
  onMigrated,
  service,
  userId,
}: GuestMigrationPromptProps) => {
  const [candidate, setCandidate] = useState<GuestMigrationCandidate | null>(
    null,
  );
  const [status, setStatus] = useState<
    "loading" | "ready" | "saving" | "error"
  >("loading");
  const [error, setError] = useState<Error | null>(null);
  const [inspectionAttempt, setInspectionAttempt] = useState(0);
  const [inspectedScope, setInspectedScope] = useState<string | null>(null);
  const scope = `${userId}\u0000${drawingId}`;
  const activeUserIdRef = useRef(userId);
  const activeScopeRef = useRef(scope);
  const mountedRef = useRef(false);
  const migrationAbortRef = useRef<AbortController | null>(null);
  const scopeGenerationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      migrationAbortRef.current?.abort();
    };
  }, []);

  useLayoutEffect(() => {
    activeUserIdRef.current = userId;
    activeScopeRef.current = scope;
    scopeGenerationRef.current += 1;
    migrationAbortRef.current?.abort();
    migrationAbortRef.current = null;
    return () => migrationAbortRef.current?.abort();
  }, [scope, userId]);

  useEffect(() => {
    let active = true;
    void service
      .inspect(userId, drawingId)
      .then((next) => {
        if (active) {
          setCandidate(next);
          setInspectedScope(scope);
          setStatus("ready");
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setCandidate(null);
          setError(
            caught instanceof Error
              ? caught
              : new Error("Could not inspect local drawing"),
          );
          setInspectedScope(scope);
          setStatus("error");
        }
      });
    return () => {
      active = false;
    };
  }, [drawingId, inspectionAttempt, scope, service, userId]);

  if (status === "loading" || inspectedScope !== scope) {
    return null;
  }

  if (status === "error" && !candidate) {
    return (
      <section
        aria-label="Local drawing inspection failed"
        className="migration-prompt"
        role="alert"
      >
        <strong>Could not check your local drawing.</strong>
        <p>{error?.message}</p>
        <button
          onClick={() => {
            setError(null);
            setStatus("loading");
            setInspectionAttempt((attempt) => attempt + 1);
          }}
          type="button"
        >
          Try again
        </button>
      </section>
    );
  }

  if (!candidate || candidate.alreadyMigrated) {
    return null;
  }

  const migrate = async () => {
    const generation = scopeGenerationRef.current;
    const expectedScope = scope;
    const abort = new AbortController();
    migrationAbortRef.current?.abort();
    migrationAbortRef.current = abort;
    setError(null);
    setStatus("saving");
    try {
      const marker = await service.migrate(userId, drawingId, {
        getActiveUserId: () => activeUserIdRef.current,
        signal: abort.signal,
      });
      if (
        mountedRef.current &&
        !abort.signal.aborted &&
        scopeGenerationRef.current === generation &&
        activeScopeRef.current === expectedScope &&
        activeUserIdRef.current === userId
      ) {
        onMigrated(marker.targetCloudDrawingId);
      }
    } catch (caught) {
      if (
        mountedRef.current &&
        !abort.signal.aborted &&
        scopeGenerationRef.current === generation &&
        activeScopeRef.current === expectedScope &&
        activeUserIdRef.current === userId
      ) {
        setError(
          caught instanceof Error ? caught : new Error("Migration failed"),
        );
        setStatus("error");
      }
    } finally {
      if (migrationAbortRef.current === abort) {
        migrationAbortRef.current = null;
      }
    }
  };

  return (
    <section
      aria-label="Save local drawing"
      className="migration-prompt"
      role="dialog"
    >
      <strong>Save “{candidate.title}” to your account?</strong>
      <p>The local copy stays on this device until the cloud save finishes.</p>
      {error ? <p role="alert">{error.message}</p> : null}
      <button
        disabled={status === "saving"}
        onClick={() => void migrate()}
        type="button"
      >
        {status === "saving" ? "Saving…" : "Save to my account"}
      </button>
    </section>
  );
};
