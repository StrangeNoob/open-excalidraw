import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";

export const DEFAULT_GUEST_DRAWING_ID = "default";
export const DEFAULT_GUEST_DRAWING_TITLE = "Untitled drawing";

export interface GuestSceneSnapshot {
  appState?: Partial<AppState>;
  elements?: ExcalidrawInitialDataState["elements"];
  scrollToContent?: boolean;
}

export interface GuestSceneRecord {
  assetIds: string[];
  drawingId: string;
  revision: number;
  scene: GuestSceneSnapshot;
  title: string;
  updatedAt: string;
}

export interface GuestAssetRecord extends BinaryFileData {
  drawingId: string;
}

export interface GuestMigrationRecord {
  completedAt: string;
  drawingId: string;
  migratedLocalRevision: number;
  targetCloudDrawingId: string;
  userId: string;
}

export interface CompleteGuestMigrationInput {
  drawingId: string;
  migratedLocalRevision: number;
  targetCloudDrawingId: string;
  userId: string;
}

export interface SaveGuestSceneInput {
  assetIds?: readonly string[];
  drawingId: string;
  scene: GuestSceneSnapshot;
  title: string;
}

export interface SaveGuestSnapshotInput {
  drawingId: string;
  files: BinaryFiles;
  scene: GuestSceneSnapshot;
  title: string;
}
