import "../../shared/test/excalidraw-dom";

import type {
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { DrawingSummary } from "@open-excalidraw/contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";

import type { ExcalidrawHostProps } from "../editor";
import {
  ContentRequestError,
  VersionConflictError,
  type LoadedContent,
} from "../persistence";

import { DrawingPage, type DrawingWorkspaceDependencies } from "./DrawingPage";

const DRAWING_A = "00000000-0000-4000-8000-000000000001";
const DRAWING_B = "00000000-0000-4000-8000-000000000002";
const USER = "10000000-0000-4000-8000-000000000001";

const apiAddFiles = vi.fn();
const apiUpdateScene = vi.fn();
const editorApi = {
  addFiles: apiAddFiles,
  updateScene: apiUpdateScene,
} as unknown as ExcalidrawImperativeAPI;

const element = (version: number, fileId?: string) => ({
  ...(fileId ? { fileId } : {}),
  id: "element",
  isDeleted: false,
  type: fileId ? "image" : "rectangle",
  version,
  versionNonce: version,
});

const appState = {
  gridSize: null,
  gridStep: 5,
  viewBackgroundColor: "#ffffff",
};

const TestHost = (props: ExcalidrawHostProps) => {
  const { initialData, onApiChange, onChange, readOnly } = props;
  const initial = initialData as ExcalidrawInitialDataState;

  useEffect(() => {
    onApiChange?.(editorApi);
    return () => onApiChange?.(null);
  }, [onApiChange]);

  useEffect(() => {
    onChange?.(
      (initial.elements ?? []) as never,
      (initial.appState ?? appState) as never,
      {},
    );
  }, [initial, onChange]);

  return (
    <section data-testid="test-host" data-viewer={String(readOnly)}>
      {onChange ? (
        <button
          onClick={() =>
            onChange([element(2, "image_1")] as never, appState as never, {
              image_1: imageFile("image_1"),
            })
          }
          type="button"
        >
          Make edit
        </button>
      ) : null}
    </section>
  );
};

const drawing = (
  id: string,
  title: string,
  role: DrawingSummary["role"] = "owner",
): DrawingSummary => ({
  contentRevision: "3",
  createdAt: "2026-07-11T00:00:00.000Z",
  id,
  metadataRevision: "1",
  ownerName: "Ada",
  ownerUserId: USER,
  role,
  title,
  updatedAt: "2026-07-11T00:00:00.000Z",
});

const loaded = (
  revision = "3",
  assetIds: string[] = [],
  version = 1,
): LoadedContent => ({
  content: {
    assetIds,
    revision,
    savedAt: "2026-07-11T00:00:00.000Z",
    scene: {
      appState,
      elements: [element(version)],
      source: "test",
      type: "excalidraw",
      version: 2,
    },
  },
  revision,
});

const imageFile = (id: string): BinaryFileData => ({
  created: 1,
  dataURL: "data:image/png;base64,AA==" as DataURL,
  id: id as BinaryFileData["id"],
  mimeType: "image/png",
});

const online = {
  getSnapshot: () => "online" as const,
  subscribe: () => () => undefined,
};

const createDependencies = (options?: {
  assetIds?: string[];
  contentLoad?: () => Promise<LoadedContent>;
  role?: DrawingSummary["role"];
  title?: string;
}) => {
  const order: string[] = [];
  const content = {
    load: vi.fn(
      options?.contentLoad ??
        (() => Promise.resolve(loaded("3", options?.assetIds))),
    ),
    save: vi.fn(() => {
      order.push("save");
      return Promise.resolve({
        revision: "4",
        savedAt: "2026-07-11T00:01:00.000Z",
      });
    }),
  };
  const assets = {
    download: vi.fn(() => Promise.resolve(imageFile("image_1"))),
    upload: vi.fn(() => {
      order.push("upload");
      return Promise.resolve({} as never);
    }),
  };
  const metadata = {
    load: vi.fn((id: string) =>
      Promise.resolve(
        drawing(id, options?.title ?? "Architecture", options?.role),
      ),
    ),
  };
  const recovery = { put: vi.fn(() => Promise.resolve({} as never)) };

  return {
    dependencies: {
      assets,
      connectivity: online,
      content,
      host: TestHost,
      metadata,
      recovery,
    } satisfies DrawingWorkspaceDependencies,
    order,
    sources: { assets, content, metadata, recovery },
  };
};

describe("DrawingPage", () => {
  beforeEach(() => {
    apiAddFiles.mockReset();
    apiUpdateScene.mockReset();
  });

  it("loads canonical content, ignores the initial editor event, then uploads before an ETag save", async () => {
    const user = userEvent.setup();
    const fixture = createDependencies();
    render(
      <DrawingPage
        autosaveDebounceMs={1}
        dependencies={fixture.dependencies}
        drawingId={DRAWING_A}
        userId={USER}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Architecture" }),
    ).toBeVisible();
    expect(screen.getByText("Saved")).toBeVisible();
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(fixture.sources.content.save).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Make edit" }));
    await waitFor(() =>
      expect(fixture.sources.content.save).toHaveBeenCalled(),
    );

    expect(fixture.order).toEqual(["upload", "save"]);
    expect(fixture.sources.content.save).toHaveBeenCalledWith(
      DRAWING_A,
      expect.objectContaining({ assetIds: ["image_1"] }),
      "3",
      expect.any(String),
    );
    expect(fixture.sources.recovery.put).toHaveBeenCalledWith(
      USER,
      DRAWING_A,
      "3",
      expect.any(Object),
      expect.any(Object),
    );
    expect(await screen.findByText("Saved")).toBeVisible();
  });

  it("renders viewers read-only without autosave or upload emission", async () => {
    const fixture = createDependencies({ role: "viewer" });
    render(
      <DrawingPage
        autosaveDebounceMs={1}
        dependencies={fixture.dependencies}
        drawingId={DRAWING_A}
        userId={USER}
      />,
    );

    expect(
      await screen.findByRole("status", { name: "View-only access" }),
    ).toBeVisible();
    expect(screen.getByTestId("test-host")).toHaveAttribute(
      "data-viewer",
      "true",
    );
    expect(screen.queryByRole("button", { name: "Make edit" })).toBeNull();
    expect(fixture.sources.content.save).not.toHaveBeenCalled();
    expect(fixture.sources.assets.upload).not.toHaveBeenCalled();
    expect(fixture.sources.recovery.put).not.toHaveBeenCalled();
  });

  it("isolates stale drawing loads when the drawing ID changes", async () => {
    let resolveOld!: (value: LoadedContent) => void;
    const oldContent = new Promise<LoadedContent>((resolve) => {
      resolveOld = resolve;
    });
    const fixture = createDependencies({
      contentLoad: vi
        .fn()
        .mockImplementationOnce(() => oldContent)
        .mockResolvedValueOnce(loaded("8", [], 8)),
    });
    fixture.sources.metadata.load
      .mockResolvedValueOnce(drawing(DRAWING_A, "Old drawing"))
      .mockResolvedValueOnce(drawing(DRAWING_B, "Current drawing"));

    const view = render(
      <DrawingPage
        dependencies={fixture.dependencies}
        drawingId={DRAWING_A}
        userId={USER}
      />,
    );
    view.rerender(
      <DrawingPage
        dependencies={fixture.dependencies}
        drawingId={DRAWING_B}
        userId={USER}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Current drawing" }),
    ).toBeVisible();
    await act(async () => {
      resolveOld(loaded("3"));
      await Promise.resolve();
    });
    expect(screen.queryByText("Old drawing")).toBeNull();
  });

  it("aborts stale asset hydration across drawing changes", async () => {
    let resolveOldAsset!: (value: BinaryFileData) => void;
    const oldAsset = new Promise<BinaryFileData>((resolve) => {
      resolveOldAsset = resolve;
    });
    const fixture = createDependencies({ assetIds: ["old_asset"] });
    fixture.sources.assets.download.mockImplementationOnce(() => oldAsset);
    fixture.sources.content.load
      .mockResolvedValueOnce(loaded("3", ["old_asset"]))
      .mockResolvedValueOnce(loaded("1", []));
    fixture.sources.metadata.load
      .mockResolvedValueOnce(drawing(DRAWING_A, "Old drawing"))
      .mockResolvedValueOnce(drawing(DRAWING_B, "Current drawing"));

    const view = render(
      <DrawingPage
        dependencies={fixture.dependencies}
        drawingId={DRAWING_A}
        userId={USER}
      />,
    );
    await waitFor(() =>
      expect(fixture.sources.assets.download).toHaveBeenCalled(),
    );
    view.rerender(
      <DrawingPage
        dependencies={fixture.dependencies}
        drawingId={DRAWING_B}
        userId={USER}
      />,
    );
    await screen.findByRole("heading", { name: "Current drawing" });
    await act(async () => {
      resolveOldAsset(imageFile("old_asset"));
      await Promise.resolve();
    });

    expect(apiAddFiles).not.toHaveBeenCalled();
  });

  it("offers safe conflict actions and can reload the canonical server scene", async () => {
    const user = userEvent.setup();
    const server = loaded("9", [], 9);
    const fixture = createDependencies();
    fixture.sources.content.save.mockRejectedValueOnce(
      new VersionConflictError(null, "3", null),
    );
    fixture.sources.content.load
      .mockResolvedValueOnce(loaded("3"))
      .mockResolvedValueOnce(server);
    const onExportLocal = vi.fn();
    const onCreatePrivateCopy = vi.fn();
    render(
      <DrawingPage
        autosaveDebounceMs={1}
        dependencies={fixture.dependencies}
        drawingId={DRAWING_A}
        onCreatePrivateCopy={onCreatePrivateCopy}
        onExportLocal={onExportLocal}
        userId={USER}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Make edit" }));
    expect(
      await screen.findByRole("alert", { name: "Save conflict" }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Export local drawing" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Save as a new private drawing" }),
    );
    expect(onExportLocal).toHaveBeenCalledWith(DRAWING_A, expect.any(Object));
    expect(onCreatePrivateCopy).toHaveBeenCalledWith(
      DRAWING_A,
      expect.any(Object),
    );

    await user.click(
      screen.getByRole("button", {
        name: "Try loading the server version again",
      }),
    );
    const reload = screen.getByRole("button", {
      name: "Reload server version",
    });
    await waitFor(() => expect(reload).toBeEnabled());
    await user.click(reload);
    expect(apiUpdateScene).toHaveBeenCalledWith(
      expect.objectContaining({ elements: server.content.scene.elements }),
    );
    expect(screen.queryByRole("alert", { name: "Save conflict" })).toBeNull();
  });

  it("surfaces terminal save errors and retries the retained local snapshot", async () => {
    const user = userEvent.setup();
    const fixture = createDependencies();
    fixture.sources.content.save
      .mockRejectedValueOnce(new ContentRequestError(422, null))
      .mockResolvedValueOnce({
        revision: "4",
        savedAt: "2026-07-11T00:01:00.000Z",
      });
    render(
      <DrawingPage
        autosaveDebounceMs={1}
        dependencies={fixture.dependencies}
        drawingId={DRAWING_A}
        userId={USER}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Make edit" }));
    expect(
      await screen.findByText("Changes could not be saved."),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() =>
      expect(fixture.sources.content.save).toHaveBeenCalledTimes(2),
    );
    expect(await screen.findByText("Saved")).toBeVisible();
  });
});
