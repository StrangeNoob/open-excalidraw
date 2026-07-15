import type { SessionResponse } from "@open-excalidraw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
import { SettingsPage } from "./SettingsPage";

const session: SessionResponse = {
  capabilities: {
    emailPassword: true,
    github: true,
    google: false,
    smtp: false,
  },
  user: {
    createdAt: "2026-07-10T10:00:00.000Z",
    email: "ada@example.com",
    emailVerified: true,
    id: "be21c1cd-a5d5-49f9-b9dd-a30e3cb80e09",
    image: null,
    name: "Ada",
  },
};

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

const renderSettings = (accounts: LinkedAccount[]) => {
  const client = new FakeAuthClient();
  client.getSession.mockResolvedValue(session);
  client.listAccounts.mockResolvedValue(accounts);
  client.signOut.mockResolvedValue();
  client.changePassword.mockResolvedValue();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider client={client}>
        <MemoryRouter initialEntries={["/app/settings"]}>
          <SettingsPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );

  return client;
};

describe("SettingsPage", () => {
  it("changes the password for accounts with credentials", async () => {
    const client = renderSettings([
      { providerId: "credential" },
      { providerId: "github" },
    ]);

    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText("Current password"),
      "old-password-123",
    );
    await user.type(screen.getByLabelText(/New password/), "new-password-456");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() =>
      expect(client.changePassword).toHaveBeenCalledWith(
        "old-password-123",
        "new-password-456",
      ),
    );
    expect(
      await screen.findByText(
        "Password changed. Other devices were signed out.",
      ),
    ).toBeVisible();
  });

  it("offers to set a password for OAuth-only accounts", async () => {
    const client = renderSettings([{ providerId: "github" }]);

    const user = userEvent.setup();
    expect(await screen.findByText("Set a password")).toBeVisible();
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/New password/), "new-password-456");
    await user.click(screen.getByRole("button", { name: "Set password" }));

    await waitFor(() =>
      expect(client.setPassword).toHaveBeenCalledWith("new-password-456"),
    );
  });

  it("disables disconnect when only one sign-in method remains", async () => {
    renderSettings([{ providerId: "github" }]);

    expect(
      await screen.findByRole("button", { name: "Disconnect" }),
    ).toBeDisabled();
  });

  it("signs the user out", async () => {
    const client = renderSettings([{ providerId: "credential" }]);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(client.signOut).toHaveBeenCalled());
  });
});
