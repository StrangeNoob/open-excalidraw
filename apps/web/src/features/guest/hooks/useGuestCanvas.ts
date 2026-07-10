import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ExcalidrawChangeHandler } from "../../editor";
import {
  DEFAULT_GUEST_DRAWING_ID,
  DEFAULT_GUEST_DRAWING_TITLE,
  type GuestSceneSnapshot,
} from "../model";
import { GuestRepository } from "../storage";

export interface GuestCanvasRepository {
  loadInitialData(
    drawingId: string,
  ): Promise<ExcalidrawInitialDataState | null>;
  saveSnapshot: GuestRepository["saveSnapshot"];
}

export type GuestSaveStatus =
  "error" | "loading" | "ready" | "saved" | "saving";

export interface UseGuestCanvasOptions {
  drawingId?: string;
  repository?: GuestCanvasRepository;
  saveDelayMs?: number;
  title?: string;
}

interface PendingSnapshot {
  files: Parameters<ExcalidrawChangeHandler>[2];
  scene: GuestSceneSnapshot;
  sequence: number;
}

const defaultGuestRepository = new GuestRepository();

const projectGuestAppState = (
  appState: Parameters<ExcalidrawChangeHandler>[1],
): GuestSceneSnapshot["appState"] => ({
  gridModeEnabled: appState.gridModeEnabled,
  gridSize: appState.gridSize,
  gridStep: appState.gridStep,
  name: appState.name,
  theme: appState.theme,
  viewBackgroundColor: appState.viewBackgroundColor,
});

export const useGuestCanvas = ({
  drawingId = DEFAULT_GUEST_DRAWING_ID,
  repository = defaultGuestRepository,
  saveDelayMs = 300,
  title = DEFAULT_GUEST_DRAWING_TITLE,
}: UseGuestCanvasOptions = {}) => {
  const [initialData, setInitialData] =
    useState<ExcalidrawInitialDataState | null>(null);
  const [status, setStatus] = useState<GuestSaveStatus>("loading");
  const [error, setError] = useState<Error | null>(null);
  const [initialLoadFailed, setInitialLoadFailed] = useState(false);
  const pendingSnapshot = useRef<PendingSnapshot | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChain = useRef(Promise.resolve());
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const latestSnapshotSequence = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;

    void repository
      .loadInitialData(drawingId)
      .then((loaded) => {
        if (!cancelled) {
          setInitialData(loaded);
          setInitialLoadFailed(false);
          setStatus("ready");
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(
            caught instanceof Error
              ? caught
              : new Error("Could not load the local drawing."),
          );
          setInitialLoadFailed(true);
          setStatus("error");
        }
      });

    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [drawingId, repository]);

  const flush = useCallback((): Promise<void> => {
    const snapshot = pendingSnapshot.current;

    if (!snapshot) {
      return saveChain.current;
    }

    pendingSnapshot.current = null;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }

    if (mounted.current) {
      setStatus("saving");
      setError(null);
    }

    const nextSave = saveChain.current.then(async () => {
      await repository.saveSnapshot({
        drawingId,
        files: snapshot.files,
        scene: snapshot.scene,
        title,
      });
    });
    saveChain.current = nextSave.catch(() => undefined);

    return nextSave
      .then(() => {
        if (mounted.current) {
          setStatus("saved");
        }
      })
      .catch((caught: unknown) => {
        if (
          latestSnapshotSequence.current === snapshot.sequence &&
          pendingSnapshot.current === null
        ) {
          pendingSnapshot.current = snapshot;

          if (mounted.current && saveTimer.current === null) {
            saveTimer.current = setTimeout(() => {
              saveTimer.current = null;
              void flushRef.current();
            }, saveDelayMs);
          }
        }

        if (mounted.current) {
          setError(
            caught instanceof Error
              ? caught
              : new Error("Could not save the local drawing."),
          );
          setStatus("error");
        }
      });
  }, [drawingId, repository, saveDelayMs, title]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const onChange = useCallback<ExcalidrawChangeHandler>(
    (elements, appState, files) => {
      latestSnapshotSequence.current += 1;
      pendingSnapshot.current = {
        files: { ...files },
        scene: {
          appState: projectGuestAppState(appState),
          elements: [...elements],
        },
        sequence: latestSnapshotSequence.current,
      };

      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }

      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        void flush();
      }, saveDelayMs);
    },
    [flush, saveDelayMs],
  );

  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }

      void flush();
    },
    [flush],
  );

  return {
    error,
    flush,
    initialData,
    initialLoadFailed,
    onChange,
    status,
  };
};
