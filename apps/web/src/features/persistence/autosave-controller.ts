import type { SaveContentRequest } from "@open-excalidraw/contracts";

import { sceneFingerprint } from "./scene-projection";
import {
  ContentRequestError,
  VersionConflictError,
  type LoadedContent,
} from "./content-client";

export type AutosaveStatus =
  "idle" | "dirty" | "saving" | "saved" | "retrying" | "conflict" | "error";

export interface AutosaveSnapshot {
  request: SaveContentRequest;
  /** Uploads represented here must finish before persist commits the scene. */
  files?: unknown;
}

export interface AutosaveState {
  conflict: { local: AutosaveSnapshot; server: LoadedContent | null } | null;
  error: Error | null;
  revision: string;
  status: AutosaveStatus;
}

export interface AutosaveControllerOptions {
  initialRevision: string;
  persist: (
    snapshot: AutosaveSnapshot,
    revision: string,
    idempotencyKey: string,
  ) => Promise<{ revision: string }>;
  writeRecovery?: (
    snapshot: AutosaveSnapshot,
    revision: string,
  ) => Promise<void>;
  debounceMs?: number;
  maxWaitMs?: number;
  retryBaseMs?: number;
  createIdempotencyKey?: () => string;
}

interface SaveJob {
  fingerprint: string;
  idempotencyKey: string;
  snapshot: AutosaveSnapshot;
}

export class AutosaveController {
  readonly #persist: AutosaveControllerOptions["persist"];
  readonly #writeRecovery?: AutosaveControllerOptions["writeRecovery"];
  readonly #debounceMs: number;
  readonly #maxWaitMs: number;
  readonly #retryBaseMs: number;
  readonly #createIdempotencyKey: () => string;
  readonly #listeners = new Set<(state: AutosaveState) => void>();
  #state: AutosaveState;
  #pending: AutosaveSnapshot | null = null;
  #pendingFingerprint: string | null = null;
  #retryJob: SaveJob | null = null;
  #terminalFingerprint: string | null = null;
  #acknowledgedFingerprint: string | null = null;
  #firstDirtyAt: number | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inFlight: Promise<void> | null = null;
  #retryCount = 0;
  #disposed = false;

  constructor(options: AutosaveControllerOptions) {
    this.#persist = options.persist;
    this.#writeRecovery = options.writeRecovery;
    this.#debounceMs = options.debounceMs ?? 1_000;
    this.#maxWaitMs = options.maxWaitMs ?? 5_000;
    this.#retryBaseMs = options.retryBaseMs ?? 1_000;
    this.#createIdempotencyKey =
      options.createIdempotencyKey ?? (() => crypto.randomUUID());
    this.#state = {
      conflict: null,
      error: null,
      revision: options.initialRevision,
      status: "idle",
    };
  }

  get state(): AutosaveState {
    return this.#state;
  }

  subscribe(listener: (state: AutosaveState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  schedule(snapshot: AutosaveSnapshot): void {
    if (this.#disposed || this.#state.status === "conflict") {
      return;
    }
    const fingerprint = sceneFingerprint(snapshot.request);
    if (fingerprint === this.#acknowledgedFingerprint && !this.#inFlight) {
      return;
    }

    void this.#writeRecovery?.(snapshot, this.#state.revision).catch(
      () => undefined,
    );
    if (
      this.#state.status === "error" &&
      fingerprint === this.#terminalFingerprint
    ) {
      return;
    }

    this.#terminalFingerprint = null;
    this.#pending = snapshot;
    this.#pendingFingerprint = fingerprint;
    this.#firstDirtyAt ??= Date.now();
    this.#setState({ error: null, status: "dirty" });
    if (this.#retryJob) {
      this.#setState({ status: "retrying" });
      return;
    }
    this.#scheduleTimer();
  }

  flush(): Promise<void> {
    if (this.#disposed || this.#state.status === "conflict") {
      return Promise.resolve();
    }
    if (this.#inFlight) {
      return this.#inFlight;
    }
    if ((!this.#pending || !this.#pendingFingerprint) && !this.#retryJob) {
      return Promise.resolve();
    }

    this.#clearTimer();
    const job = this.#retryJob ?? {
      fingerprint: this.#pendingFingerprint as string,
      idempotencyKey: this.#createIdempotencyKey(),
      snapshot: this.#pending as AutosaveSnapshot,
    };
    const wasRetry = this.#retryJob !== null;
    this.#retryJob = null;
    if (!wasRetry) {
      this.#pending = null;
      this.#pendingFingerprint = null;
    }
    this.#firstDirtyAt = null;
    const revision = this.#state.revision;
    this.#setState({ error: null, status: "saving" });

    const run = this.#persist(job.snapshot, revision, job.idempotencyKey)
      .then((saved) => {
        this.#retryCount = 0;
        this.#acknowledgedFingerprint = job.fingerprint;
        if (this.#pendingFingerprint === job.fingerprint) {
          this.#pending = null;
          this.#pendingFingerprint = null;
        }
        this.#setState({ revision: saved.revision, status: "saved" });
      })
      .catch((caught: unknown) => {
        const error =
          caught instanceof Error ? caught : new Error("Autosave failed");
        if (error instanceof VersionConflictError) {
          const local = this.#pending ?? job.snapshot;
          this.#pending = local;
          this.#pendingFingerprint = sceneFingerprint(local.request);
          this.#retryJob = null;
          this.#setState({
            conflict: { local, server: error.server },
            error,
            status: "conflict",
          });
          return;
        }

        if (!isRetryableAutosaveError(error)) {
          const local = this.#pending ?? job.snapshot;
          const localFingerprint = sceneFingerprint(local.request);
          this.#pending = local;
          this.#pendingFingerprint = localFingerprint;
          this.#retryJob = null;
          this.#retryCount = 0;
          this.#terminalFingerprint =
            localFingerprint === job.fingerprint ? localFingerprint : null;
          this.#setState({
            error,
            status: this.#terminalFingerprint ? "error" : "dirty",
          });
          return;
        }

        // Retry the identical operation first. If the response was lost after
        // commit, the server can replay this key and reveal the new revision.
        this.#retryJob = job;
        this.#retryCount += 1;
        this.#setState({ error, status: "retrying" });
        this.#timer = setTimeout(
          () => {
            this.#timer = null;
            void this.flush();
          },
          Math.min(this.#retryBaseMs * 2 ** (this.#retryCount - 1), 30_000),
        );
      })
      .finally(() => {
        this.#inFlight = null;
        if (
          (this.#retryJob || this.#pending) &&
          this.#state.status !== "conflict" &&
          this.#state.status !== "error" &&
          !this.#timer
        ) {
          this.#firstDirtyAt ??= Date.now();
          this.#setState({ status: "dirty" });
          this.#scheduleTimer();
        }
      });

    this.#inFlight = run;
    return run;
  }

  /** Accept canonical server state and discard the conflicting local pending save. */
  acceptServer(server: LoadedContent): void {
    this.#pending = null;
    this.#pendingFingerprint = null;
    this.#retryJob = null;
    this.#terminalFingerprint = null;
    this.#acknowledgedFingerprint = sceneFingerprint({
      assetIds: server.content.assetIds,
      scene: server.content.scene,
    });
    this.#retryCount = 0;
    this.#setState({
      conflict: null,
      error: null,
      revision: server.revision,
      status: "saved",
    });
  }

  /** Refresh a conflict whose initial canonical follow-up load failed. */
  async reloadConflictServer(
    load: () => Promise<LoadedContent>,
  ): Promise<LoadedContent> {
    if (!this.#state.conflict) {
      throw new Error("There is no save conflict to reload");
    }
    const server = await load();
    if (!this.#state.conflict) {
      return server;
    }
    this.#setState({
      conflict: { ...this.#state.conflict, server },
      error: null,
    });
    return server;
  }

  /** Resume a deliberate recovery save against the latest known revision. */
  retryLocalAgainst(revision: string): void {
    if (!this.#state.conflict) {
      return;
    }
    this.#pending = this.#state.conflict.local;
    this.#pendingFingerprint = sceneFingerprint(this.#pending.request);
    this.#retryJob = null;
    this.#terminalFingerprint = null;
    this.#firstDirtyAt = Date.now();
    this.#setState({ conflict: null, error: null, revision, status: "dirty" });
    void this.flush();
  }

  /**
   * Explicitly retries the exact snapshot paused by a terminal failure. This
   * never enables automatic retries: another terminal response pauses again.
   */
  retryTerminal(): Promise<void> {
    if (
      this.#state.status !== "error" ||
      !this.#pending ||
      !this.#pendingFingerprint ||
      this.#pendingFingerprint !== this.#terminalFingerprint
    ) {
      return Promise.resolve();
    }
    this.#terminalFingerprint = null;
    this.#firstDirtyAt = Date.now();
    this.#setState({ error: null, status: "dirty" });
    return this.flush();
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearTimer();
    this.#listeners.clear();
  }

  #scheduleTimer() {
    this.#clearTimer();
    const elapsed = this.#firstDirtyAt ? Date.now() - this.#firstDirtyAt : 0;
    const delay = Math.max(
      0,
      Math.min(this.#debounceMs, this.#maxWaitMs - elapsed),
    );
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, delay);
  }

  #clearTimer() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #setState(patch: Partial<AutosaveState>) {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) {
      listener(this.#state);
    }
  }
}

export const isRetryableAutosaveError = (error: Error): boolean => {
  if (error instanceof TypeError) {
    return true;
  }
  const candidate: unknown = error;
  const status =
    error instanceof ContentRequestError
      ? error.status
      : typeof candidate === "object" &&
          candidate !== null &&
          "status" in candidate &&
          typeof candidate.status === "number"
        ? candidate.status
        : null;
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
};
