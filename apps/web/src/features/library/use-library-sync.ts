import type {
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useRef } from "react";

import { LibraryRequestError, type LibraryClient } from "./library-client";

type LibrarySource = Pick<LibraryClient, "load" | "save">;
export type LibraryChangeHandler = NonNullable<
  ExcalidrawProps["onLibraryChange"]
>;
type LibraryItems = Parameters<LibraryChangeHandler>[0];

const DEBOUNCE_MS = 2_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export interface UseLibrarySyncOptions {
  client: LibrarySource;
  debounceMs?: number;
}

/**
 * Loads the account library into the editor once the canvas API exists, then
 * persists in-editor changes. Library events are ignored until that initial
 * load has been applied so the empty local library never overwrites the server.
 * Saves are serialized: only one PUT is in flight at a time, so overlapping
 * requests cannot land out of order and strand the server on a stale library.
 */
export const useLibrarySync = (
  api: ExcalidrawImperativeAPI | null,
  { client, debounceMs = DEBOUNCE_MS }: UseLibrarySyncOptions,
): LibraryChangeHandler => {
  const loadedRef = useRef(false);
  const lastSyncedRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const pendingRef = useRef<LibraryItems | null>(null);
  const retryRef = useRef(0);

  const flush = useCallback(() => {
    // Re-arms the shared timer to resend a failed snapshot after an
    // exponential backoff, so a transient blip persists without a fresh edit.
    function scheduleRetry() {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      const delay = Math.min(
        RETRY_BASE_MS * 2 ** retryRef.current,
        RETRY_MAX_MS,
      );
      retryRef.current += 1;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        drain();
      }, delay);
    }

    // Drains the latest pending snapshot, then re-drains once the request
    // settles so a save queued while this one was in flight is not stranded.
    function drain() {
      if (savingRef.current || pendingRef.current === null) {
        return;
      }
      const items = pendingRef.current;
      pendingRef.current = null;
      const serialized = JSON.stringify(items);
      savingRef.current = true;
      void client
        .save(items)
        .then(() => {
          lastSyncedRef.current = serialized;
          retryRef.current = 0;
        })
        .catch((error: unknown) => {
          // A 4xx is a permanent client error (e.g. over the item limit) that
          // would retry forever, so warn and drop it. Anything else (offline,
          // 5xx) is transient: re-queue unless a newer snapshot already won,
          // then retry with backoff.
          if (
            error instanceof LibraryRequestError &&
            error.status >= 400 &&
            error.status < 500
          ) {
            console.warn("Could not save your library.", error);
            return;
          }
          if (pendingRef.current === null) {
            pendingRef.current = items;
          }
          scheduleRetry();
        })
        .finally(() => {
          savingRef.current = false;
          // A retry (or a newer change's debounce) already owns the next drain.
          if (timerRef.current === null) {
            drain();
          }
        });
    }
    drain();
  }, [client]);

  useEffect(() => {
    if (!api) {
      return;
    }
    let active = true;
    loadedRef.current = false;
    void client
      .load()
      .then((library) => {
        if (!active) {
          return;
        }
        lastSyncedRef.current = JSON.stringify(library.items);
        loadedRef.current = true;
        // Merge (not replace) when the server has nothing yet, so a pre-existing
        // local library survives the load and migrates up on the next save.
        return api.updateLibrary({
          libraryItems: library.items as unknown as LibraryItems,
          merge: library.items.length === 0,
        });
      })
      .catch((error: unknown) => {
        console.warn("Could not load your saved library.", error);
      });

    return () => {
      active = false;
      loadedRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // Send a snapshot still waiting out its debounce before this editor
      // session tears down, so an edit is not lost when switching drawings.
      if (pendingRef.current !== null) {
        flush();
      }
    };
  }, [api, client, flush]);

  return useCallback<LibraryChangeHandler>(
    (items) => {
      if (!loadedRef.current) {
        return;
      }
      if (JSON.stringify(items) === lastSyncedRef.current) {
        return;
      }
      pendingRef.current = items;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flush();
      }, debounceMs);
    },
    [debounceMs, flush],
  );
};
