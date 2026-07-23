import {
  CaptureUpdateAction,
  MainMenu,
  useHandleLibrary,
} from "@excalidraw/excalidraw";
import type {
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import {
  type DrawingSummary,
  type ExcalidrawElementDTO,
  type SaveContentRequest,
} from "@open-excalidraw/contracts";
import {
  type ComponentType,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { getDrawingCapabilities, ViewerBanner } from "../access";
import {
  AssetClient,
  AssetUploadManager,
  CloudPersistence,
  collectAssetReferences,
  hydrateAssets,
  type HydrationResult,
} from "../assets";
import {
  browserConnectivity,
  type ConnectivitySource,
  useConnectivity,
} from "../connectivity";
import {
  CloudOutboxDb,
  type CloudOutboxRecord,
} from "../connectivity/storage/cloudOutboxDb";
import { ChatClient, ChatPanel, type ChatSource } from "../chat";
import {
  CollaborationController,
  isEventLocalProblem,
  reconcileClientElements,
  SocketIoTransport,
  type CollaborationState,
} from "../collaboration";
import {
  dashboardIcon,
  ExcalidrawHost,
  historyIcon,
  shareIcon,
  type CanvasStatusTone,
  type ExcalidrawChangeHandler,
  type ExcalidrawHostProps,
} from "../editor";
import { LibraryClient, useLibrarySync } from "../library";
import {
  AutosaveController,
  CloudRecoveryRepository,
  ConflictRecoveryBanner,
  ContentClient,
  ContentRequestError,
  createRecoveryWriter,
  OverrideSnapshotDb,
  projectSaveRequest,
  type AutosaveControllerOptions,
  type AutosaveSnapshot,
  type AutosaveState,
  type CloudRecoveryRecord,
  type LoadedContent,
  type OverrideSnapshotRecord,
} from "../persistence";
import {
  RevisionClient,
  RevisionHistoryDialog,
  type RevisionSource,
  type RestoreResponse,
} from "../revisions";
import { SharingClient, SharingDialog, type SharingSource } from "../sharing";

import { ApiError } from "../../shared/api";

// Deep imports (not the dashboard barrel) so the workspace chunk never pulls in
// the lazy DashboardPage.
import {
  DashboardApiClient,
  type DashboardApi,
} from "../dashboard/dashboard-api";
import { PendingCreateDb } from "../dashboard/pending-create-db";

import { DrawingMetadataClient, type DrawingMetadataSource } from "./api";
import { effectiveWorkspaceRole, isMembershipRevoked } from "./access-state";
import { restoreWithRealtimeBoundary } from "./restore-boundary";
import { captureThumbnail } from "./thumbnail";

import "./workspace.css";

type ContentSource = Pick<ContentClient, "load" | "save">;
type LibrarySource = Pick<LibraryClient, "load" | "save">;
type AssetSource = Pick<
  AssetClient,
  "deleteThumbnail" | "download" | "upload" | "uploadThumbnail"
>;
type RecoverySource = Pick<
  CloudRecoveryRepository,
  "get" | "put" | "putMetadata"
>;
// The controller writes overrides (put); the "Save a copy" action reads (get).
type OverrideSnapshotSource = Pick<OverrideSnapshotDb, "get" | "put">;
type OutboxSource = Pick<CloudOutboxDb, "list">;
type PendingCreateSource = Pick<PendingCreateDb, "get" | "remove">;
type DrawingCreateSource = Pick<DashboardApi, "createDrawing">;
type UpdateSceneData = Parameters<ExcalidrawImperativeAPI["updateScene"]>[0];
type PendingRealtimeChange = {
  appState: Parameters<ExcalidrawChangeHandler>[1];
  drawingId: string;
  elements: Parameters<ExcalidrawChangeHandler>[0];
  files: Parameters<ExcalidrawChangeHandler>[2];
};

export interface DrawingWorkspaceDependencies {
  assets?: AssetSource;
  captureThumbnail?: typeof captureThumbnail;
  chat?: ChatSource;
  connectivity?: ConnectivitySource;
  content?: ContentSource;
  createAutosave?: (options: AutosaveControllerOptions) => AutosaveController;
  createDrawing?: DrawingCreateSource;
  createRealtimeTransport?: () => SocketIoTransport;
  host?: ComponentType<ExcalidrawHostProps>;
  hydrate?: typeof hydrateAssets;
  library?: LibrarySource;
  metadata?: DrawingMetadataSource;
  outbox?: OutboxSource;
  overrideSnapshots?: OverrideSnapshotSource;
  pendingCreates?: PendingCreateSource;
  recovery?: RecoverySource;
  revisions?: RevisionSource;
  sharing?: SharingSource;
}

export interface DrawingPageProps {
  autosaveDebounceMs?: number;
  collaborationEnabled?: boolean;
  dependencies?: DrawingWorkspaceDependencies;
  drawingId: string;
  onCreatePrivateCopy?: (drawingId: string, snapshot: AutosaveSnapshot) => void;
  onExportLocal?: (drawingId: string, snapshot: AutosaveSnapshot) => void;
  thumbnailDebounceMs?: number;
  userId: string;
}

interface WorkspaceLoad {
  content: LoadedContent;
  drawing: DrawingSummary;
  drawingId: string;
  initialData: ExcalidrawInitialDataState;
  // True when hydrated from the local recovery snapshot after an offline load.
  local: boolean;
  userId: string;
}

interface WorkspaceLoadError {
  drawingId: string;
  error: Error;
  userId: string;
}

const EMPTY_AUTOSAVE_STATE: AutosaveState = {
  conflict: null,
  error: null,
  revision: "0",
  status: "idle",
};

const EMPTY_COLLABORATION_STATE: CollaborationState = {
  collaborators: new Map(),
  error: null,
  overriddenElements: null,
  revision: "0",
  role: null,
  status: "idle",
};

// Shown while an offline-created drawing still has its pending-create marker:
// sharing would 404 (or expose a sparse scene) until the first sync lands.
const SHARING_GATED_LABEL = "Sharing unlocks after this drawing first syncs";

export const DrawingPage = ({
  autosaveDebounceMs,
  collaborationEnabled = true,
  dependencies,
  drawingId,
  onCreatePrivateCopy,
  onExportLocal,
  thumbnailDebounceMs = 10_000,
  userId,
}: DrawingPageProps) => {
  const [ownedDefaults] = useState(() => ({
    assets: new AssetClient(),
    chat: new ChatClient(),
    content: new ContentClient(),
    createDrawing: new DashboardApiClient(),
    library: new LibraryClient(),
    metadata: new DrawingMetadataClient(),
    outbox: new CloudOutboxDb(),
    overrideSnapshots: new OverrideSnapshotDb(),
    pendingCreates: new PendingCreateDb(),
    recovery: new CloudRecoveryRepository(),
    revisions: new RevisionClient(),
    sharing: new SharingClient(),
  }));

  const resolved = useMemo(
    () => ({
      assets: dependencies?.assets ?? ownedDefaults.assets,
      captureThumbnail: dependencies?.captureThumbnail ?? captureThumbnail,
      chat: dependencies?.chat ?? ownedDefaults.chat,
      connectivity: dependencies?.connectivity ?? browserConnectivity,
      content: dependencies?.content ?? ownedDefaults.content,
      createAutosave:
        dependencies?.createAutosave ??
        ((options: AutosaveControllerOptions) =>
          new AutosaveController(options)),
      createDrawing: dependencies?.createDrawing ?? ownedDefaults.createDrawing,
      createRealtimeTransport:
        dependencies?.createRealtimeTransport ??
        (() => new SocketIoTransport()),
      hydrate: dependencies?.hydrate ?? hydrateAssets,
      Host: dependencies?.host ?? ExcalidrawHost,
      library: dependencies?.library ?? ownedDefaults.library,
      metadata: dependencies?.metadata ?? ownedDefaults.metadata,
      outbox: dependencies?.outbox ?? ownedDefaults.outbox,
      overrideSnapshots:
        dependencies?.overrideSnapshots ?? ownedDefaults.overrideSnapshots,
      pendingCreates:
        dependencies?.pendingCreates ?? ownedDefaults.pendingCreates,
      recovery: dependencies?.recovery ?? ownedDefaults.recovery,
      revisions: dependencies?.revisions ?? ownedDefaults.revisions,
      sharing: dependencies?.sharing ?? ownedDefaults.sharing,
    }),
    [dependencies, ownedDefaults],
  );
  const { createRealtimeTransport } = resolved;
  const connectivity = useConnectivity(resolved.connectivity);
  const [load, setLoad] = useState<WorkspaceLoad | null>(null);
  const [loadError, setLoadError] = useState<WorkspaceLoadError | null>(null);
  const [conflictLoadError, setConflictLoadError] = useState<Error | null>(
    null,
  );
  const [loadGeneration, setLoadGeneration] = useState(0);
  const [controller, setController] = useState<AutosaveController | null>(null);
  const [autosave, setAutosave] = useState<AutosaveState>(EMPTY_AUTOSAVE_STATE);
  const collaborationControllerRef = useRef<CollaborationController | null>(
    null,
  );
  const collaborationOutboxRef = useRef<CloudOutboxDb | null>(null);
  const pendingRealtimeChangeRef = useRef<PendingRealtimeChange | null>(null);
  const [collaboration, setCollaboration] = useState<CollaborationState>(
    EMPTY_COLLABORATION_STATE,
  );
  // Keyed by the override event's `at` so a later, distinct override re-shows.
  const [dismissedOverrideAt, setDismissedOverrideAt] = useState<number | null>(
    null,
  );
  const [sharingOpen, setSharingOpen] = useState(false);
  // True while this user still holds a pending-create marker for the drawing:
  // the offline-created scene has not synced, so sharing stays gated.
  const [sharingGated, setSharingGated] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatUnread, setChatUnread] = useState(0);
  const [chatTransport, setChatTransport] = useState<SocketIoTransport | null>(
    null,
  );

  // The panel only listens while it is open, so the page keeps the unread
  // badge: messages from others that arrive while the panel is closed. The
  // count resets in the open/close handlers, not here.
  useEffect(() => {
    if (!chatTransport || chatOpen) {
      return;
    }
    return chatTransport.onChatMessage((message) => {
      if (message.drawingId === drawingId && message.userId !== userId) {
        setChatUnread((count) => count + 1);
      }
    });
  }, [chatTransport, chatOpen, drawingId, userId]);

  const toggleChat = useCallback(() => {
    setChatUnread(0);
    setChatOpen((open) => !open);
  }, []);
  const [restoringRevision, setRestoringRevision] = useState(false);
  const [editorApi, setEditorApi] = useState<ExcalidrawImperativeAPI | null>(
    null,
  );
  const [assetFailures, setAssetFailures] = useState<
    ReadonlyMap<string, Error>
  >(new Map());
  const hydrationGeneration = useRef(0);
  const editorApiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const thumbnailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // undefined = unknown server state, null = known cleared, string = last sha.
  const thumbnailShaRef = useRef<string | null | undefined>(undefined);
  // Invalidates in-flight captures on drawing change: a late result from the
  // previous drawing must not seed this drawing's sha and suppress uploads.
  const thumbnailGenerationRef = useRef(0);
  const thumbnailInFlightRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    editorApiRef.current = editorApi;
  }, [editorApi]);

  const captureThumbnailNow = useCallback(
    function fire() {
      thumbnailTimerRef.current = null;
      const api = editorApiRef.current;
      // The arming onChange and setEditorApi land in the same commit, but the
      // ref is only populated an effect-flush later — a timer that fires in
      // that gap must retry, not silently drop the only pending capture.
      if (!api) {
        thumbnailTimerRef.current = setTimeout(fire, thumbnailDebounceMs);
        return;
      }
      // One capture chain at a time; the next edit re-arms the window rather
      // than overlapping a slow capture.
      if (thumbnailInFlightRef.current) {
        return;
      }
      const generation = thumbnailGenerationRef.current;
      // Fire-and-forget: thumbnail failures must never surface or touch
      // autosave/collaboration state.
      const capture = resolved
        .captureThumbnail(
          api,
          drawingId,
          resolved.assets,
          thumbnailShaRef.current,
        )
        .then((sha256) => {
          if (generation === thumbnailGenerationRef.current) {
            thumbnailShaRef.current = sha256;
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (thumbnailInFlightRef.current === capture) {
            thumbnailInFlightRef.current = null;
          }
        });
      thumbnailInFlightRef.current = capture;
    },
    [drawingId, resolved, thumbnailDebounceMs],
  );

  // Trailing throttle: at most one capture per window, of the scene as it
  // is at fire time. Continuous drawing keeps refreshing instead of being
  // starved by a reset-on-change debounce.
  const scheduleThumbnail = useCallback(() => {
    thumbnailTimerRef.current ??= setTimeout(
      captureThumbnailNow,
      thumbnailDebounceMs,
    );
  }, [captureThumbnailNow, thumbnailDebounceMs]);

  // ponytail: no pagehide/keepalive; worst case the thumbnail is one
  // editing session stale.
  useEffect(() => {
    const flushWhenHidden = () => {
      if (
        document.visibilityState === "hidden" &&
        thumbnailTimerRef.current !== null
      ) {
        clearTimeout(thumbnailTimerRef.current);
        captureThumbnailNow();
      }
    };
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [captureThumbnailNow]);

  useEffect(
    () => () => {
      if (thumbnailTimerRef.current !== null) {
        clearTimeout(thumbnailTimerRef.current);
        thumbnailTimerRef.current = null;
      }
      thumbnailGenerationRef.current += 1;
      thumbnailShaRef.current = undefined;
      thumbnailInFlightRef.current = null;
    },
    [drawingId],
  );
  const workspace =
    load?.drawingId === drawingId && load.userId === userId ? load : null;
  const workspaceLoadError =
    loadError?.drawingId === drawingId && loadError.userId === userId
      ? loadError.error
      : null;

  useEffect(() => {
    let active = true;
    let activeController: AutosaveController | null = null;
    let unsubscribe: () => void = () => undefined;

    queueMicrotask(() => {
      if (active) {
        setLoad(null);
        setLoadError(null);
        setController(null);
        setAutosave(EMPTY_AUTOSAVE_STATE);
        setConflictLoadError(null);
        setEditorApi(null);
        setAssetFailures(new Map());
        setRestoringRevision(false);
        setChatUnread(0);
        setSharingGated(false);
      }
    });

    const applyWorkspace = (
      drawing: DrawingSummary,
      content: LoadedContent,
      local: boolean,
      files?: BinaryFiles,
    ) => {
      const capabilities = getDrawingCapabilities(drawing.role);
      if (capabilities.editScene) {
        const uploads = new AssetUploadManager({ client: resolved.assets });
        const persistence = new CloudPersistence(
          drawingId,
          resolved.content,
          uploads,
        );
        activeController = resolved.createAutosave({
          ...(autosaveDebounceMs === undefined
            ? {}
            : { debounceMs: autosaveDebounceMs }),
          initialRevision: content.revision,
          persist: (snapshot, revision, idempotencyKey) =>
            persistence.persist(snapshot, revision, idempotencyKey),
          writeRecovery: createRecoveryWriter(
            resolved.recovery as CloudRecoveryRepository,
            userId,
            drawingId,
          ),
        });
        // Excalidraw emits onChange while applying initial data. Acknowledging
        // the canonical projection first prevents that event from becoming a
        // synthetic dirty save.
        activeController.acceptServer(toAcknowledgedContent(content));
        unsubscribe = activeController.subscribe(setAutosave);
        setController(activeController);
      }

      setLoad({
        content,
        drawing,
        drawingId,
        // Offline loads seed the editor's file cache from locally stored blobs
        // so embedded images render without a server fetch.
        initialData: files
          ? { ...toInitialData(content), files }
          : toInitialData(content),
        local,
        userId,
      });
    };

    const failLoad = (caught: unknown) => {
      if (active) {
        setLoadError({
          drawingId,
          error: toError(caught, "Could not open this drawing."),
          userId,
        });
      }
    };

    void createPendingBeforeLoad(
      resolved.connectivity,
      resolved.pendingCreates,
      resolved.createDrawing,
      userId,
      drawingId,
    )
      .then((pending) => {
        if (active) {
          setSharingGated(pending);
        }
        return Promise.all([
          resolved.metadata.load(drawingId),
          resolved.content.load(drawingId),
        ]);
      })
      .then(([drawing, content]) => {
        if (!active) {
          return;
        }
        // Cache the summary so a later offline reload can reopen this drawing.
        void resolved.recovery
          .putMetadata(userId, drawingId, drawing)
          .catch(() => undefined);
        applyWorkspace(drawing, content, false);
      })
      .catch((caught: unknown) => {
        if (!active) {
          return;
        }
        // Only a network-level failure (offline / fetch rejection) falls back to
        // the local snapshot. HTTP problem responses (401/403/404/…) are the
        // real error and must not be masked by a stale local copy.
        if (isHttpProblem(caught)) {
          failLoad(caught);
          return;
        }
        void loadLocalWorkspace(
          resolved.recovery,
          resolved.outbox,
          userId,
          drawingId,
        )
          .then((localWorkspace) => {
            if (!active) {
              return;
            }
            if (localWorkspace) {
              applyWorkspace(
                localWorkspace.drawing,
                localWorkspace.content,
                true,
                localWorkspace.files,
              );
            } else {
              failLoad(caught);
            }
          })
          .catch(() => failLoad(caught));
      });

    return () => {
      active = false;
      unsubscribe();
      activeController?.dispose();
    };
  }, [autosaveDebounceMs, drawingId, loadGeneration, resolved, userId]);

  // The load effect only runs on open, so a drawing opened offline keeps its
  // pending-create marker (and gated sharing) until reconnect. Re-run the
  // create when connectivity returns to sync it and lift the gate in place.
  useEffect(() => {
    if (connectivity !== "online" || !sharingGated) {
      return;
    }
    let active = true;
    void createPendingBeforeLoad(
      resolved.connectivity,
      resolved.pendingCreates,
      resolved.createDrawing,
      userId,
      drawingId,
    )
      .then((pending) => {
        if (active) {
          setSharingGated(pending);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [connectivity, drawingId, resolved, sharingGated, userId]);

  useEffect(() => {
    if (!collaborationEnabled || !editorApi || !workspace) {
      return;
    }

    const outbox = new CloudOutboxDb();
    collaborationOutboxRef.current = outbox;
    const uploads = new AssetUploadManager({ client: resolved.assets });
    const transport = createRealtimeTransport();
    const realtime = new CollaborationController({
      drawingId,
      editor: editorApi,
      initialAppState: workspace.content.content.scene.appState,
      initialElements: workspace.content.content.scene.elements,
      initialRole: workspace.drawing.role,
      outbox,
      overrideSnapshots: resolved.overrideSnapshots,
      transport,
      uploadAssets: (nextDrawingId, files, fileIds) =>
        uploads.uploadReferenced(nextDrawingId, files, fileIds),
      userId,
    });
    // The chat panel shares this socket, so it lives in state too. The
    // microtask keeps the setState out of the synchronous effect body.
    queueMicrotask(() => {
      if (collaborationControllerRef.current === realtime) {
        setChatTransport(transport);
      }
    });
    const unsubscribe = realtime.subscribe(setCollaboration);
    collaborationControllerRef.current = realtime;
    realtime.start();
    const pending = pendingRealtimeChangeRef.current;
    if (pending?.drawingId === drawingId) {
      realtime.onChange(pending.elements, pending.appState, pending.files);
      pendingRealtimeChangeRef.current = null;
    } else {
      realtime.onChange(
        editorApi.getSceneElementsIncludingDeleted(),
        editorApi.getAppState(),
        editorApi.getFiles(),
      );
    }

    return () => {
      unsubscribe();
      if (collaborationControllerRef.current === realtime) {
        collaborationControllerRef.current = null;
      }
      if (collaborationOutboxRef.current === outbox) {
        collaborationOutboxRef.current = null;
      }
      setChatTransport((current) => (current === transport ? null : current));
      setCollaboration(EMPTY_COLLABORATION_STATE);
      void realtime
        .stop()
        .catch(() => undefined)
        .finally(() => outbox.close());
    };
  }, [
    collaborationEnabled,
    createRealtimeTransport,
    drawingId,
    editorApi,
    resolved.assets,
    resolved.overrideSnapshots,
    userId,
    workspace,
  ]);

  useEffect(() => {
    if (!editorApi || !workspace) {
      return;
    }
    // Local workspaces derive references from the merged scene, not
    // snapshot.assetIds: an image added offline lives only in outbox elements
    // and would otherwise be invisible to hydration once connectivity returns.
    const assetIds =
      collaborationEnabled && collaboration.status !== "idle"
        ? collectAssetReferences(editorApi.getSceneElementsIncludingDeleted())
        : workspace.local
          ? collectAssetReferences(workspace.content.content.scene.elements)
          : workspace.content.content.assetIds;
    // Assets restored from the local snapshot are already in the editor via
    // initialData.files. Re-fetching them would fail while offline and raise a
    // false warning; genuinely missing ones still fall through to the fetch.
    const localFiles = workspace.local
      ? workspace.initialData.files
      : undefined;
    const pendingIds = localFiles
      ? assetIds.filter((fileId) => !localFiles[fileId])
      : assetIds;
    if (pendingIds.length === 0) {
      return;
    }

    const generation = ++hydrationGeneration.current;
    const abort = new AbortController();
    queueMicrotask(() => {
      if (generation === hydrationGeneration.current) {
        setAssetFailures(new Map());
      }
    });
    void resolved
      .hydrate(editorApi, resolved.assets, drawingId, pendingIds, abort.signal)
      .then((result: HydrationResult) => {
        if (generation === hydrationGeneration.current && !result.cancelled) {
          setAssetFailures(result.failed);
        }
      })
      .catch((caught: unknown) => {
        if (generation === hydrationGeneration.current) {
          setAssetFailures(
            new Map([
              ["workspace-hydration", toError(caught, "Asset loading failed")],
            ]),
          );
        }
      });

    return () => {
      abort.abort();
      hydrationGeneration.current += 1;
    };
  }, [
    collaboration.revision,
    collaboration.status,
    collaborationEnabled,
    drawingId,
    editorApi,
    resolved,
    workspace,
  ]);

  useEffect(
    () => () => {
      hydrationGeneration.current += 1;
      if (!dependencies?.recovery) {
        void ownedDefaults.recovery.close();
      }
      if (!dependencies?.outbox) {
        void ownedDefaults.outbox.close();
      }
      if (!dependencies?.overrideSnapshots) {
        void ownedDefaults.overrideSnapshots.close();
      }
      if (!dependencies?.pendingCreates) {
        void ownedDefaults.pendingCreates.close();
      }
    },
    [
      dependencies?.outbox,
      dependencies?.overrideSnapshots,
      dependencies?.pendingCreates,
      dependencies?.recovery,
      ownedDefaults,
    ],
  );

  const onChange = useCallback<ExcalidrawChangeHandler>(
    (elements, appState, files) => {
      if (!controller || !workspace) {
        return;
      }
      const effectiveRole = effectiveWorkspaceRole(
        workspace.drawing.role,
        collaboration.role,
        collaboration.error?.code,
      );
      if (!effectiveRole) return;
      const capabilities = getDrawingCapabilities(effectiveRole);
      if (!capabilities.editScene || !capabilities.uploadAssets) {
        return;
      }

      // Covers both persistence paths below; only rearms a timer.
      scheduleThumbnail();

      const collaborationController = collaborationControllerRef.current;
      if (collaborationEnabled) {
        if (collaborationController) {
          collaborationController.onChange(elements, appState, files);
          collaborationController.publishPresence({
            idleState: "active",
            selectedElementIds: appState.selectedElementIds,
          });
        } else {
          pendingRealtimeChangeRef.current = {
            appState,
            drawingId,
            elements,
            files,
          };
        }
        return;
      }

      controller.schedule({
        files: { ...files },
        request: projectSaveRequest(
          elements,
          appState,
          collectAssetReferences(elements),
        ),
      });
    },
    [
      collaboration.role,
      collaboration.error?.code,
      collaborationEnabled,
      controller,
      drawingId,
      scheduleThumbnail,
      workspace,
    ],
  );

  const onPointerUpdate = useCallback<
    NonNullable<ExcalidrawHostProps["onPointerUpdate"]>
  >(({ button, pointer }) => {
    collaborationControllerRef.current?.publishPresence({
      button,
      idleState: "active",
      pointer,
    });
  }, []);

  // The shape library is per-account, not per-drawing: it syncs whenever the
  // signed-in user has the editor open, regardless of their role here.
  const onLibraryChange = useLibrarySync(editorApi, {
    client: resolved.library,
  });

  // Consumes the #addLibrary=... hash after "Browse libraries" redirects back
  // from libraries.excalidraw.com: it prompts, then merges the public library
  // into the editor. No adapter — the merge fires onLibraryChange, and
  // useLibrarySync above persists it to the account.
  useHandleLibrary({ excalidrawAPI: editorApi });

  const reloadServer = useCallback(
    (server: LoadedContent) => {
      controller?.acceptServer(toAcknowledgedContent(server));
      setConflictLoadError(null);
      setLoad((current) =>
        current && current.drawingId === drawingId && current.userId === userId
          ? {
              ...current,
              content: server,
              initialData: toInitialData(server),
              local: false,
            }
          : current,
      );
      editorApi?.updateScene({
        appState: server.content.scene.appState as UpdateSceneData["appState"],
        captureUpdate: CaptureUpdateAction.NEVER,
        elements: server.content.scene
          .elements as unknown as ExcalidrawInitialDataState["elements"],
      });
    },
    [controller, drawingId, editorApi, userId],
  );

  const restoreRevision = useCallback(
    async (
      revision: string,
      revisionSource: RevisionSource,
    ): Promise<RestoreResponse> => {
      const realtime = collaborationControllerRef.current;
      const outbox = collaborationOutboxRef.current;
      setRestoringRevision(true);
      try {
        const restored = await restoreWithRealtimeBoundary({
          autosave: controller,
          drawingId,
          outbox,
          realtime,
          restore: () => revisionSource.restore(drawingId, revision),
          userId,
        });
        if (realtime && collaborationControllerRef.current === realtime) {
          collaborationControllerRef.current = null;
        }
        return restored;
      } catch (caught) {
        setRestoringRevision(false);
        throw caught;
      }
    },
    [controller, drawingId, userId],
  );

  if (workspaceLoadError) {
    return (
      <main className="drawing-workspace drawing-workspace--centered">
        <section className="workspace-message" role="alert">
          <h1>Could not open this drawing</h1>
          <p>{workspaceLoadError.message}</p>
          <button
            onClick={() => setLoadGeneration((generation) => generation + 1)}
            type="button"
          >
            Try again
          </button>
        </section>
      </main>
    );
  }

  if (!workspace) {
    return (
      <main className="drawing-workspace drawing-workspace--centered">
        <p aria-live="polite">Loading drawing…</p>
      </main>
    );
  }

  const accessRevoked = isMembershipRevoked(collaboration.error?.code);
  const effectiveRole = effectiveWorkspaceRole(
    workspace.drawing.role,
    collaboration.role,
    collaboration.error?.code,
  );
  const capabilities = getDrawingCapabilities(effectiveRole ?? "viewer");
  const conflictSnapshot = autosave.conflict?.local;
  const actionableSnapshot = conflictSnapshot;
  const WorkspaceHost = resolved.Host;

  const status = saveStatusLabel(
    connectivity,
    capabilities.editScene,
    autosave,
    collaborationEnabled ? collaboration : null,
    restoringRevision,
    workspace.local,
  );
  // Local hydration surfaces until live collaboration takes over on reconnect.
  const viewingLocalCopy = workspace.local && collaboration.status !== "ready";

  return (
    <main className="drawing-workspace">
      <div className="workspace-overlays">
        {viewingLocalCopy ? (
          <section className="workspace-collaboration-warning" role="status">
            <strong>You're viewing your last local copy.</strong>
            <span>
              These are your locally saved changes. They sync automatically when
              you reconnect.
            </span>
          </section>
        ) : null}

        {!capabilities.editScene ? (
          <ViewerBanner ownerName={workspace.drawing.ownerName} />
        ) : null}

        {autosave.conflict ? (
          <ConflictRecoveryBanner
            onCreatePrivateCopy={() => {
              if (actionableSnapshot) {
                if (onCreatePrivateCopy) {
                  onCreatePrivateCopy(drawingId, actionableSnapshot);
                } else {
                  exportSnapshot(
                    workspace.drawing.title,
                    actionableSnapshot,
                    "private-copy",
                  );
                }
              }
            }}
            onExportLocal={() => {
              if (actionableSnapshot) {
                if (onExportLocal) {
                  onExportLocal(drawingId, actionableSnapshot);
                } else {
                  exportSnapshot(
                    workspace.drawing.title,
                    actionableSnapshot,
                    "local",
                  );
                }
              }
            }}
            onReloadServer={reloadServer}
            onRetryLoad={async () => {
              try {
                await controller?.reloadConflictServer(() =>
                  resolved.content.load(drawingId),
                );
                setConflictLoadError(null);
              } catch (caught) {
                setConflictLoadError(
                  toError(caught, "Could not load the server version."),
                );
              }
            }}
            onRetryLocal={(revision) => controller?.retryLocalAgainst(revision)}
            server={autosave.conflict.server}
          />
        ) : autosave.status === "error" ? (
          <section className="workspace-save-error" role="alert">
            <strong>Changes could not be saved.</strong>
            <span>{autosave.error?.message}</span>
            <button
              onClick={() => void controller?.retryTerminal()}
              type="button"
            >
              Retry save
            </button>
          </section>
        ) : null}

        {conflictLoadError ? (
          <p className="workspace-conflict-error" role="status">
            {conflictLoadError.message}
          </p>
        ) : null}

        {assetFailures.size > 0 ? (
          <p className="workspace-asset-warning" role="status">
            {assetFailures.size} drawing asset
            {assetFailures.size === 1 ? "" : "s"} could not be loaded.
          </p>
        ) : null}

        {collaborationEnabled &&
        (collaboration.status === "reconnecting" ||
          (collaboration.error &&
            !isEventLocalProblem(collaboration.error))) ? (
          <section
            className="workspace-collaboration-warning"
            role={collaboration.error ? "alert" : "status"}
          >
            <strong>
              {isAccessChange(collaboration.error?.code)
                ? "Your collaboration access changed."
                : "Live collaboration was interrupted."}
            </strong>
            <span>
              {collaboration.error?.message ??
                "Your changes remain in local recovery while we reconnect."}
            </span>
            {editorApi ? (
              <button
                onClick={() =>
                  exportSnapshot(
                    workspace.drawing.title,
                    currentSnapshot(editorApi),
                    "local-recovery",
                  )
                }
                type="button"
              >
                Export local drawing
              </button>
            ) : null}
            {accessRevoked ? <a href="/app">Back to dashboard</a> : null}
          </section>
        ) : null}

        {collaborationEnabled &&
        collaboration.overriddenElements &&
        collaboration.overriddenElements.at !== dismissedOverrideAt ? (
          <section className="workspace-collaboration-warning" role="status">
            <strong>
              Your offline changes to {collaboration.overriddenElements.count}{" "}
              element
              {collaboration.overriddenElements.count === 1 ? "" : "s"} were
              replaced by newer edits.
            </strong>
            <span>
              A copy of your pre-merge drawing is saved on this device.
            </span>
            <button
              onClick={() =>
                void exportOverrideSnapshot(
                  resolved.overrideSnapshots,
                  workspace.drawing.title,
                  userId,
                  drawingId,
                )
              }
              type="button"
            >
              Save a copy
            </button>
            <button
              onClick={() =>
                setDismissedOverrideAt(
                  collaboration.overriddenElements?.at ?? null,
                )
              }
              type="button"
            >
              Dismiss
            </button>
          </section>
        ) : null}
      </div>

      <WorkspaceHost
        key={drawingId}
        initialData={workspace.initialData}
        isCollaborating={collaboration.status === "ready"}
        onApiChange={setEditorApi}
        onChange={
          capabilities.editScene && !restoringRevision ? onChange : undefined
        }
        onLibraryChange={onLibraryChange}
        onPointerUpdate={onPointerUpdate}
        readOnly={!capabilities.editScene || restoringRevision}
        renderTopRightUI={() => (
          <div className="canvas-top-right">
            <span
              aria-live="polite"
              className={`canvas-status canvas-status--${statusTone(
                autosave,
                collaboration,
                connectivity,
              )}`}
              role="status"
            >
              {status}
            </span>
            <span
              className={`canvas-role canvas-role--${effectiveRole ?? "revoked"}`}
            >
              {effectiveRole ?? "access revoked"}
            </span>
            {collaborationEnabled ? (
              <button
                aria-label={
                  chatUnread > 0
                    ? `Chat, ${chatUnread} unread message${chatUnread === 1 ? "" : "s"}`
                    : "Chat"
                }
                className="canvas-action"
                onClick={toggleChat}
                type="button"
              >
                Chat
                {chatUnread > 0 ? (
                  <span aria-hidden="true" className="chat-unread-badge">
                    {chatUnread > 99 ? "99+" : chatUnread}
                  </span>
                ) : null}
              </button>
            ) : null}
            <button
              className="canvas-action"
              onClick={() => setHistoryOpen(true)}
              type="button"
            >
              History
            </button>
            {capabilities.manageSharing ? (
              <button
                aria-label={sharingGated ? SHARING_GATED_LABEL : undefined}
                className="canvas-action canvas-action--primary"
                disabled={sharingGated}
                onClick={() => setSharingOpen(true)}
                title={sharingGated ? SHARING_GATED_LABEL : undefined}
                type="button"
              >
                Share
              </button>
            ) : null}
          </div>
        )}
        title={workspace.drawing.title}
      >
        <MainMenu>
          <MainMenu.ItemLink href="/app" icon={dashboardIcon}>
            Back to dashboard
          </MainMenu.ItemLink>
          <MainMenu.Item
            icon={historyIcon}
            onSelect={() => setHistoryOpen(true)}
          >
            Revision history
          </MainMenu.Item>
          {capabilities.manageSharing ? (
            <MainMenu.Item
              aria-label={sharingGated ? SHARING_GATED_LABEL : undefined}
              disabled={sharingGated}
              icon={shareIcon}
              onSelect={() => setSharingOpen(true)}
            >
              Share
            </MainMenu.Item>
          ) : null}
          <MainMenu.Separator />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.Export />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </WorkspaceHost>

      {collaborationEnabled && chatOpen && chatTransport ? (
        <ChatPanel
          client={resolved.chat}
          drawingId={drawingId}
          error={collaboration.error}
          onClose={() => setChatOpen(false)}
          status={collaboration.status}
          transport={chatTransport}
          userId={userId}
        />
      ) : null}
      <SharingDialog
        client={resolved.sharing}
        drawingId={drawingId}
        onClose={() => setSharingOpen(false)}
        open={sharingOpen && capabilities.manageSharing}
      />
      <RevisionHistoryDialog
        canRestore={capabilities.editScene && !restoringRevision}
        client={resolved.revisions}
        drawingId={drawingId}
        onClose={() => setHistoryOpen(false)}
        onRestore={restoreRevision}
        onRestored={() => {
          setHistoryOpen(false);
          setLoadGeneration((generation) => generation + 1);
        }}
        open={historyOpen}
      />
    </main>
  );
};

const statusTone = (
  autosave: AutosaveState,
  collaboration: CollaborationState,
  connectivity: "online" | "offline",
): CanvasStatusTone => {
  if (
    autosave.status === "error" ||
    autosave.status === "conflict" ||
    connectivity === "offline"
  ) {
    return "error";
  }
  if (
    autosave.status === "retrying" ||
    collaboration.status === "reconnecting"
  ) {
    return "warning";
  }
  return collaboration.status === "ready" ? "active" : "muted";
};

const saveStatusLabel = (
  connectivity: "online" | "offline",
  canEdit: boolean,
  autosave: AutosaveState,
  collaboration: CollaborationState | null,
  restoringRevision: boolean,
  local: boolean,
): string => {
  if (restoringRevision) {
    return "Restoring revision…";
  }
  if (!canEdit) {
    return "View only";
  }
  if (connectivity === "offline") {
    return "Offline — changes are kept in local recovery";
  }
  // Loaded from the local snapshot while the server was unreachable; the
  // outbox syncs once collaboration reconnects.
  if (local && (!collaboration || collaboration.status !== "ready")) {
    return "Viewing your last local copy — changes sync on reconnect";
  }
  if (collaboration) {
    switch (collaboration.status) {
      case "ready":
        return `Live · ${collaboration.collaborators.size} collaborator${
          collaboration.collaborators.size === 1 ? "" : "s"
        }`;
      case "connecting":
      case "joining":
        return "Connecting to collaboration…";
      case "reconnecting":
        return "Reconnecting — changes kept locally";
      case "error":
        return "Collaboration needs attention";
      default:
        break;
    }
  }
  switch (autosave.status) {
    case "dirty":
      return "Unsaved changes";
    case "saving":
      return "Saving…";
    case "retrying":
      return "Save interrupted — retrying…";
    case "saved":
      return "Saved";
    case "conflict":
      return "Save conflict";
    case "error":
      return "Save failed";
    default:
      return "Ready";
  }
};

const currentSnapshot = (
  editorApi: ExcalidrawImperativeAPI,
): AutosaveSnapshot => {
  const elements = editorApi.getSceneElementsIncludingDeleted();
  return {
    files: editorApi.getFiles(),
    request: projectSaveRequest(
      elements,
      editorApi.getAppState(),
      collectAssetReferences(elements),
    ),
  };
};

const isAccessChange = (code: string | undefined) =>
  code === "FORBIDDEN" ||
  code === "SOCKET_EVENT_FORBIDDEN" ||
  isMembershipRevoked(code);

const exportSnapshot = (
  title: string,
  snapshot: { request: SaveContentRequest; files?: unknown },
  suffix: string,
) =>
  downloadJson(
    `${safeFilename(title)}-${suffix}.excalidraw.json`,
    snapshot.request,
  );

// Exports the retained pre-merge scene as a standard Excalidraw file so an
// overridden offline edit stays recoverable off-device.
const exportOverrideSnapshot = async (
  store: OverrideSnapshotSource,
  title: string,
  userId: string,
  drawingId: string,
) => {
  const record = await store.get(userId, drawingId);
  if (!record) return;
  downloadJson(`${safeFilename(title)}-recovered.excalidraw`, {
    appState: record.appState,
    elements: record.elements,
    files: record.files,
    source: "https://open-excalidraw.local",
    type: "excalidraw",
    version: 2,
  } satisfies OverrideExcalidrawFile);
};

interface OverrideExcalidrawFile {
  appState: OverrideSnapshotRecord["appState"];
  elements: OverrideSnapshotRecord["elements"];
  files: OverrideSnapshotRecord["files"];
  source: string;
  type: "excalidraw";
  version: 2;
}

const downloadJson = (filename: string, data: unknown) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.download = filename;
  anchor.href = url;
  anchor.click();
  URL.revokeObjectURL(url);
};

const safeFilename = (title: string) =>
  title
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "drawing";

const toError = (caught: unknown, fallback: string) =>
  caught instanceof Error ? caught : new Error(fallback);

const toInitialData = (content: LoadedContent): ExcalidrawInitialDataState => ({
  appState: content.content.scene.appState,
  elements: content.content.scene
    .elements as unknown as ExcalidrawInitialDataState["elements"],
});

const toAcknowledgedContent = (content: LoadedContent): LoadedContent => {
  const initialData = toInitialData(content);
  const request = projectSaveRequest(
    initialData.elements ?? [],
    content.content.scene.appState as never,
    content.content.assetIds,
  );
  return {
    ...content,
    content: {
      ...content.content,
      assetIds: request.assetIds,
      scene: request.scene,
    },
  };
};

// A network-level failure (offline, fetch rejection) is not an HTTP response;
// the API clients only raise these typed errors for real 4xx/5xx responses.
const isHttpProblem = (caught: unknown): boolean =>
  caught instanceof ApiError || caught instanceof ContentRequestError;

// A drawing minted offline does not exist on the server yet. Opening it online
// must create it FIRST (a plain load would 404). Success clears the marker; a
// 409 (id taken by another account) or any HTTP problem propagates to the load
// error state without touching local data; a network failure just falls
// through to the normal load, whose offline fallback opens the local copy.
// Returns whether a pending-create marker still stands afterwards, i.e. the
// drawing has not synced yet and sharing must stay gated.
const createPendingBeforeLoad = async (
  connectivity: ConnectivitySource,
  pendingCreates: PendingCreateSource,
  createDrawing: DrawingCreateSource,
  userId: string,
  drawingId: string,
): Promise<boolean> => {
  let marker;
  try {
    marker = await pendingCreates.get(userId, drawingId);
  } catch {
    return false;
  }
  if (!marker) {
    return false;
  }
  if (connectivity.getSnapshot() !== "online") {
    // Offline: the drawing cannot sync yet, so the marker stands.
    return true;
  }
  try {
    // v1: the server holds an empty scene until this page's collaboration
    // reconnect rebases the offline edits back onto it.
    await createDrawing.createDrawing(marker.title, drawingId);
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    // Network failure: leave the marker and let the normal load fall back to
    // the local copy.
    return true;
  }
  await pendingCreates.remove(userId, drawingId).catch(() => undefined);
  return false;
};

const loadLocalWorkspace = async (
  recovery: RecoverySource,
  outbox: OutboxSource,
  userId: string,
  drawingId: string,
): Promise<{
  content: LoadedContent;
  drawing: DrawingSummary;
  files: BinaryFiles;
} | null> => {
  const snapshot = await recovery.get(userId, drawingId);
  // Need both the scene snapshot and the cached summary to open the page.
  if (!snapshot?.metadata) {
    return null;
  }
  const pending = await outbox.list(userId, drawingId);
  return {
    content: mergeLocalContent(snapshot, pending),
    drawing: snapshot.metadata,
    // Locally stored image blobs, later outbox records winning per fileId —
    // the same precedence mergeLocalContent applies to elements.
    files: pending.reduce<BinaryFiles>(
      (merged, record) => Object.assign(merged, record.files),
      { ...snapshot.files },
    ),
  };
};

// Folds pending offline mutations into the recovery snapshot the same way the
// collaboration controller rebases them on reconnect: reconcile in generation
// order (the outbox already sorts), last shared-scene-state wins.
const mergeLocalContent = (
  snapshot: CloudRecoveryRecord,
  pending: readonly CloudOutboxRecord[],
): LoadedContent => {
  let elements: ExcalidrawElementDTO[] = snapshot.scene.elements;
  let sharedSceneState: CloudOutboxRecord["sharedSceneState"];
  for (const record of pending) {
    elements = reconcileClientElements(elements, record.elements);
    if (record.sharedSceneState) {
      sharedSceneState = record.sharedSceneState;
    }
  }
  const appState = sharedSceneState
    ? { ...snapshot.scene.appState, ...sharedSceneState }
    : snapshot.scene.appState;
  return {
    content: {
      assetIds: snapshot.assetIds,
      revision: snapshot.revision,
      savedAt: snapshot.updatedAt,
      scene: { ...snapshot.scene, appState, elements },
    },
    revision: snapshot.revision,
  };
};
