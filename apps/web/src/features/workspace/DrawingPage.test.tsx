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
import { effectiveWorkspaceRole } from "./access-state";
import { restoreWithRealtimeBoundary } from "./restore-boundary";

const DRAWING_A = "00000000-0000-4000-8000-000000000001";
const DRAWING_B = "00000000-0000-4000-8000-000000000002";
const USER = "10000000-0000-4000-8000-000000000001";

const apiAddFiles = vi.fn();
const apiUpdateScene = vi.fn();
const editorApi = {
  addFiles: apiAddFiles,
  updateScene: apiUpdateScene,
  getAppState: () => appState,
  getFiles: () => ({}),
  getSceneElementsIncludingDeleted: () => [],
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

/**
 * Stands in for the real host: it renders the title and the top-right UI the
 * way Excalidraw does, so tests still see the workspace's own chrome. The
 * children (MainMenu) need Excalidraw's context and are not rendered here.
 */
const TestHost = (props: ExcalidrawHostProps) => {
  const { initialData, onApiChange, onChange, readOnly, renderTopRightUI } =
    props;
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
      <h1>{props.title}</h1>
      {renderTopRightUI?.(false, {} as never)}
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
  tags: [],
  thumbnailUpdatedAt: null,
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
    deleteThumbnail: vi.fn(() => Promise.resolve()),
    download: vi.fn(() => Promise.resolve(imageFile("image_1"))),
    upload: vi.fn(() => {
      order.push("upload");
      return Promise.resolve({} as never);
    }),
    uploadThumbnail: vi.fn(() => Promise.resolve()),
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

  it("does not fall back to a stale workspace role after membership revocation", () => {
    expect(
      effectiveWorkspaceRole("editor", null, "SOCKET_MEMBERSHIP_REVOKED"),
    ).toBeNull();
    expect(effectiveWorkspaceRole("editor", null, undefined)).toBe("editor");
  });

  it.each([
    ["owner", true],
    ["editor", false],
    ["viewer", false],
  ] as const)(
    "exposes sharing controls for the %s role: %s",
    async (role, canShare) => {
      const fixture = createDependencies({ role });
      render(
        <DrawingPage
          collaborationEnabled={false}
          dependencies={fixture.dependencies}
          drawingId={DRAWING_A}
          userId={USER}
        />,
      );

      await screen.findByRole("heading", { name: "Architecture" });
      expect(screen.queryByRole("button", { name: "Share" }) !== null).toBe(
        canShare,
      );
      expect(screen.getByRole("button", { name: "History" })).toBeVisible();
    },
  );

  it("loads canonical content, ignores the initial editor event, then uploads before an ETag save", async () => {
    const user = userEvent.setup();
    const fixture = createDependencies();
    render(
      <DrawingPage
        autosaveDebounceMs={1}
        collaborationEnabled={false}
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
        collaborationEnabled={false}
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
        collaborationEnabled={false}
        drawingId={DRAWING_A}
        userId={USER}
      />,
    );
    view.rerender(
      <DrawingPage
        dependencies={fixture.dependencies}
        collaborationEnabled={false}
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
        collaborationEnabled={false}
        drawingId={DRAWING_A}
        userId={USER}
      />,
    );
    await waitFor(() =>
      expect(fixture.sources.assets.download).toHaveBeenCalled(),
    );
    view.rerender(
      <DrawingPage
        collaborationEnabled={false}
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
        collaborationEnabled={false}
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
        collaborationEnabled={false}
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

  it("pauses and drains realtime before REST restore and stops it after success", async () => {
    const order: string[] = [];
    const realtime = {
      pauseWrites: vi.fn(() => {
        order.push("pause");
        return Promise.resolve();
      }),
      resumeWrites: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => {
        order.push("stop");
        return Promise.resolve();
      }),
    };
    const restored = await restoreWithRealtimeBoundary({
      autosave: {
        flush: vi.fn(() => {
          order.push("autosave-flush");
          return Promise.resolve();
        }),
      },
      drawingId: DRAWING_A,
      outbox: {
        list: vi.fn(() => {
          order.push("drain");
          return Promise.resolve([]);
        }),
      },
      realtime,
      restore: vi.fn(() => {
        order.push("restore");
        return Promise.resolve({
          revision: "8",
          savedAt: "2026-07-11T00:02:00.000Z",
        });
      }),
      userId: USER,
    });

    expect(restored.revision).toBe("8");
    expect(order).toEqual([
      "autosave-flush",
      "pause",
      "drain",
      "restore",
      "stop",
    ]);
    expect(realtime.resumeWrites).not.toHaveBeenCalled();
  });

  it("resumes realtime cleanly when REST restore fails", async () => {
    const realtime = {
      pauseWrites: vi.fn(() => Promise.resolve()),
      resumeWrites: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
    };

    await expect(
      restoreWithRealtimeBoundary({
        autosave: null,
        drawingId: DRAWING_A,
        outbox: { list: () => Promise.resolve([]) },
        realtime,
        restore: () => Promise.reject(new Error("restore failed")),
        userId: USER,
      }),
    ).rejects.toThrow("restore failed");
    expect(realtime.resumeWrites).toHaveBeenCalledOnce();
    expect(realtime.stop).not.toHaveBeenCalled();
  });

  it("badges the chat button for messages arriving while the panel is closed", async () => {
    const user = userEvent.setup();
    const { dependencies } = createDependencies();
    const chatListeners = new Set<(message: unknown) => void>();
    const fakeTransport = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      emit: vi.fn(),
      setHandlers: vi.fn(),
      onChatMessage: (listener: (message: unknown) => void) => {
        chatListeners.add(listener);
        return () => chatListeners.delete(listener);
      },
    };
    const receive = (body: string, senderId: string) =>
      act(() => {
        for (const listener of [...chatListeners]) {
          listener({
            id: crypto.randomUUID(),
            drawingId: DRAWING_A,
            userId: senderId,
            authorName: "Ada",
            body,
            createdAt: "2026-07-15T00:00:00.000Z",
          });
        }
      });

    const workspaceDependencies = {
      ...dependencies,
      chat: {
        history: vi.fn(() =>
          Promise.resolve({ messages: [], nextCursor: null }),
        ),
      },
      createRealtimeTransport: () => fakeTransport as never,
    };
    const { rerender } = render(
      <DrawingPage
        dependencies={workspaceDependencies}
        drawingId={DRAWING_A}
        userId={USER}
      />,
    );
    await screen.findByRole("button", { name: "Chat" });
    await waitFor(() => expect(chatListeners.size).toBeGreaterThan(0));

    receive("first", "20000000-0000-4000-8000-000000000001");
    receive("second", "20000000-0000-4000-8000-000000000001");
    receive("own message is not unread", USER);

    const badged = await screen.findByRole("button", {
      name: "Chat, 2 unread messages",
    });
    expect(badged).toHaveTextContent("Chat2");

    await user.click(badged);
    expect(
      await screen.findByRole("button", { name: "Chat" }),
    ).not.toHaveTextContent("2");
    await user.click(screen.getByRole("button", { name: "Chat" }));

    receive("while closed again", "20000000-0000-4000-8000-000000000001");
    await screen.findByRole("button", { name: "Chat, 1 unread message" });

    rerender(
      <DrawingPage
        dependencies={workspaceDependencies}
        drawingId={DRAWING_B}
        userId={USER}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Chat" }),
      ).not.toHaveTextContent("1"),
    );
  });

  it("captures on the idle window once, then re-arms threading the last sha", async () => {
    const user = userEvent.setup();
    const capture = vi.fn(() => Promise.resolve("sha-1"));
    const fixture = createDependencies();
    render(
      <DrawingPage
        autosaveDebounceMs={1}
        collaborationEnabled={false}
        dependencies={{ ...fixture.dependencies, captureThumbnail: capture }}
        drawingId={DRAWING_A}
        thumbnailDebounceMs={30}
        userId={USER}
      />,
    );

    // The initial editor event arms the first capture: pre-feature drawings
    // get a thumbnail backfilled on their next open.
    const edit = await screen.findByRole("button", { name: "Make edit" });
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(capture).toHaveBeenCalledWith(
      editorApi,
      DRAWING_A,
      fixture.sources.assets,
      undefined,
    );

    // A fired timer does not re-arm itself without another edit.
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(capture).toHaveBeenCalledTimes(1);

    await user.click(edit);
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
    expect(capture).toHaveBeenLastCalledWith(
      editorApi,
      DRAWING_A,
      fixture.sources.assets,
      "sha-1",
    );
  });

  it("ignores a late capture from a previous drawing", async () => {
    const user = userEvent.setup();
    let resolveFirst!: (sha256: string | null) => void;
    const capture = vi
      .fn<
        (
          api: unknown,
          drawingId: string,
          client: unknown,
          previousSha256?: string | null,
        ) => Promise<string | null>
      >(() => Promise.resolve("sha-b"))
      .mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            resolveFirst = resolve;
          }),
      );
    const fixture = createDependencies();
    const view = render(
      <DrawingPage
        collaborationEnabled={false}
        dependencies={{ ...fixture.dependencies, captureThumbnail: capture }}
        drawingId={DRAWING_A}
        thumbnailDebounceMs={10}
        userId={USER}
      />,
    );
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(1));

    view.rerender(
      <DrawingPage
        collaborationEnabled={false}
        dependencies={{ ...fixture.dependencies, captureThumbnail: capture }}
        drawingId={DRAWING_B}
        thumbnailDebounceMs={10}
        userId={USER}
      />,
    );
    // Drawing B's own first capture starts with unknown server state.
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
    expect(capture.mock.calls[1]?.[1]).toBe(DRAWING_B);
    expect(capture.mock.calls[1]?.[3]).toBeUndefined();

    // Drawing A's capture settles late; its sha must not leak into B.
    await act(async () => {
      resolveFirst("sha-a");
      await Promise.resolve();
    });
    await user.click(await screen.findByRole("button", { name: "Make edit" }));
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(3));
    expect(capture.mock.calls[2]?.[3]).toBe("sha-b");
  });

  it("never lets a failed capture disturb the save status", async () => {
    const user = userEvent.setup();
    const capture = vi.fn(() => Promise.reject(new Error("canvas exploded")));
    const fixture = createDependencies();
    render(
      <DrawingPage
        autosaveDebounceMs={1}
        collaborationEnabled={false}
        dependencies={{ ...fixture.dependencies, captureThumbnail: capture }}
        drawingId={DRAWING_A}
        thumbnailDebounceMs={1}
        userId={USER}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Make edit" }));
    await waitFor(() => expect(capture).toHaveBeenCalled());
    expect(await screen.findByText("Saved")).toBeVisible();
  });

  it("never schedules a capture for viewers", async () => {
    const capture = vi.fn(() => Promise.resolve(null));
    const fixture = createDependencies({ role: "viewer" });
    render(
      <DrawingPage
        collaborationEnabled={false}
        dependencies={{ ...fixture.dependencies, captureThumbnail: capture }}
        drawingId={DRAWING_A}
        thumbnailDebounceMs={1}
        userId={USER}
      />,
    );

    await screen.findByRole("status", { name: "View-only access" });
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(capture).not.toHaveBeenCalled();
  });

  it("cancels a pending capture on unmount", async () => {
    const capture = vi.fn(() => Promise.resolve(null));
    const fixture = createDependencies();
    const view = render(
      <DrawingPage
        collaborationEnabled={false}
        dependencies={{ ...fixture.dependencies, captureThumbnail: capture }}
        drawingId={DRAWING_A}
        thumbnailDebounceMs={20}
        userId={USER}
      />,
    );

    await screen.findByRole("heading", { name: "Architecture" });
    view.unmount();
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(capture).not.toHaveBeenCalled();
  });

  it("flushes a pending capture when the page becomes hidden", async () => {
    const user = userEvent.setup();
    const capture = vi.fn(() => Promise.resolve(null));
    const fixture = createDependencies();
    render(
      <DrawingPage
        collaborationEnabled={false}
        dependencies={{ ...fixture.dependencies, captureThumbnail: capture }}
        drawingId={DRAWING_A}
        thumbnailDebounceMs={60_000}
        userId={USER}
      />,
    );

    // The click arms the 60 s timer; hiding the page must not wait for it.
    await user.click(await screen.findByRole("button", { name: "Make edit" }));
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    visibility.mockRestore();

    expect(capture).toHaveBeenCalledTimes(1);
  });
});
