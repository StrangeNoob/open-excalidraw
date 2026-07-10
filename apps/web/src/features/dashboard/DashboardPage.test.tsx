import type {
  DrawingListResponse,
  DrawingSummary,
} from "@open-excalidraw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import type { DashboardApi } from "./dashboard-api";
import { DashboardPage } from "./DashboardPage";

const createDrawing = (
  role: DrawingSummary["role"],
  title: string,
  offset: number,
): DrawingSummary => ({
  contentRevision: "1",
  createdAt: "2026-07-10T10:00:00.000Z",
  id: `00000000-0000-4000-8000-${String(offset).padStart(12, "0")}`,
  metadataRevision: "1",
  ownerName: role === "owner" ? "Ada" : "Grace",
  ownerUserId: `10000000-0000-4000-8000-${String(offset).padStart(12, "0")}`,
  role,
  title,
  updatedAt: "2026-07-10T12:30:00.000Z",
});

class FakeDashboardApi implements DashboardApi {
  data: DrawingListResponse;
  readonly createDrawing = vi.fn((title: string) => {
    const drawing = createDrawing("owner", title, 99);
    this.data.owned.unshift(drawing);
    return Promise.resolve(drawing);
  });
  readonly deleteDrawing = vi.fn((drawing: DrawingSummary) => {
    this.data.owned = this.data.owned.filter(({ id }) => id !== drawing.id);
    return Promise.resolve();
  });
  readonly listDrawings = vi.fn(() => Promise.resolve(this.data));
  readonly renameDrawing = vi.fn((drawing: DrawingSummary, title: string) => {
    const renamed = {
      ...drawing,
      metadataRevision: String(Number(drawing.metadataRevision) + 1),
      title,
    };
    this.data.owned = this.data.owned.map((candidate) =>
      candidate.id === drawing.id ? renamed : candidate,
    );
    this.data.shared = this.data.shared.map((candidate) =>
      candidate.id === drawing.id ? renamed : candidate,
    );
    return Promise.resolve(renamed);
  });

  constructor(data: DrawingListResponse) {
    this.data = data;
  }
}

const renderDashboard = (api: DashboardApi, onOpenDrawing = vi.fn()) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <DashboardPage api={api} onOpenDrawing={onOpenDrawing} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
    onOpenDrawing,
    queryClient,
  };
};

describe("DashboardPage", () => {
  it("renders owned and shared sections with role badges and timestamps", async () => {
    const api = new FakeDashboardApi({
      nextCursor: null,
      owned: [createDrawing("owner", "Product map", 1)],
      shared: [
        createDrawing("editor", "API design", 2),
        createDrawing("viewer", "Roadmap", 3),
      ],
    });
    renderDashboard(api);

    expect(await screen.findByText("Product map")).toBeInTheDocument();
    expect(screen.getByText("API design")).toBeInTheDocument();
    expect(screen.getByText("Roadmap")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Owned" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Shared" })).toBeInTheDocument();
    expect(screen.getAllByText("owner")).toHaveLength(1);
    expect(screen.getAllByText("editor")).toHaveLength(1);
    expect(screen.getAllByText("viewer")).toHaveLength(1);
    expect(screen.getAllByText("Grace")).toHaveLength(2);
    expect(screen.getAllByRole("time")).toHaveLength(3);
  });

  it("allows owner and editor rename controls but only owner deletion", async () => {
    const user = userEvent.setup();
    const owner = createDrawing("owner", "Owner board", 1);
    const editor = createDrawing("editor", "Editor board", 2);
    const viewer = createDrawing("viewer", "Viewer board", 3);
    const api = new FakeDashboardApi({
      nextCursor: null,
      owned: [owner],
      shared: [editor, viewer],
    });
    renderDashboard(api);

    const ownerCard = (await screen.findByText(owner.title)).closest(
      "article",
    )!;
    const editorCard = screen.getByText(editor.title).closest("article")!;
    const viewerCard = screen.getByText(viewer.title).closest("article")!;

    expect(
      within(ownerCard).getByRole("button", { name: "Rename" }),
    ).toBeVisible();
    expect(
      within(ownerCard).getByRole("button", { name: "Delete" }),
    ).toBeVisible();
    expect(
      within(editorCard).getByRole("button", { name: "Rename" }),
    ).toBeVisible();
    expect(
      within(editorCard).queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
    expect(
      within(viewerCard).queryByRole("button", { name: "Rename" }),
    ).not.toBeInTheDocument();
    expect(
      within(viewerCard).queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();

    await user.click(
      within(editorCard).getByRole("button", { name: "Rename" }),
    );
    const titleInput = within(editorCard).getByLabelText("New title");
    await user.clear(titleInput);
    await user.type(titleInput, "Edited API design");
    await user.click(within(editorCard).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.renameDrawing).toHaveBeenCalledWith(
        editor,
        "Edited API design",
      ),
    );
    expect(await screen.findByText("Edited API design")).toBeInTheDocument();
  });

  it("creates, opens, and deletes an owned drawing", async () => {
    const user = userEvent.setup();
    const existing = createDrawing("owner", "Old board", 1);
    const api = new FakeDashboardApi({
      nextCursor: null,
      owned: [existing],
      shared: [],
    });
    const onOpen = vi.fn();
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    renderDashboard(api, onOpen);

    await screen.findByText("Old board");
    await user.type(screen.getByLabelText("New drawing title"), "New board");
    await user.click(screen.getByRole("button", { name: "Create drawing" }));

    await waitFor(() =>
      expect(api.createDrawing).toHaveBeenCalledWith("New board"),
    );
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ title: "New board" }),
    );

    const oldCard = screen.getByText("Old board").closest("article")!;
    await user.click(within(oldCard).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(api.deleteDrawing).toHaveBeenCalledWith(existing),
    );
    expect(screen.queryByText("Old board")).not.toBeInTheDocument();
  });

  it("keeps mutation controls disabled while offline", async () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    const api = new FakeDashboardApi({
      nextCursor: null,
      owned: [createDrawing("owner", "Offline board", 1)],
      shared: [],
    });
    renderDashboard(api);

    const card = (await screen.findByText("Offline board")).closest("article")!;
    expect(
      screen.getByRole("button", { name: "Create drawing" }),
    ).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Rename" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Open" })).toBeEnabled();
    expect(screen.getByText(/You are offline/)).toBeInTheDocument();

    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
  });

  it("renders loading, empty, and recoverable error states", async () => {
    let resolveList!: (data: DrawingListResponse) => void;
    const loadingApi = new FakeDashboardApi({
      nextCursor: null,
      owned: [],
      shared: [],
    });
    loadingApi.listDrawings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    );
    const loadingView = renderDashboard(loadingApi);

    expect(screen.getByText("Loading drawings…")).toBeInTheDocument();
    resolveList({ nextCursor: null, owned: [], shared: [] });
    expect(
      await screen.findByText("Create your first drawing to get started."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Drawings shared with you will appear here."),
    ).toBeInTheDocument();
    loadingView.unmount();

    const errorApi = new FakeDashboardApi({
      nextCursor: null,
      owned: [],
      shared: [],
    });
    errorApi.listDrawings.mockRejectedValueOnce(
      new Error("Network unavailable"),
    );
    renderDashboard(errorApi);
    expect(
      await screen.findByRole("heading", {
        name: "Could not load your drawings",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Network unavailable")).toBeInTheDocument();
  });
});
