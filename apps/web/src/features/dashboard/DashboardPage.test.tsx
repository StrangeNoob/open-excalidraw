import type {
  DrawingListResponse,
  DrawingSummary,
  SessionResponse,
  TrashedDrawing,
} from "@open-excalidraw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import type {
  AuthClient,
  EmailSignInInput,
  EmailSignUpInput,
  LinkedAccount,
  OAuthProvider,
} from "../auth";
import { AuthProvider } from "../auth";
import { TRASH_QUERY_KEY, type DashboardApi } from "./dashboard-api";
import { DashboardPage } from "./DashboardPage";

const createDrawing = (
  role: DrawingSummary["role"],
  title: string,
  offset: number,
  tags: string[] = [],
): DrawingSummary => ({
  contentRevision: "1",
  createdAt: "2026-07-10T10:00:00.000Z",
  id: `00000000-0000-4000-8000-${String(offset).padStart(12, "0")}`,
  isTemplate: false,
  metadataRevision: "1",
  ownerName: role === "owner" ? "Ada" : "Grace",
  ownerUserId: `10000000-0000-4000-8000-${String(offset).padStart(12, "0")}`,
  role,
  tags,
  thumbnailUpdatedAt: null,
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
  readonly duplicateDrawing = vi.fn((drawing: DrawingSummary) =>
    Promise.resolve(createDrawing("owner", `${drawing.title} copy`, 98)),
  );
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
  readonly setTags = vi.fn((drawing: DrawingSummary, tags: string[]) => {
    const tagged = { ...drawing, tags };
    this.data.owned = this.data.owned.map((candidate) =>
      candidate.id === drawing.id ? tagged : candidate,
    );
    this.data.shared = this.data.shared.map((candidate) =>
      candidate.id === drawing.id ? tagged : candidate,
    );
    return Promise.resolve(tagged);
  });

  readonly setTemplate = vi.fn(
    (drawing: DrawingSummary, isTemplate: boolean) => {
      const updated = {
        ...drawing,
        isTemplate,
        metadataRevision: String(Number(drawing.metadataRevision) + 1),
      };
      this.data.owned = this.data.owned.map((candidate) =>
        candidate.id === drawing.id ? updated : candidate,
      );
      this.data.shared = this.data.shared.map((candidate) =>
        candidate.id === drawing.id ? updated : candidate,
      );
      return Promise.resolve(updated);
    },
  );

  // Trash actions live on TrashPage; the dashboard never calls these.
  readonly listTrash = vi.fn(() => Promise.resolve({ drawings: [] }));
  readonly purgeDrawing = vi.fn(() => Promise.resolve());
  readonly restoreDrawing = vi.fn((drawing: TrashedDrawing) =>
    Promise.resolve(drawing),
  );

  constructor(data: DrawingListResponse) {
    this.data = data;
  }
}

const buildSession = (isAdmin: boolean): SessionResponse => ({
  capabilities: {
    emailPassword: true,
    github: false,
    google: false,
    oidc: false,
    oidcProviderName: "SSO",
    smtp: false,
  },
  user: {
    createdAt: "2026-07-10T10:00:00.000Z",
    email: "ada@example.com",
    emailVerified: true,
    id: "be21c1cd-a5d5-49f9-b9dd-a30e3cb80e09",
    image: null,
    isAdmin,
    name: "Ada",
  },
});

class FakeAuthClient implements AuthClient {
  readonly changePassword =
    vi.fn<(currentPassword: string, newPassword: string) => Promise<void>>();
  readonly getSession = vi.fn<() => Promise<SessionResponse>>();
  readonly linkSocial =
    vi.fn<(provider: OAuthProvider, returnPath: string) => Promise<void>>();
  readonly listAccounts = vi.fn<() => Promise<LinkedAccount[]>>();
  readonly requestPasswordReset =
    vi.fn<(email: string, redirectTo: string) => Promise<void>>();
  readonly resendVerification =
    vi.fn<(email: string, callbackURL: string) => Promise<void>>();
  readonly resetPassword =
    vi.fn<(newPassword: string, token: string) => Promise<void>>();
  readonly setPassword = vi.fn<(newPassword: string) => Promise<void>>();
  readonly signIn = vi.fn<(input: EmailSignInInput) => Promise<void>>();
  readonly signOut = vi.fn<() => Promise<void>>();
  readonly signUp = vi.fn<(input: EmailSignUpInput) => Promise<void>>();
  readonly startOAuth =
    vi.fn<(provider: OAuthProvider, returnPath: string) => Promise<void>>();
  readonly unlinkAccount = vi.fn<(providerId: string) => Promise<void>>();
}

const renderDashboard = (
  api: DashboardApi,
  onOpenDrawing = vi.fn(),
  isAdmin = false,
) => {
  const authClient = new FakeAuthClient();
  authClient.getSession.mockResolvedValue(buildSession(isAdmin));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider client={authClient}>
          <MemoryRouter>
            <DashboardPage api={api} onOpenDrawing={onOpenDrawing} />
          </MemoryRouter>
        </AuthProvider>
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
    expect(screen.getByRole("link", { name: "Trash" })).toBeInTheDocument();
  });

  it("shows a cache-busted thumbnail when one exists and hides it on load failure", async () => {
    const thumbed = {
      ...createDrawing("owner", "Thumbed board", 1),
      thumbnailUpdatedAt: "2026-07-15T09:30:00.000Z",
    };
    const bare = createDrawing("owner", "Bare board", 2);
    const api = new FakeDashboardApi({
      nextCursor: null,
      owned: [thumbed, bare],
      shared: [],
    });
    renderDashboard(api);

    const thumbedCard = (await screen.findByText("Thumbed board")).closest(
      "article",
    )!;
    const bareCard = screen.getByText("Bare board").closest("article")!;
    const image = thumbedCard.querySelector("img")!;
    expect(image).not.toBeNull();
    expect(image.getAttribute("src")).toBe(
      `/api/v1/drawings/${thumbed.id}/thumbnail?v=${encodeURIComponent(
        "2026-07-15T09:30:00.000Z",
      )}`,
    );
    expect(bareCard.querySelector("img")).toBeNull();

    image.dispatchEvent(new Event("error"));
    await waitFor(() => expect(image).not.toBeVisible());
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
    const { queryClient } = renderDashboard(api, onOpen);
    queryClient.setQueryData(TRASH_QUERY_KEY, { drawings: [] });

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
    // A previously viewed trash list must refetch after a delete.
    expect(queryClient.getQueryState(TRASH_QUERY_KEY)?.isInvalidated).toBe(
      true,
    );
  });

  it("duplicates any accessible drawing and opens the copy", async () => {
    const user = userEvent.setup();
    const viewer = createDrawing("viewer", "Viewer board", 1);
    const api = new FakeDashboardApi({
      nextCursor: null,
      owned: [],
      shared: [viewer],
    });
    const onOpen = vi.fn();
    renderDashboard(api, onOpen);

    const card = (await screen.findByText("Viewer board")).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Duplicate" }));

    await waitFor(() =>
      expect(api.duplicateDrawing).toHaveBeenCalledWith(viewer),
    );
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Viewer board copy" }),
    );
    expect(await screen.findByText("Viewer board copy")).toBeInTheDocument();
  });

  it("toggles the template flag where renaming is allowed", async () => {
    const user = userEvent.setup();
    const owner = createDrawing("owner", "Owner board", 1);
    const viewer = createDrawing("viewer", "Viewer board", 2);
    const api = new FakeDashboardApi({
      nextCursor: null,
      owned: [owner],
      shared: [viewer],
    });
    renderDashboard(api);

    const ownerCard = (await screen.findByText("Owner board")).closest(
      "article",
    )!;
    const viewerCard = screen.getByText("Viewer board").closest("article")!;
    expect(
      within(viewerCard).queryByRole("button", { name: "Make template" }),
    ).not.toBeInTheDocument();

    await user.click(
      within(ownerCard).getByRole("button", { name: "Make template" }),
    );
    await waitFor(() =>
      expect(api.setTemplate).toHaveBeenCalledWith(owner, true),
    );
    expect(within(ownerCard).getByText("template")).toBeInTheDocument();
    expect(
      within(ownerCard).getByRole("button", { name: "Remove template" }),
    ).toBeVisible();
  });

  it("creates a drawing from a template via the header picker", async () => {
    const user = userEvent.setup();
    const template = {
      ...createDrawing("owner", "Retro template", 1),
      isTemplate: true,
    };
    const plain = createDrawing("owner", "Plain board", 2);
    const api = new FakeDashboardApi({
      nextCursor: null,
      owned: [template, plain],
      shared: [],
    });
    const onOpen = vi.fn();
    renderDashboard(api, onOpen);

    const picker = await screen.findByLabelText("New from template");
    expect(within(picker).queryByRole("option", { name: "Plain board" })).toBe(
      null,
    );
    await user.selectOptions(picker, template.id);
    await user.click(
      screen.getByRole("button", { name: "Create from template" }),
    );

    await waitFor(() =>
      expect(api.duplicateDrawing).toHaveBeenCalledWith(template),
    );
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Retro template copy" }),
    );
  });

  it("hides the template picker when no templates exist", async () => {
    const api = new FakeDashboardApi({
      nextCursor: null,
      owned: [createDrawing("owner", "Plain board", 1)],
      shared: [],
    });
    renderDashboard(api);

    await screen.findByText("Plain board");
    expect(
      screen.queryByLabelText("New from template"),
    ).not.toBeInTheDocument();
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

  it("renders tag chips, filters by tag, and edits tags", async () => {
    const user = userEvent.setup();
    const tagged = createDrawing("owner", "Tagged board", 1, ["ideas"]);
    const plain = createDrawing("owner", "Plain board", 2);
    const shared = createDrawing("viewer", "Shared board", 3, ["work"]);
    const api = new FakeDashboardApi({
      nextCursor: null,
      owned: [tagged, plain],
      shared: [shared],
    });
    renderDashboard(api);

    const taggedCard = (await screen.findByText("Tagged board")).closest(
      "article",
    )!;
    expect(within(taggedCard).getByText("ideas")).toBeInTheDocument();

    const filterBar = screen.getByRole("navigation", {
      name: "Filter by tag",
    });
    await user.click(within(filterBar).getByRole("button", { name: "ideas" }));
    expect(screen.queryByText("Plain board")).not.toBeInTheDocument();
    expect(screen.queryByText("Shared board")).not.toBeInTheDocument();
    expect(screen.getByText("Tagged board")).toBeInTheDocument();
    await user.click(within(filterBar).getByRole("button", { name: "All" }));
    expect(screen.getByText("Plain board")).toBeInTheDocument();

    const plainCard = screen.getByText("Plain board").closest("article")!;
    await user.click(
      within(plainCard).getByRole("button", { name: "Edit tags" }),
    );
    await user.type(
      within(plainCard).getByLabelText("Tags (comma-separated)"),
      " Sprint, ideas ,sprint",
    );
    await user.click(within(plainCard).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.setTags).toHaveBeenCalledWith(plain, ["sprint", "ideas"]),
    );
    expect(within(plainCard).getByText("sprint")).toBeInTheDocument();
  });

  it("rejects more than 20 tags instead of dropping them", async () => {
    const user = userEvent.setup();
    const drawing = createDrawing("owner", "Crowded board", 1);
    const api = new FakeDashboardApi({
      nextCursor: null,
      owned: [drawing],
      shared: [],
    });
    renderDashboard(api);

    const card = (await screen.findByText("Crowded board")).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Edit tags" }));
    await user.type(
      within(card).getByLabelText("Tags (comma-separated)"),
      Array.from({ length: 21 }, (_, i) => `tag-${i}`).join(","),
    );
    await user.click(within(card).getByRole("button", { name: "Save" }));

    expect(within(card).getByText("Use at most 20 tags.")).toBeVisible();
    expect(api.setTags).not.toHaveBeenCalled();
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

  it("shows the Admin link only when the current user is an admin", async () => {
    const api = new FakeDashboardApi({
      nextCursor: null,
      owned: [],
      shared: [],
    });
    const view = renderDashboard(api, vi.fn(), false);

    await screen.findByText("Create your first drawing to get started.");
    expect(
      screen.queryByRole("link", { name: "Admin" }),
    ).not.toBeInTheDocument();
    view.unmount();

    renderDashboard(api, vi.fn(), true);
    expect(
      await screen.findByRole("link", { name: "Admin" }),
    ).toBeInTheDocument();
  });
});
