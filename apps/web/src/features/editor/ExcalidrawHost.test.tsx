import "../../shared/test/excalidraw-dom";

import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { render, waitFor } from "@testing-library/react";

import { ExcalidrawHost } from "./ExcalidrawHost";

describe("ExcalidrawHost", () => {
  it("mounts the real Excalidraw package in a full-height host", async () => {
    const { container } = render(
      <div style={{ height: "640px" }}>
        <ExcalidrawHost title="Architecture" />
      </div>,
    );

    const host = container.querySelector<HTMLElement>(".excalidraw-host");
    expect(host).toBeInTheDocument();
    await waitFor(() =>
      expect(container.querySelector(".excalidraw")).toBeInTheDocument(),
    );
    expect(getComputedStyle(host!).height).toBe("100%");
    expect(getComputedStyle(host!).minHeight).toBe("360px");
  });

  it("loads promise-based initial data and forwards changes", async () => {
    const elements = convertToExcalidrawElements([
      {
        height: 80,
        type: "rectangle",
        width: 120,
        x: 10,
        y: 20,
      },
    ]);
    let resolveInitialData!: (value: { elements: typeof elements }) => void;
    const initialData = new Promise<{ elements: typeof elements }>(
      (resolve) => {
        resolveInitialData = resolve;
      },
    );
    let api: ExcalidrawImperativeAPI | null = null;
    const onChange = vi.fn();

    render(
      <ExcalidrawHost
        initialData={initialData}
        onApiChange={(nextApi) => {
          api = nextApi;
        }}
        onChange={onChange}
        title="Async canvas"
      />,
    );

    resolveInitialData({ elements });

    await waitFor(() => {
      expect(api).not.toBeNull();
      expect(api!.getSceneElements()).toHaveLength(1);
    });
    expect(onChange).toHaveBeenCalled();
  });

  it("invalidates the captured API on unmount and reflects viewer mode", async () => {
    const apiChanges: Array<ExcalidrawImperativeAPI | null> = [];
    const { container, rerender, unmount } = render(
      <ExcalidrawHost
        onApiChange={(api) => apiChanges.push(api)}
        readOnly
        title="Shared canvas"
      />,
    );

    await waitFor(() => expect(apiChanges.some(Boolean)).toBe(true));
    expect(container.querySelector(".excalidraw-host")).toHaveAttribute(
      "data-read-only",
      "true",
    );
    const api = apiChanges.find(
      (candidate): candidate is ExcalidrawImperativeAPI => candidate !== null,
    )!;
    expect(api.getAppState().viewModeEnabled).toBe(true);

    rerender(
      <ExcalidrawHost
        onApiChange={(nextApi) => apiChanges.push(nextApi)}
        readOnly
        title="Renamed canvas"
      />,
    );

    await waitFor(() => expect(api.getName()).toBe("Renamed canvas"));
    expect(
      container.querySelector('[aria-label="Renamed canvas drawing canvas"]'),
    ).toBeInTheDocument();

    unmount();

    expect(apiChanges.at(-1)).toBeNull();
  });
});
