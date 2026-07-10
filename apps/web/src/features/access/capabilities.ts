import type { Role } from "@open-excalidraw/contracts";

export interface DrawingCapabilities {
  deleteDrawing: boolean;
  editScene: boolean;
  leaveDrawing: boolean;
  manageSharing: boolean;
  readDrawing: boolean;
  renameDrawing: boolean;
  transferOwnership: boolean;
  uploadAssets: boolean;
}

const CAPABILITIES_BY_ROLE = {
  owner: {
    deleteDrawing: true,
    editScene: true,
    leaveDrawing: false,
    manageSharing: true,
    readDrawing: true,
    renameDrawing: true,
    transferOwnership: true,
    uploadAssets: true,
  },
  editor: {
    deleteDrawing: false,
    editScene: true,
    leaveDrawing: true,
    manageSharing: false,
    readDrawing: true,
    renameDrawing: true,
    transferOwnership: false,
    uploadAssets: true,
  },
  viewer: {
    deleteDrawing: false,
    editScene: false,
    leaveDrawing: true,
    manageSharing: false,
    readDrawing: true,
    renameDrawing: false,
    transferOwnership: false,
    uploadAssets: false,
  },
} satisfies Record<Role, DrawingCapabilities>;

export const getDrawingCapabilities = (
  role: Role,
): Readonly<DrawingCapabilities> => CAPABILITIES_BY_ROLE[role];
