import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import {
  type DrawingSummary,
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
  ExcalidrawHost,
  type ExcalidrawChangeHandler,
  type ExcalidrawHostProps,
} from "../editor";
import {
  AutosaveController,
  CloudRecoveryRepository,
  ConflictRecoveryBanner,
  ContentClient,
  createRecoveryWriter,
  projectSaveRequest,
  type AutosaveControllerOptions,
  type AutosaveSnapshot,
  type AutosaveState,
  type LoadedContent,
} from "../persistence";

import { DrawingMetadataClient, type DrawingMetadataSource } from "./api";

import "./workspace.css";

type ContentSource = Pick<ContentClient, "load" | "save">;
type AssetSource = Pick<AssetClient, "download" | "upload">;
type RecoverySource = Pick<CloudRecoveryRepository, "put">;
type UpdateSceneData = Parameters<ExcalidrawImperativeAPI["updateScene"]>[0];

export interface DrawingWorkspaceDependencies {
  assets?: AssetSource;
  connectivity?: ConnectivitySource;
  content?: ContentSource;
  createAutosave?: (options: AutosaveControllerOptions) => AutosaveController;
  host?: ComponentType<ExcalidrawHostProps>;
  hydrate?: typeof hydrateAssets;
  metadata?: DrawingMetadataSource;
  recovery?: RecoverySource;
}

export interface DrawingPageProps {
  autosaveDebounceMs?: number;
  dependencies?: DrawingWorkspaceDependencies;
  drawingId: string;
  onCreatePrivateCopy?: (drawingId: string, snapshot: AutosaveSnapshot) => void;
  onExportLocal?: (drawingId: string, snapshot: AutosaveSnapshot) => void;
  userId: string;
}

interface WorkspaceLoad {
  content: LoadedContent;
  drawing: DrawingSummary;
  drawingId: string;
  initialData: ExcalidrawInitialDataState;
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

export const DrawingPage = ({
  autosaveDebounceMs,
  dependencies,
  drawingId,
  onCreatePrivateCopy,
  onExportLocal,
  userId,
}: DrawingPageProps) => {
  const [ownedDefaults] = useState(() => ({
    assets: new AssetClient(),
    content: new ContentClient(),
    metadata: new DrawingMetadataClient(),
    recovery: new CloudRecoveryRepository(),
  }));

  const resolved = useMemo(
    () => ({
      assets: dependencies?.assets ?? ownedDefaults.assets,
      connectivity: dependencies?.connectivity ?? browserConnectivity,
      content: dependencies?.content ?? ownedDefaults.content,
      createAutosave:
        dependencies?.createAutosave ??
        ((options: AutosaveControllerOptions) =>
          new AutosaveController(options)),
      hydrate: dependencies?.hydrate ?? hydrateAssets,
      Host: dependencies?.host ?? ExcalidrawHost,
      metadata: dependencies?.metadata ?? ownedDefaults.metadata,
      recovery: dependencies?.recovery ?? ownedDefaults.recovery,
    }),
    [dependencies, ownedDefaults],
  );
  const connectivity = useConnectivity(resolved.connectivity);
  const [load, setLoad] = useState<WorkspaceLoad | null>(null);
  const [loadError, setLoadError] = useState<WorkspaceLoadError | null>(null);
  const [conflictLoadError, setConflictLoadError] = useState<Error | null>(
    null,
  );
  const [loadGeneration, setLoadGeneration] = useState(0);
  const [controller, setController] = useState<AutosaveController | null>(null);
  const [autosave, setAutosave] = useState<AutosaveState>(EMPTY_AUTOSAVE_STATE);
  const [editorApi, setEditorApi] = useState<ExcalidrawImperativeAPI | null>(
    null,
  );
  const [assetFailures, setAssetFailures] = useState<
    ReadonlyMap<string, Error>
  >(new Map());
  const hydrationGeneration = useRef(0);
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
      }
    });

    void Promise.all([
      resolved.metadata.load(drawingId),
      resolved.content.load(drawingId),
    ])
      .then(([drawing, content]) => {
        if (!active) {
          return;
        }

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
          initialData: toInitialData(content),
          userId,
        });
      })
      .catch((caught: unknown) => {
        if (active) {
          setLoadError({
            drawingId,
            error: toError(caught, "Could not open this drawing."),
            userId,
          });
        }
      });

    return () => {
      active = false;
      unsubscribe();
      activeController?.dispose();
    };
  }, [autosaveDebounceMs, drawingId, loadGeneration, resolved, userId]);

  useEffect(() => {
    if (
      !editorApi ||
      !workspace ||
      workspace.content.content.assetIds.length === 0
    ) {
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
      .hydrate(
        editorApi,
        resolved.assets,
        drawingId,
        workspace.content.content.assetIds,
        abort.signal,
      )
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
  }, [drawingId, editorApi, resolved, workspace]);

  useEffect(
    () => () => {
      hydrationGeneration.current += 1;
      if (!dependencies?.recovery) {
        void ownedDefaults.recovery.close();
      }
    },
    [dependencies?.recovery, ownedDefaults],
  );

  const onChange = useCallback<ExcalidrawChangeHandler>(
    (elements, appState, files) => {
      if (!controller || !workspace) {
        return;
      }
      const capabilities = getDrawingCapabilities(workspace.drawing.role);
      if (!capabilities.editScene || !capabilities.uploadAssets) {
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
    [controller, workspace],
  );

  const reloadServer = useCallback(
    (server: LoadedContent) => {
      controller?.acceptServer(toAcknowledgedContent(server));
      setConflictLoadError(null);
      setLoad((current) =>
        current && current.drawingId === drawingId && current.userId === userId
          ? { ...current, content: server, initialData: toInitialData(server) }
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

  const capabilities = getDrawingCapabilities(workspace.drawing.role);
  const conflictSnapshot = autosave.conflict?.local;
  const actionableSnapshot = conflictSnapshot;
  const WorkspaceHost = resolved.Host;

  return (
    <main className="drawing-workspace">
      <header className="workspace-header">
        <div>
          <h1>{workspace.drawing.title}</h1>
          <span className="workspace-role">{workspace.drawing.role}</span>
        </div>
        <span
          aria-live="polite"
          className="workspace-save-status"
          role="status"
        >
          {saveStatusLabel(connectivity, capabilities.editScene, autosave)}
        </span>
      </header>

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

      <div className="workspace-editor">
        <WorkspaceHost
          key={drawingId}
          initialData={workspace.initialData}
          onApiChange={setEditorApi}
          onChange={capabilities.editScene ? onChange : undefined}
          readOnly={!capabilities.editScene}
          title={workspace.drawing.title}
        />
      </div>
    </main>
  );
};

const saveStatusLabel = (
  connectivity: "online" | "offline",
  canEdit: boolean,
  autosave: AutosaveState,
): string => {
  if (!canEdit) {
    return "View only";
  }
  if (connectivity === "offline") {
    return "Offline — changes are kept in local recovery";
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

const exportSnapshot = (
  title: string,
  snapshot: { request: SaveContentRequest; files?: unknown },
  suffix: string,
) => {
  const blob = new Blob([JSON.stringify(snapshot.request, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.download = `${safeFilename(title)}-${suffix}.excalidraw.json`;
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
