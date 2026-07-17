import type {
  DrawingListResponse,
  TrashedDrawing,
  TrashListResponse,
} from "@open-excalidraw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import { DASHBOARD_QUERY_KEY, type DashboardApi } from "./dashboard-api";
import { TrashPage } from "./TrashPage";

const createTrashedDrawing = (
  title: string,
  offset: number,
): TrashedDrawing => ({
  contentRevision: "1",
  createdAt: "2026-07-10T10:00:00.000Z",
  deletedAt: "2026-07-15T09:00:00.000Z",
  id: `00000000-0000-4000-8000-${String(offset).padStart(12, "0")}`,
  isTemplate: false,
  metadataRevision: "1",
  ownerName: "Ada",
  ownerUserId: `10000000-0000-4000-8000-${String(offset).padStart(12, "0")}`,
  role: "owner",
  tags: [],
  thumbnailUpdatedAt: null,
  title,
  updatedAt: "2026-07-10T12:30:00.000Z",
});

class FakeTrashApi implements DashboardApi {
  data: TrashListResponse;
  readonly listTrash = vi.fn(() => Promise.resolve(this.data));
  readonly restoreDrawing = vi.fn((drawing: TrashedDrawing) => {
    this.data = {
      drawings: this.data.drawings.filter(({ id }) => id !== drawing.id),
    };
    return Promise.resolve(drawing);
  });
  readonly purgeDrawing = vi.fn((drawing: TrashedDrawing) => {
    this.data = {
      drawings: this.data.drawings.filter(({ id }) => id !== drawing.id),
    };
    return Promise.resolve();
  });

  // TrashPage never calls the dashboard methods.
  readonly createDrawing = vi.fn<DashboardApi["createDrawing"]>(() =>
    Promise.reject(new Error("unused")),
  );
  readonly deleteDrawing = vi.fn<DashboardApi["deleteDrawing"]>(() =>
    Promise.reject(new Error("unused")),
  );
  readonly duplicateDrawing = vi.fn<DashboardApi["duplicateDrawing"]>(() =>
    Promise.reject(new Error("unused")),
  );
  readonly listDrawings = vi.fn<DashboardApi["listDrawings"]>(() =>
    Promise.reject(new Error("unused")),
  );
  readonly renameDrawing = vi.fn<DashboardApi["renameDrawing"]>(() =>
    Promise.reject(new Error("unused")),
  );
  readonly setTags = vi.fn<DashboardApi["setTags"]>(() =>
    Promise.reject(new Error("unused")),
  );
  readonly setTemplate = vi.fn<DashboardApi["setTemplate"]>(() =>
    Promise.reject(new Error("unused")),
  );

  constructor(data: TrashListResponse) {
    this.data = data;
  }
}

const renderTrash = (api: DashboardApi) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TrashPage api={api} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
    queryClient,
  };
};

describe("TrashPage", () => {
  it("renders trashed drawings with deletion times and the retention notice", async () => {
    const api = new FakeTrashApi({
      drawings: [
        createTrashedDrawing("Old sketch", 1),
        createTrashedDrawing("Old diagram", 2),
      ],
    });
    renderTrash(api);

    expect(await screen.findByText("Old sketch")).toBeInTheDocument();
    expect(screen.getByText("Old diagram")).toBeInTheDocument();
    expect(screen.getAllByRole("time")).toHaveLength(2);
    expect(
      screen.getByText(
        "Items in the trash are permanently deleted automatically after 7 days.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to dashboard" }),
    ).toBeInTheDocument();
  });

  it("renders a just-deleted drawing as deleted today despite clock skew", async () => {
    const skewed = {
      ...createTrashedDrawing("Skewed", 3),
      // A deletedAt slightly ahead of the client clock must not say "tomorrow".
      deletedAt: new Date(Date.now() + 2_000).toISOString(),
    };
    const api = new FakeTrashApi({ drawings: [skewed] });
    renderTrash(api);

    const card = (await screen.findByText("Skewed")).closest("article")!;
    expect(within(card).getByRole("time")).toHaveTextContent(/today/i);
  });

  it("shows an empty state when the trash has nothing in it", async () => {
    const api = new FakeTrashApi({ drawings: [] });
    renderTrash(api);

    expect(await screen.findByText("The trash is empty.")).toBeInTheDocument();
  });

  it("restores a drawing and invalidates the dashboard list", async () => {
    const user = userEvent.setup();
    const drawing = createTrashedDrawing("Restore me", 1);
    const api = new FakeTrashApi({ drawings: [drawing] });
    const { queryClient } = renderTrash(api);
    const dashboard: DrawingListResponse = {
      nextCursor: null,
      owned: [],
      shared: [],
    };
    queryClient.setQueryData(DASHBOARD_QUERY_KEY, dashboard);

    const card = (await screen.findByText("Restore me")).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Restore" }));

    await waitFor(() =>
      expect(api.restoreDrawing).toHaveBeenCalledWith(drawing),
    );
    expect(screen.queryByText("Restore me")).not.toBeInTheDocument();
    expect(queryClient.getQueryState(DASHBOARD_QUERY_KEY)?.isInvalidated).toBe(
      true,
    );
  });

  it("deletes forever only after confirmation", async () => {
    const user = userEvent.setup();
    const drawing = createTrashedDrawing("Purge me", 1);
    const api = new FakeTrashApi({ drawings: [drawing] });
    const confirm = vi
      .spyOn(globalThis, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    renderTrash(api);

    const card = (await screen.findByText("Purge me")).closest("article")!;
    const deleteForever = within(card).getByRole("button", {
      name: "Delete forever",
    });

    await user.click(deleteForever);
    expect(api.purgeDrawing).not.toHaveBeenCalled();

    await user.click(deleteForever);
    await waitFor(() => expect(api.purgeDrawing).toHaveBeenCalledWith(drawing));
    expect(screen.queryByText("Purge me")).not.toBeInTheDocument();
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("renders a recoverable error state", async () => {
    const api = new FakeTrashApi({ drawings: [] });
    api.listTrash.mockRejectedValueOnce(new Error("Network unavailable"));
    renderTrash(api);

    expect(
      await screen.findByRole("heading", { name: "Could not load the trash" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Network unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });
});
