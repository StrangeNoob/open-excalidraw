import type {
  AdminOverview,
  AdminSettings,
  AdminSettingsUpdate,
  AdminUser,
  AdminUserList,
  AdminUserQuotaUpdate,
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

const UNLIMITED_SETTINGS: AdminSettings = {
  envFallbackBytes: null,
  storageQuotaPerUserBytes: null,
};

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
  storageBytes: 0,
  storageQuotaBytes: null,
  twoFactorEnabled: false,
  ...overrides,
});

class FakeAdminApi implements AdminApi {
  overview: AdminOverview;
  users: AdminUser[];
  total: number;
  settings: AdminSettings;

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
  readonly resetTwoFactor = vi.fn((userId: string) => {
    this.users = this.users.map((user) =>
      user.id === userId ? { ...user, twoFactorEnabled: false } : user,
    );
    return Promise.resolve();
  });
  readonly deleteUser = vi.fn((userId: string) => {
    this.users = this.users.filter((user) => user.id !== userId);
    return Promise.resolve();
  });
  readonly getSettings = vi.fn(() => Promise.resolve(this.settings));
  readonly updateSettings = vi.fn((input: AdminSettingsUpdate) => {
    this.settings = { ...this.settings, ...input };
    return Promise.resolve(this.settings);
  });
  readonly setUserQuota = vi.fn(
    (userId: string, input: AdminUserQuotaUpdate) => {
      let updated: AdminUser | undefined;
      this.users = this.users.map((user) => {
        if (user.id !== userId) return user;
        updated = { ...user, storageQuotaBytes: input.storageQuotaBytes };
        return updated;
      });
      return updated
        ? Promise.resolve(updated)
        : Promise.reject(new Error("User not found"));
    },
  );

  constructor(
    overview: AdminOverview,
    users: AdminUser[],
    total = users.length,
    settings: AdminSettings = UNLIMITED_SETTINGS,
  ) {
    this.overview = overview;
    this.users = users;
    this.total = total;
    this.settings = settings;
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
  readonly signIn =
    vi.fn<
      (input: EmailSignInInput) => Promise<{ twoFactorRedirect: boolean }>
    >();
  readonly signOut = vi.fn<() => Promise<void>>();
  readonly signUp = vi.fn<(input: EmailSignUpInput) => Promise<void>>();
  readonly startOAuth =
    vi.fn<(provider: OAuthProvider, returnPath: string) => Promise<void>>();
  readonly unlinkAccount = vi.fn<(providerId: string) => Promise<void>>();
  readonly disableTwoFactor = vi.fn<(password: string) => Promise<void>>();
  readonly enableTwoFactor =
    vi.fn<
      (password: string) => Promise<{ backupCodes: string[]; totpURI: string }>
    >();
  readonly generateBackupCodes =
    vi.fn<(password: string) => Promise<{ backupCodes: string[] }>>();
  readonly getTotpUri =
    vi.fn<(password: string) => Promise<{ totpURI: string }>>();
  readonly verifyBackupCode =
    vi.fn<(code: string, trustDevice: boolean) => Promise<void>>();
  readonly verifyTotp =
    vi.fn<(code: string, trustDevice: boolean) => Promise<void>>();
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
      signupsDisabled: false,
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
      twoFactorEnabled: false,
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

  it("resets two-factor for an enrolled user only after confirmation", async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi({ drawings: 0, storageBytes: 0, users: 2 }, [
      createAdminUser("Grace", 2, { twoFactorEnabled: true }),
    ]);
    // mockReset drops any confirm spy an earlier test left in place, so the
    // call-count assertion below counts only this test's two clicks.
    const confirm = vi.spyOn(globalThis, "confirm");
    confirm.mockReset();
    confirm.mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderAdmin(api);

    const card = (await screen.findByText("Grace")).closest("article")!;
    const button = within(card).getByRole("button", { name: "Reset 2FA" });

    await user.click(button);
    expect(api.resetTwoFactor).not.toHaveBeenCalled();

    await user.click(button);
    await waitFor(() =>
      expect(api.resetTwoFactor).toHaveBeenCalledWith(GRACE_ID),
    );
    // The button is gated on twoFactorEnabled, so it disappears once reset.
    await waitFor(() =>
      expect(
        within(card).queryByRole("button", { name: "Reset 2FA" }),
      ).not.toBeInTheDocument(),
    );
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("hides the reset button for a user without two-factor", async () => {
    const api = new FakeAdminApi({ drawings: 0, storageBytes: 0, users: 1 }, [
      createAdminUser("Grace", 2),
    ]);
    renderAdmin(api);

    const card = (await screen.findByText("Grace")).closest("article")!;
    expect(
      within(card).queryByRole("button", { name: "Reset 2FA" }),
    ).not.toBeInTheDocument();
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

  it("loads, edits, and saves the instance-wide storage quota", async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi(
      { drawings: 0, storageBytes: 0, users: 1 },
      [createAdminUser("Grace", 2)],
      1,
      {
        envFallbackBytes: 1_073_741_824,
        storageQuotaPerUserBytes: 2_147_483_648,
      },
    );
    renderAdmin(api);

    const input = await screen.findByLabelText("Instance-wide quota (MB)");
    await waitFor(() => expect(input).toHaveValue(2048));
    // The override is effective and the env default is shown alongside it.
    expect(screen.getByText("2 GB")).toBeInTheDocument();
    expect(screen.getByText(/Environment default:\s*1 GB/)).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "512");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        storageQuotaPerUserBytes: 536_870_912,
      }),
    );
    expect(await screen.findByText("512 MB")).toBeInTheDocument();
  });

  it("clears the instance-wide quota when the field is emptied", async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi(
      { drawings: 0, storageBytes: 0, users: 0 },
      [],
      0,
      { envFallbackBytes: null, storageQuotaPerUserBytes: 2_147_483_648 },
    );
    renderAdmin(api);

    const input = await screen.findByLabelText("Instance-wide quota (MB)");
    await waitFor(() => expect(input).toHaveValue(2048));

    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        storageQuotaPerUserBytes: null,
      }),
    );
  });

  it("surfaces an error when saving the storage quota fails", async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi(
      { drawings: 0, storageBytes: 0, users: 0 },
      [],
    );
    api.updateSettings.mockRejectedValueOnce(new Error("Save failed"));
    renderAdmin(api);

    const input = await screen.findByLabelText("Instance-wide quota (MB)");
    await user.type(input, "256");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Save failed")).toBeInTheDocument();
  });

  it("renders each user's storage usage and override", async () => {
    const api = new FakeAdminApi({ drawings: 0, storageBytes: 0, users: 2 }, [
      createAdminUser("Ada", 1, {
        storageBytes: 1_288_490_189,
        storageQuotaBytes: 2_147_483_648,
      }),
      createAdminUser("Grace", 2),
    ]);
    renderAdmin(api);

    const adaCard = (await screen.findByText("Ada")).closest("article")!;
    expect(within(adaCard).getByText(/1\.2 GB of 2 GB/)).toBeInTheDocument();

    const graceCard = screen.getByText("Grace").closest("article")!;
    expect(within(graceCard).getByText("0 B")).toBeInTheDocument();
  });

  it("sets and clears a user's storage quota override", async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi({ drawings: 0, storageBytes: 0, users: 1 }, [
      createAdminUser("Grace", 2, { storageBytes: 5_242_880 }),
    ]);
    renderAdmin(api);

    const card = (await screen.findByText("Grace")).closest("article")!;
    await user.type(within(card).getByLabelText("Quota (MB)"), "100");
    await user.click(within(card).getByRole("button", { name: "Save quota" }));

    await waitFor(() =>
      expect(api.setUserQuota).toHaveBeenCalledWith(GRACE_ID, {
        storageQuotaBytes: 104_857_600,
      }),
    );
    expect(await within(card).findByText(/of 100 MB/)).toBeInTheDocument();

    await user.clear(within(card).getByLabelText("Quota (MB)"));
    await user.click(within(card).getByRole("button", { name: "Save quota" }));

    await waitFor(() =>
      expect(api.setUserQuota).toHaveBeenLastCalledWith(GRACE_ID, {
        storageQuotaBytes: null,
      }),
    );
    await waitFor(() =>
      expect(within(card).queryByText(/of 100 MB/)).not.toBeInTheDocument(),
    );
  });
});
