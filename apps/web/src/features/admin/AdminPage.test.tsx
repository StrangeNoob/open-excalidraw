import type {
  AdminOverview,
  AdminUser,
  AdminUserList,
  SessionResponse,
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
import { AdminPage } from "./AdminPage";
import type { AdminApi } from "./admin-api";

const CURRENT_USER_ID = "be21c1cd-a5d5-49f9-b9dd-a30e3cb80e09";
const GRACE_ID = "00000000-0000-4000-8000-000000000002";

const createAdminUser = (
  name: string,
  offset: number,
  overrides: Partial<AdminUser> = {},
): AdminUser => ({
  createdAt: "2026-07-10T10:00:00.000Z",
  disabledAt: null,
  drawingCount: 3,
  email: `${name.toLowerCase()}@example.com`,
  emailVerified: true,
  id: `00000000-0000-4000-8000-${String(offset).padStart(12, "0")}`,
  name,
  ...overrides,
});

class FakeAdminApi implements AdminApi {
  overview: AdminOverview;
  users: AdminUser[];
  total: number;

  readonly getOverview = vi.fn(() => Promise.resolve(this.overview));
  readonly listUsers = vi.fn((search: string): Promise<AdminUserList> => {
    const needle = search.toLowerCase();
    const matched = needle
      ? this.users.filter((user) =>
          `${user.name} ${user.email}`.toLowerCase().includes(needle),
        )
      : this.users;
    return Promise.resolve({ total: this.total, users: matched });
  });
  readonly disableUser = vi.fn((userId: string) => {
    this.users = this.users.map((user) =>
      user.id === userId
        ? { ...user, disabledAt: "2026-07-18T00:00:00.000Z" }
        : user,
    );
    return Promise.resolve();
  });
  readonly enableUser = vi.fn((userId: string) => {
    this.users = this.users.map((user) =>
      user.id === userId ? { ...user, disabledAt: null } : user,
    );
    return Promise.resolve();
  });
  readonly deleteUser = vi.fn((userId: string) => {
    this.users = this.users.filter((user) => user.id !== userId);
    return Promise.resolve();
  });

  constructor(
    overview: AdminOverview,
    users: AdminUser[],
    total = users.length,
  ) {
    this.overview = overview;
    this.users = users;
    this.total = total;
  }
}

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

const renderAdmin = (api: AdminApi) => {
  const authClient = new FakeAuthClient();
  authClient.getSession.mockResolvedValue({
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
      id: CURRENT_USER_ID,
      image: null,
      isAdmin: true,
      name: "Ada",
    },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider client={authClient}>
          <MemoryRouter>
            <AdminPage api={api} />
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    ),
    queryClient,
  };
};

describe("AdminPage", () => {
  it("renders overview stats and the user list with badges", async () => {
    const api = new FakeAdminApi(
      { drawings: 100, storageBytes: 5_368_709_120, users: 42 },
      [
        createAdminUser("Ada", 1),
        createAdminUser("Grace", 2, { emailVerified: false }),
      ],
    );
    renderAdmin(api);

    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Grace")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("5 GB")).toBeInTheDocument();

    const graceCard = screen.getByText("Grace").closest("article")!;
    expect(within(graceCard).getByText("unverified")).toBeInTheDocument();
    const adaCard = screen.getByText("Ada").closest("article")!;
    expect(within(adaCard).queryByText("unverified")).not.toBeInTheDocument();
  });

  it("shows an empty state when no users are found", async () => {
    const api = new FakeAdminApi(
      { drawings: 0, storageBytes: 0, users: 0 },
      [],
    );
    renderAdmin(api);

    expect(await screen.findByText("No users found.")).toBeInTheDocument();
  });

  it("filters users via the search field and notes the truncated total", async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi(
      { drawings: 0, storageBytes: 0, users: 5 },
      [createAdminUser("Ada", 1), createAdminUser("Grace", 2)],
      5,
    );
    renderAdmin(api);

    expect(
      await screen.findByText("Showing 2 of 5 users."),
    ).toBeInTheDocument();

    await user.type(
      screen.getByRole("searchbox", { name: "Search users" }),
      "grace",
    );

    await waitFor(() =>
      expect(api.listUsers).toHaveBeenLastCalledWith("grace"),
    );
    expect(await screen.findByText("Grace")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("Ada")).not.toBeInTheDocument(),
    );
  });

  it("disables a user and reflects the disabled state", async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi({ drawings: 0, storageBytes: 0, users: 2 }, [
      createAdminUser("Grace", 2),
    ]);
    renderAdmin(api);

    const card = (await screen.findByText("Grace")).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Disable" }));

    await waitFor(() => expect(api.disableUser).toHaveBeenCalledWith(GRACE_ID));
    expect(await within(card).findByText("disabled")).toBeInTheDocument();
    expect(
      within(card).getByRole("button", { name: "Enable" }),
    ).toBeInTheDocument();
  });

  it("deletes a user only after confirmation", async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi({ drawings: 0, storageBytes: 0, users: 2 }, [
      createAdminUser("Grace", 2),
    ]);
    const confirm = vi
      .spyOn(globalThis, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    renderAdmin(api);

    const card = (await screen.findByText("Grace")).closest("article")!;
    const deleteButton = within(card).getByRole("button", { name: "Delete" });

    await user.click(deleteButton);
    expect(api.deleteUser).not.toHaveBeenCalled();

    await user.click(deleteButton);
    await waitFor(() => expect(api.deleteUser).toHaveBeenCalledWith(GRACE_ID));
    await waitFor(() =>
      expect(screen.queryByText("Grace")).not.toBeInTheDocument(),
    );
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("hides action buttons on the current user's own row", async () => {
    const api = new FakeAdminApi({ drawings: 0, storageBytes: 0, users: 2 }, [
      createAdminUser("Ada", 0, { id: CURRENT_USER_ID }),
      createAdminUser("Grace", 2),
    ]);
    renderAdmin(api);

    const selfCard = (await screen.findByText("Ada")).closest("article")!;
    const otherCard = screen.getByText("Grace").closest("article")!;

    await waitFor(() =>
      expect(
        within(selfCard).queryByRole("button", { name: "Disable" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      within(selfCard).queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
    expect(
      within(otherCard).getByRole("button", { name: "Disable" }),
    ).toBeInTheDocument();
  });

  it("renders a recoverable error when the user list fails", async () => {
    const api = new FakeAdminApi(
      { drawings: 0, storageBytes: 0, users: 0 },
      [],
    );
    api.listUsers.mockRejectedValueOnce(new Error("Network unavailable"));
    renderAdmin(api);

    expect(
      await screen.findByRole("heading", { name: "Could not load users" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Network unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });
});
