import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  DataURL,
} from "@excalidraw/excalidraw/types";
import { act, renderHook, waitFor } from "@testing-library/react";

import type { ExcalidrawChangeHandler } from "../../editor";
import { useGuestCanvas, type GuestCanvasRepository } from "./useGuestCanvas";

const file: BinaryFileData = {
  created: 1,
  dataURL: "data:image/png;base64,AA==" as DataURL,
  id: "local-image" as BinaryFileData["id"],
  mimeType: "image/png",
};

const initialFiles: BinaryFiles = { [file.id]: file };

const createAppState = (viewBackgroundColor = "#ffffff") =>
  ({
    gridModeEnabled: false,
    gridSize: null,
    gridStep: 5,
    name: "Local canvas",
    theme: "light",
    viewBackgroundColor,
  }) as unknown as AppState;

describe("useGuestCanvas", () => {
  it("restores local scene/assets, debounces snapshots, and performs no network activity", async () => {
    const fetch = vi.fn();
    const WebSocket = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("WebSocket", WebSocket);
    const repository: GuestCanvasRepository = {
      loadInitialData: vi.fn().mockResolvedValue({
        elements: [],
        files: initialFiles,
      }),
      saveSnapshot: vi.fn().mockResolvedValue({
        assetIds: [file.id],
        drawingId: "default",
        revision: 1,
        scene: { elements: [] },
        title: "Local canvas",
        updatedAt: "2026-07-10T10:00:00.000Z",
      }),
    };
    const { result } = renderHook(() =>
      useGuestCanvas({
        repository,
        saveDelayMs: 0,
        title: "Local canvas",
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.initialData).toMatchObject({
      elements: [],
      files: initialFiles,
    });

    const onChange = result.current.onChange;
    const appState = createAppState();
    act(() => {
      onChange([], appState, initialFiles);
      onChange([], appState, initialFiles);
    });

    await waitFor(() => expect(repository.saveSnapshot).toHaveBeenCalledOnce());
    expect(repository.saveSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        drawingId: "default",
        files: initialFiles,
        scene: expect.objectContaining({ elements: [] }),
        title: "Local canvas",
      }),
    );
    expect(result.current.status).toBe("saved");
    expect(fetch).not.toHaveBeenCalled();
    expect(WebSocket).not.toHaveBeenCalled();
  });

  it("flushes the newest pending snapshot when the guest page unmounts", async () => {
    const repository: GuestCanvasRepository = {
      loadInitialData: vi.fn().mockResolvedValue(null),
      saveSnapshot: vi.fn().mockResolvedValue({}),
    };
    const { result, unmount } = renderHook(() =>
      useGuestCanvas({ repository, saveDelayMs: 60_000 }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.onChange(
        [],
        {
          gridModeEnabled: false,
          gridSize: null,
          gridStep: 5,
          name: "Untitled drawing",
          theme: "light",
          viewBackgroundColor: "#ffffff",
        } as unknown as Parameters<ExcalidrawChangeHandler>[1],
        {},
      );
      unmount();
    });

    await waitFor(() => expect(repository.saveSnapshot).toHaveBeenCalledOnce());
  });

  it("automatically retries the same pending snapshot after a save failure", async () => {
    const saveSnapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error("IndexedDB unavailable"))
      .mockResolvedValueOnce({});
    const repository: GuestCanvasRepository = {
      loadInitialData: vi.fn().mockResolvedValue(null),
      saveSnapshot,
    };
    const { result } = renderHook(() =>
      useGuestCanvas({ repository, saveDelayMs: 0 }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() =>
      result.current.onChange([], createAppState("#ffeecc"), initialFiles),
    );

    await waitFor(() => expect(saveSnapshot).toHaveBeenCalledTimes(2));
    expect(saveSnapshot.mock.calls[1]?.[0]).toEqual(
      saveSnapshot.mock.calls[0]?.[0],
    );
    await waitFor(() => expect(result.current.status).toBe("saved"));
  });

  it("does not replace a newer pending snapshot when an older save fails", async () => {
    let rejectFirstSave!: (error: Error) => void;
    const saveSnapshot = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirstSave = reject;
          }),
      )
      .mockResolvedValueOnce({});
    const repository: GuestCanvasRepository = {
      loadInitialData: vi.fn().mockResolvedValue(null),
      saveSnapshot,
    };
    const { result } = renderHook(() =>
      useGuestCanvas({ repository, saveDelayMs: 60_000 }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.onChange([], createAppState("#ffffff"), {}));
    act(() => {
      void result.current.flush();
    });
    await waitFor(() => expect(saveSnapshot).toHaveBeenCalledOnce());

    act(() =>
      result.current.onChange([], createAppState("#000000"), initialFiles),
    );
    act(() => rejectFirstSave(new Error("First save failed")));
    await waitFor(() => expect(result.current.status).toBe("error"));
    act(() => {
      void result.current.flush();
    });

    await waitFor(() => expect(saveSnapshot).toHaveBeenCalledTimes(2));
    expect(saveSnapshot.mock.calls[1]?.[0]).toMatchObject({
      files: initialFiles,
      scene: { appState: { viewBackgroundColor: "#000000" }, elements: [] },
    });
    await waitFor(() => expect(result.current.status).toBe("saved"));
  });
});
