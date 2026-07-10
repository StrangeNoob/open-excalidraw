import type {
  AppState,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";

import { projectSaveRequest, sceneFingerprint } from "./scene-projection";

const element = (isDeleted = false) =>
  ({
    id: "element-1",
    index: "a0",
    isDeleted,
    type: "rectangle",
    version: 2,
    versionNonce: 10,
  }) as unknown as NonNullable<ExcalidrawInitialDataState["elements"]>[number];

const appState = (selectedElementIds: Record<string, true>) =>
  ({
    activeTool: { type: "rectangle" },
    gridSize: null,
    gridStep: 5,
    openDialog: null,
    scrollX: 100,
    scrollY: 200,
    selectedElementIds,
    viewBackgroundColor: "#ffffff",
    zoom: { value: 2 },
  }) as unknown as AppState;

describe("scene projection", () => {
  it("does not dirty canonical content for transient app-state changes", () => {
    const first = projectSaveRequest([element()], appState({}), []);
    const second = projectSaveRequest(
      [element()],
      appState({ "element-1": true }),
      [],
    );

    expect(sceneFingerprint(first)).toBe(sceneFingerprint(second));
    expect(first.scene.appState).toEqual({
      gridSize: null,
      gridStep: 5,
      viewBackgroundColor: "#ffffff",
    });
  });

  it("retains deleted elements as convergence tombstones", () => {
    const request = projectSaveRequest([element(true)], appState({}), []);
    expect(request.scene.elements).toEqual([
      expect.objectContaining({ id: "element-1", isDeleted: true }),
    ]);
  });
});
