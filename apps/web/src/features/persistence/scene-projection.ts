import type {
  AppState,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type {
  SaveContentRequest,
  SceneEnvelope,
} from "@open-excalidraw/contracts";

const SCENE_SOURCE = "https://open-excalidraw.local";
const SCENE_VERSION = 2;

type PersistedAppState = SceneEnvelope["appState"];

/**
 * Only document-level app state belongs in the canonical scene. Viewport,
 * selection, tool, dialog and collaborator state are deliberately excluded.
 */
export const projectSceneAppState = (appState: AppState): PersistedAppState =>
  cleanJson({
    gridSize: appState.gridSize,
    gridStep: appState.gridStep,
    viewBackgroundColor: appState.viewBackgroundColor,
  });

/** Produces a JSON-safe server envelope while retaining deleted tombstones. */
export const projectScene = (
  elements: NonNullable<ExcalidrawInitialDataState["elements"]>,
  appState: AppState,
): SceneEnvelope => ({
  appState: projectSceneAppState(appState),
  elements: cleanJson(elements) as unknown as SceneEnvelope["elements"],
  source: SCENE_SOURCE,
  type: "excalidraw",
  version: SCENE_VERSION,
});

export const projectSaveRequest = (
  elements: NonNullable<ExcalidrawInitialDataState["elements"]>,
  appState: AppState,
  assetIds: readonly string[],
): SaveContentRequest => ({
  assetIds: [...new Set(assetIds)].sort(),
  scene: projectScene(elements, appState),
});

export const sceneFingerprint = (request: SaveContentRequest): string =>
  JSON.stringify(request);

const cleanJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
