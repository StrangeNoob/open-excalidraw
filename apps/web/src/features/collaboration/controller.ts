import { CaptureUpdateAction, restoreElements } from "@excalidraw/excalidraw";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type {
  ClientRealtimeEvent,
  ExcalidrawElementDTO,
  Role,
  ServerRealtimeEvent,
} from "@open-excalidraw/contracts";

import type { CloudOutboxRecord } from "../connectivity/storage/cloudOutboxDb";
import { createCollaboratorMap, updateCollaboratorPresence } from "./presence";
import { changedAfterRebase, reconcileClientElements } from "./reconcile";
import type {
  CollaborationState,
  PresenceBroadcast,
  RealtimeProblem,
  RealtimeTransport,
  RealtimeTransportHandlers,
  RoomReadyEvent,
} from "./types";
import { ElementVersionFilter } from "./version-filter";

type SceneMutateEvent = Extract<ClientRealtimeEvent, { type: "scene.mutate" }>;
type SharedSceneState = NonNullable<SceneMutateEvent["sharedSceneState"]>;

export interface CollaborationOutbox {
  list(userId: string, drawingId: string): Promise<CloudOutboxRecord[]>;
  put(record: CloudOutboxRecord): Promise<void>;
  remove(userId: string, drawingId: string, mutationId: string): Promise<void>;
}

export interface CollaborationControllerOptions {
  clientInstanceId?: string;
  createId?: () => string;
  drawingId: string;
  durableDebounceMs?: number;
  durableMaxWaitMs?: number;
  editor: Pick<
    ExcalidrawImperativeAPI,
    "getAppState" | "getSceneElementsIncludingDeleted" | "updateScene"
  >;
  fullResyncMs?: number;
  initialAppState?: Record<string, unknown>;
  initialElements?: readonly ExcalidrawElementDTO[];
  initialRole?: Role;
  now?: () => number;
  outbox: CollaborationOutbox;
  presenceHeartbeatMs?: number;
  previewThrottleMs?: number;
  transport: RealtimeTransport;
  uploadAssets?: (
    drawingId: string,
    files: BinaryFiles,
    fileIds: readonly string[],
  ) => Promise<unknown>;
  userId: string;
}

const INITIAL_STATE: CollaborationState = {
  collaborators: new Map(),
  error: null,
  revision: "0",
  role: null,
  status: "idle",
};

export class CollaborationController {
  readonly #drawingId: string;
  readonly #userId: string;
  readonly #clientInstanceId: string;
  readonly #createId: () => string;
  readonly #editor: CollaborationControllerOptions["editor"];
  readonly #outbox: CollaborationOutbox;
  readonly #transport: RealtimeTransport;
  readonly #uploadAssets?: CollaborationControllerOptions["uploadAssets"];
  readonly #now: () => number;
  readonly #previewThrottleMs: number;
  readonly #durableDebounceMs: number;
  readonly #durableMaxWaitMs: number;
  readonly #fullResyncMs: number;
  readonly #presenceHeartbeatMs: number;
  readonly #versions = new ElementVersionFilter();
  readonly #listeners = new Set<(state: CollaborationState) => void>();
  readonly #dirty = new Map<string, ExcalidrawElementDTO>();
  readonly #preview = new Map<string, ExcalidrawElementDTO>();
  readonly #remotePreviews = new Map<string, ExcalidrawElementDTO>();
  #canonicalElements: ExcalidrawElementDTO[] = [];
  #canonicalSharedSceneState: SharedSceneState = {};
  #dirtySharedSceneState: SharedSceneState | null = null;
  #observedSharedSceneState = "{}";
  #latestFiles: BinaryFiles = {};
  #lastPresence: Extract<ClientRealtimeEvent, { type: "presence.update" }> = {
    idleState: "active",
    type: "presence.update",
  };
  #state: CollaborationState = INITIAL_STATE;
  #generation = 0;
  #lastPreviewAt: number | null = null;
  #durableFirstDirtyAt: number | null = null;
  #previewTimer: ReturnType<typeof setTimeout> | null = null;
  #durableTimer: ReturnType<typeof setTimeout> | null = null;
  #fullResyncTimer: ReturnType<typeof setInterval> | null = null;
  #presenceHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #eventChain = Promise.resolve();
  #started = false;
  #disposed = false;

  constructor(options: CollaborationControllerOptions) {
    this.#drawingId = options.drawingId;
    this.#userId = options.userId;
    this.#clientInstanceId = options.clientInstanceId ?? crypto.randomUUID();
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#editor = options.editor;
    this.#outbox = options.outbox;
    this.#transport = options.transport;
    this.#uploadAssets = options.uploadAssets;
    this.#now = options.now ?? (() => Date.now());
    this.#previewThrottleMs = options.previewThrottleMs ?? 100;
    this.#durableDebounceMs = options.durableDebounceMs ?? 1_000;
    this.#durableMaxWaitMs = options.durableMaxWaitMs ?? 5_000;
    this.#fullResyncMs = options.fullResyncMs ?? 20_000;
    this.#presenceHeartbeatMs = options.presenceHeartbeatMs ?? 15_000;
    this.#canonicalElements = [...(options.initialElements ?? [])];
    this.#canonicalSharedSceneState = normalizeSharedSceneState(
      options.initialAppState,
    );
    this.#observedSharedSceneState = stableSharedSceneState(
      this.#canonicalSharedSceneState,
    );
    this.#versions.seed(this.#canonicalElements);
    this.#state = { ...INITIAL_STATE, role: options.initialRole ?? null };
  }

  get state(): CollaborationState {
    return this.#state;
  }

  subscribe(listener: (state: CollaborationState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#disposed = false;
    this.#transport.setHandlers(this.#handlers());
    this.#setState({ error: null, status: "connecting" });
    this.#fullResyncTimer = setInterval(() => {
      void this.#flushDurable(true);
    }, this.#fullResyncMs);
    this.#presenceHeartbeatTimer = setInterval(() => {
      if (this.#state.status === "ready") {
        this.#transport.emit(this.#lastPresence);
      }
    }, this.#presenceHeartbeatMs);
    this.#transport.connect();
  }

  async stop(): Promise<void> {
    if (!this.#started) {
      return;
    }
    let flushError: unknown;
    try {
      await this.#flushDurable(false, false, true);
    } catch (caught) {
      flushError = caught;
    } finally {
      this.#disposed = true;
      this.#started = false;
      this.#clearTimers();
      this.#transport.setHandlers(null);
      this.#transport.disconnect();
      this.#setState({ status: "disconnected" });
    }
    if (flushError) {
      throw flushError instanceof Error
        ? flushError
        : new Error("Could not persist collaboration changes before closing");
    }
  }

  onChange(
    elements: readonly ExcalidrawElementDTO[],
    appState?: AppState,
    files?: BinaryFiles,
  ): void {
    if (!this.#canEdit()) return;
    if (files) this.#latestFiles = { ...files };
    const changed = this.#versions.takeLocalChanges(elements);
    const nextSharedSceneState = appState
      ? sharedSceneState(appState)
      : this.#canonicalSharedSceneState;
    const nextSharedFingerprint = stableSharedSceneState(nextSharedSceneState);
    const sharedChanged =
      nextSharedFingerprint !== this.#observedSharedSceneState;
    if (sharedChanged) {
      this.#observedSharedSceneState = nextSharedFingerprint;
      this.#dirtySharedSceneState = nextSharedSceneState;
    }
    if (changed.length === 0 && !sharedChanged) return;
    for (const element of changed) {
      this.#dirty.set(element.id, element);
      this.#preview.set(element.id, element);
    }
    if (changed.length > 0) this.#emitOrSchedulePreview();
    this.#scheduleDurable();
  }

  publishPresence(
    event: Omit<
      Extract<ClientRealtimeEvent, { type: "presence.update" }>,
      "type"
    >,
  ): void {
    if (this.#state.status !== "ready") return;
    this.#lastPresence = { type: "presence.update", ...event };
    this.#transport.emit(this.#lastPresence);
  }

  flush(): Promise<void> {
    return this.#flushDurable(false);
  }

  #handlers(): RealtimeTransportHandlers {
    return {
      onConnect: () => this.#enqueue(() => this.#join()),
      onDisconnect: () =>
        this.#enqueue(async () => {
          if (this.#disposed) return;
          this.#setState({ status: "reconnecting" });
          await this.#flushDurable(false, false, true);
          this.#remotePreviews.clear();
          await this.#applyCanonicalWithOwned();
        }),
      onError: (error) => this.#setState({ error, status: "error" }),
      onPresence: (event) => this.#receivePresence(event),
      onRoster: (collaborators) => this.#applyRoster(collaborators),
      onServerEvent: (event) =>
        this.#enqueue(() => this.#receiveServerEvent(event)),
    };
  }

  #enqueue(action: () => void | Promise<void>) {
    this.#eventChain = this.#eventChain
      .then(action)
      .catch((caught: unknown) => {
        this.#setState({
          error: toRealtimeProblem(caught),
          status: "error",
        });
      });
  }

  #join() {
    this.#setState({ error: null, status: "joining" });
    this.#transport.emit({
      clientInstanceId: this.#clientInstanceId,
      drawingId: this.#drawingId,
      lastRevision: this.#state.revision,
      protocolVersion: 1,
      type: "room.join",
    });
  }

  async #receiveServerEvent(event: ServerRealtimeEvent): Promise<void> {
    switch (event.type) {
      case "room.ready":
        await this.#ready(event);
        return;
      case "scene.preview":
        this.#replaceRemotePreviews(event.elements);
        await this.#applyPreviewScene();
        return;
      case "scene.committed":
        await this.#committed(event);
        return;
      case "scene.ack":
        await this.#ack(event.mutationId, event.revision);
        return;
      case "room.roleChanged":
        await this.#roleChanged(event.role);
        return;
      case "room.resyncRequired":
        this.#remotePreviews.clear();
        await this.#applyCanonicalWithOwned();
        this.#join();
        return;
      case "protocol.error": {
        const problem = {
          code: event.code,
          message: event.message,
          requestId: event.requestId,
          retryable: event.retryable,
        };
        this.#setState({
          error: problem,
          status: isEventLocalProblem(problem) ? this.#state.status : "error",
        });
        return;
      }
    }
  }

  async #ready(event: RoomReadyEvent) {
    this.#remotePreviews.clear();
    this.#canonicalElements = [...event.snapshot.elements];
    this.#canonicalSharedSceneState = normalizeSharedSceneState(
      event.snapshot.appState,
    );
    const pending = await this.#outbox.list(this.#userId, this.#drawingId);
    let merged = [...event.snapshot.elements];
    let mergedSharedSceneState = this.#canonicalSharedSceneState;
    const rebased: CloudOutboxRecord[] = [];
    for (const record of pending) {
      const changes = changedAfterRebase(merged, record.elements);
      const sharedChanged =
        record.sharedSceneState !== undefined &&
        stableSharedSceneState(record.sharedSceneState) !==
          stableSharedSceneState(mergedSharedSceneState);
      merged = reconcileClientElements(merged, record.elements);
      if (record.sharedSceneState) {
        mergedSharedSceneState = record.sharedSceneState;
      }
      if (changes.length === 0 && !sharedChanged) {
        await this.#outbox.remove(
          this.#userId,
          this.#drawingId,
          record.mutationId,
        );
        continue;
      }
      const next: CloudOutboxRecord = {
        ...record,
        baseRevision: event.revision,
        elements: changes,
      };
      if (!sharedChanged) delete next.sharedSceneState;
      await this.#outbox.put(next);
      rebased.push(next);
      this.#generation = Math.max(this.#generation, record.generation);
    }
    merged = reconcileClientElements(merged, [...this.#dirty.values()]);
    if (this.#dirtySharedSceneState) {
      mergedSharedSceneState = this.#dirtySharedSceneState;
    }

    const collaborators = createCollaboratorMap(event.collaborators);
    this.#applyRemote(merged, mergedSharedSceneState, collaborators);
    this.#setState({
      collaborators,
      error: null,
      revision: event.revision,
      role: event.role,
      status: "ready",
    });
    this.#transport.emit(this.#lastPresence);

    if (canWrite(event.role)) {
      for (const record of rebased) {
        await this.#uploadRecordAssets(record);
        this.#transport.emit(toMutationEvent(record));
      }
    }
  }

  async #committed(
    event: Extract<ServerRealtimeEvent, { type: "scene.committed" }>,
  ) {
    const comparison = compareRevision(event.revision, this.#state.revision);
    if (comparison > 1) {
      this.#join();
      return;
    }
    await this.#outbox.remove(this.#userId, this.#drawingId, event.mutationId);
    if (comparison <= 0) return;
    this.#remotePreviews.clear();
    this.#canonicalElements = reconcileClientElements(
      this.#canonicalElements,
      event.elements,
    );
    if (event.sharedSceneState) {
      this.#canonicalSharedSceneState = event.sharedSceneState;
    }
    this.#setState({ revision: event.revision });
    await this.#applyCanonicalWithOwned(event.sharedSceneState);
  }

  async #ack(mutationId: string, revision: string) {
    const comparison = compareRevision(revision, this.#state.revision);
    if (comparison > 1) {
      this.#join();
      return;
    }
    const pending = await this.#outbox.list(this.#userId, this.#drawingId);
    const acknowledged = pending.find(
      (record) => record.mutationId === mutationId,
    );
    if (acknowledged) {
      this.#canonicalElements = reconcileClientElements(
        this.#canonicalElements,
        acknowledged.elements,
      );
      if (acknowledged.sharedSceneState) {
        this.#canonicalSharedSceneState = acknowledged.sharedSceneState;
      }
    }
    await this.#outbox.remove(this.#userId, this.#drawingId, mutationId);
    if (comparison > 0) this.#setState({ revision });
  }

  async #roleChanged(role: Role) {
    if (
      !canWrite(role) &&
      (this.#dirty.size > 0 || this.#dirtySharedSceneState)
    ) {
      await this.#flushDurable(false, false, true);
    }
    this.#setState({ role });
    if (!canWrite(role)) {
      this.#clearWriteTimers();
      this.#preview.clear();
    }
  }

  #receivePresence(event: PresenceBroadcast) {
    const collaborators = updateCollaboratorPresence(
      this.#state.collaborators,
      event.connectionId,
      event.presence,
    );
    this.#applyCollaborators(collaborators);
  }

  #applyRoster(collaborators: RoomReadyEvent["collaborators"]) {
    const roster = createCollaboratorMap(collaborators);
    for (const [socketId, collaborator] of roster) {
      const current = this.#state.collaborators.get(socketId);
      if (current) {
        roster.set(socketId, { ...current, ...collaborator });
      }
    }
    this.#applyCollaborators(roster);
  }

  #applyCollaborators(collaborators: CollaborationState["collaborators"]) {
    this.#editor.updateScene({
      captureUpdate: CaptureUpdateAction.NEVER,
      collaborators,
    });
    this.#setState({ collaborators });
  }

  #applyRemote(
    elements: readonly ExcalidrawElementDTO[],
    appState?: Record<string, unknown>,
    collaborators = this.#state.collaborators,
  ) {
    if (appState) {
      this.#observedSharedSceneState = stableSharedSceneState(
        normalizeSharedSceneState(appState),
      );
    }
    const restored = restoreElements(
      elements as never,
      this.#editor.getSceneElementsIncludingDeleted(),
    );
    const restoredDtos = toDtos(restored);
    this.#versions.markRemote(restoredDtos);
    this.#editor.updateScene({
      appState: appState
        ? toSharedAppState(appState, this.#editor.getAppState())
        : undefined,
      captureUpdate: CaptureUpdateAction.NEVER,
      collaborators,
      elements: restored,
    });
  }

  #emitOrSchedulePreview() {
    const elapsed =
      this.#lastPreviewAt === null
        ? this.#previewThrottleMs
        : this.#now() - this.#lastPreviewAt;
    if (elapsed >= this.#previewThrottleMs) {
      this.#flushPreview();
      return;
    }
    if (!this.#previewTimer) {
      this.#previewTimer = setTimeout(() => {
        this.#previewTimer = null;
        this.#flushPreview();
      }, this.#previewThrottleMs - elapsed);
    }
  }

  #flushPreview() {
    if (!this.#canWrite() || this.#preview.size === 0) return;
    const elements = [...this.#preview.values()];
    this.#preview.clear();
    this.#lastPreviewAt = this.#now();
    this.#transport.emit({
      baseRevision: this.#state.revision,
      elements,
      previewId: this.#createId(),
      type: "scene.preview",
    });
  }

  #scheduleDurable() {
    if (this.#durableTimer) clearTimeout(this.#durableTimer);
    this.#durableFirstDirtyAt ??= this.#now();
    const elapsed = this.#now() - this.#durableFirstDirtyAt;
    const delay = Math.max(
      0,
      Math.min(this.#durableDebounceMs, this.#durableMaxWaitMs - elapsed),
    );
    this.#durableTimer = setTimeout(() => {
      this.#durableTimer = null;
      void this.#flushDurable(false).catch((caught: unknown) => {
        this.#setState({ error: toRealtimeProblem(caught) });
      });
    }, delay);
  }

  async #flushDurable(
    full: boolean,
    allowEmit = true,
    forcePersist = false,
  ): Promise<void> {
    if (
      (!this.#canEdit() && !forcePersist) ||
      (!full && this.#dirty.size === 0 && !this.#dirtySharedSceneState)
    ) {
      return;
    }
    if (this.#durableTimer) {
      clearTimeout(this.#durableTimer);
      this.#durableTimer = null;
    }
    const elements = full
      ? await this.#ownedCanonicalScene()
      : [...this.#dirty.values()];
    const pendingSharedSceneState = full
      ? await this.#ownedSharedSceneState()
      : this.#dirtySharedSceneState;
    if (elements.length === 0 && !pendingSharedSceneState) return;
    const mutationId = this.#createId();
    const files = filesForElements(elements, this.#latestFiles);
    const record: CloudOutboxRecord = {
      baseRevision: this.#state.revision,
      createdAt: new Date(this.#now()).toISOString(),
      drawingId: this.#drawingId,
      elements,
      ...(Object.keys(files).length > 0 ? { files } : {}),
      generation: ++this.#generation,
      mutationId,
      ...(pendingSharedSceneState
        ? { sharedSceneState: pendingSharedSceneState }
        : {}),
      userId: this.#userId,
    };
    await this.#outbox.put(record);
    for (const element of elements) {
      const dirty = this.#dirty.get(element.id);
      if (dirty && sameElementGeneration(dirty, element)) {
        this.#dirty.delete(element.id);
      }
      const preview = this.#preview.get(element.id);
      if (preview && sameElementGeneration(preview, element)) {
        this.#preview.delete(element.id);
      }
    }
    if (
      pendingSharedSceneState &&
      this.#dirtySharedSceneState &&
      stableSharedSceneState(pendingSharedSceneState) ===
        stableSharedSceneState(this.#dirtySharedSceneState)
    ) {
      this.#dirtySharedSceneState = null;
    }
    if (this.#dirty.size === 0 && !this.#dirtySharedSceneState) {
      this.#durableFirstDirtyAt = null;
    }
    if (allowEmit && this.#canWrite()) {
      await this.#uploadRecordAssets(record);
      this.#transport.emit(toMutationEvent(record));
    }
  }

  async #ownedCanonicalScene() {
    const pending = await this.#outbox.list(this.#userId, this.#drawingId);
    let owned = [...this.#canonicalElements];
    for (const record of pending) {
      owned = reconcileClientElements(owned, record.elements);
    }
    return reconcileClientElements(owned, [...this.#dirty.values()]);
  }

  async #ownedSharedSceneState(): Promise<SharedSceneState> {
    const pending = await this.#outbox.list(this.#userId, this.#drawingId);
    let owned = this.#canonicalSharedSceneState;
    for (const record of pending) {
      if (record.sharedSceneState) owned = record.sharedSceneState;
    }
    return this.#dirtySharedSceneState ?? owned;
  }

  async #applyCanonicalWithOwned(appState?: Record<string, unknown>) {
    if (appState) {
      this.#canonicalSharedSceneState = normalizeSharedSceneState(appState);
    }
    this.#applyRemote(
      await this.#ownedCanonicalScene(),
      await this.#ownedSharedSceneState(),
    );
  }

  async #applyPreviewScene() {
    let displayed = await this.#ownedCanonicalScene();
    displayed = reconcileClientElements(displayed, [
      ...this.#remotePreviews.values(),
    ]);
    this.#applyRemote(displayed);
  }

  #replaceRemotePreviews(elements: readonly ExcalidrawElementDTO[]) {
    const merged = reconcileClientElements(
      [...this.#remotePreviews.values()],
      elements,
    );
    this.#remotePreviews.clear();
    for (const element of merged) {
      this.#remotePreviews.set(element.id, element);
    }
  }

  #canWrite() {
    return this.#state.status === "ready" && canWrite(this.#state.role);
  }

  #canEdit() {
    return canWrite(this.#state.role);
  }

  async #uploadRecordAssets(record: CloudOutboxRecord) {
    if (!this.#uploadAssets || !record.files) return;
    const fileIds = Object.keys(record.files);
    if (fileIds.length === 0) return;
    await this.#uploadAssets(this.#drawingId, record.files, fileIds);
  }

  #clearWriteTimers() {
    if (this.#previewTimer) clearTimeout(this.#previewTimer);
    if (this.#durableTimer) clearTimeout(this.#durableTimer);
    this.#previewTimer = null;
    this.#durableTimer = null;
  }

  #clearTimers() {
    this.#clearWriteTimers();
    if (this.#fullResyncTimer) clearInterval(this.#fullResyncTimer);
    if (this.#presenceHeartbeatTimer) {
      clearInterval(this.#presenceHeartbeatTimer);
    }
    this.#fullResyncTimer = null;
    this.#presenceHeartbeatTimer = null;
  }

  #setState(patch: Partial<CollaborationState>) {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener(this.#state);
  }
}

const canWrite = (role: Role | null): role is "owner" | "editor" =>
  role === "owner" || role === "editor";

const toMutationEvent = (record: CloudOutboxRecord): SceneMutateEvent => ({
  baseRevision: record.baseRevision,
  elements: record.elements,
  mutationId: record.mutationId,
  ...(record.sharedSceneState
    ? { sharedSceneState: record.sharedSceneState }
    : {}),
  type: "scene.mutate",
});

const sharedSceneState = (appState: AppState) => ({
  gridSize: appState.gridSize,
  gridStep: appState.gridStep,
  viewBackgroundColor: appState.viewBackgroundColor,
});

const normalizeSharedSceneState = (
  appState?: Record<string, unknown>,
): SharedSceneState => ({
  ...(typeof appState?.viewBackgroundColor === "string"
    ? { viewBackgroundColor: appState.viewBackgroundColor }
    : {}),
  ...(typeof appState?.gridSize === "number" || appState?.gridSize === null
    ? { gridSize: appState.gridSize }
    : {}),
  ...(typeof appState?.gridStep === "number"
    ? { gridStep: appState.gridStep }
    : {}),
});

const stableSharedSceneState = (appState: SharedSceneState) =>
  JSON.stringify(normalizeSharedSceneState(appState));

const filesForElements = (
  elements: readonly ExcalidrawElementDTO[],
  files: BinaryFiles,
): BinaryFiles => {
  const selected: BinaryFiles = {};
  for (const element of elements) {
    const fileId = typeof element.fileId === "string" ? element.fileId : null;
    if (fileId && files[fileId]) selected[fileId] = files[fileId];
  }
  return selected;
};

const toSharedAppState = (
  appState: Record<string, unknown>,
  local: AppState,
) => ({
  viewBackgroundColor:
    typeof appState.viewBackgroundColor === "string"
      ? appState.viewBackgroundColor
      : local.viewBackgroundColor,
  gridSize:
    typeof appState.gridSize === "number" ? appState.gridSize : local.gridSize,
  gridStep:
    typeof appState.gridStep === "number" ? appState.gridStep : local.gridStep,
});

const toDtos = (elements: readonly unknown[]): ExcalidrawElementDTO[] =>
  JSON.parse(JSON.stringify(elements)) as ExcalidrawElementDTO[];

const compareRevision = (incoming: string, current: string) => {
  const difference = BigInt(incoming) - BigInt(current);
  return difference > 1n
    ? 2
    : difference === 1n
      ? 1
      : difference === 0n
        ? 0
        : -1;
};

const toRealtimeProblem = (caught: unknown): RealtimeProblem => ({
  code: "COLLABORATION_CLIENT_ERROR",
  message: caught instanceof Error ? caught.message : "Collaboration failed",
  requestId: "socket-client",
  retryable: false,
});

const sameElementGeneration = (
  left: ExcalidrawElementDTO,
  right: ExcalidrawElementDTO,
) =>
  left.id === right.id &&
  left.version === right.version &&
  left.versionNonce === right.versionNonce &&
  left.isDeleted === right.isDeleted;

const isEventLocalProblem = (problem: RealtimeProblem) =>
  problem.retryable ||
  problem.code.includes("RATE_LIMIT") ||
  problem.code.startsWith("PREVIEW_") ||
  problem.code.startsWith("PRESENCE_");
