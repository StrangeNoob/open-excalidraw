import type { SessionResponse } from "@open-excalidraw/contracts";
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
import { SettingsPage } from "./SettingsPage";

const session: SessionResponse = {
  capabilities: {
    emailPassword: true,
    github: true,
    google: false,
    oidc: true,
    oidcProviderName: "Keycloak",
    signupsDisabled: false,
    smtp: false,
  },
  user: {
    createdAt: "2026-07-10T10:00:00.000Z",
    email: "ada@example.com",
    emailVerified: true,
    id: "be21c1cd-a5d5-49f9-b9dd-a30e3cb80e09",
    image: null,
    isAdmin: false,
    name: "Ada",
    twoFactorEnabled: false,
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

const enabledSession: SessionResponse = {
  ...session,
  user: session.user && { ...session.user, twoFactorEnabled: true },
};

const TOTP_URI =
  "otpauth://totp/Open%20Excalidraw:ada@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Open%20Excalidraw&digits=6&period=30";
const BACKUP_CODES = ["aaaa-1111", "bbbb-2222", "cccc-3333"];

const renderSettings = (
  accounts: LinkedAccount[],
  sessionResponse: SessionResponse = session,
) => {
  const client = new FakeAuthClient();
  client.getSession.mockResolvedValue(sessionResponse);
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

  it("connects the OIDC provider named by the deployment", async () => {
    const client = renderSettings([{ providerId: "credential" }]);

    const row = (await screen.findByText("Keycloak")).closest("li");
    if (!row) {
      throw new Error("Missing the OIDC provider row.");
    }
    const user = userEvent.setup();
    await user.click(within(row).getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(client.linkSocial).toHaveBeenCalledWith("oidc", "/app/settings"),
    );
  });

  it("disconnects a linked OIDC account", async () => {
    const client = renderSettings([
      { providerId: "credential" },
      { providerId: "oidc" },
    ]);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Disconnect" }));

    await waitFor(() =>
      expect(client.unlinkAccount).toHaveBeenCalledWith("oidc"),
    );
  });

  it("signs the user out", async () => {
    const client = renderSettings([{ providerId: "credential" }]);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(client.signOut).toHaveBeenCalled());
  });

  it("enables two-factor authentication after verifying a code", async () => {
    const client = renderSettings([{ providerId: "credential" }]);
    client.enableTwoFactor.mockResolvedValue({
      backupCodes: BACKUP_CODES,
      totpURI: TOTP_URI,
    });
    client.verifyTotp.mockResolvedValue();

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: "Enable two-factor authentication",
      }),
    );
    await user.type(
      screen.getByLabelText("Confirm your password"),
      "super-secret-1",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(client.enableTwoFactor).toHaveBeenCalledWith("super-secret-1"),
    );
    // QR, manual setup key, and single-use backup codes are all shown.
    expect(
      await screen.findByRole("img", { name: "Two-factor QR code" }),
    ).toBeInTheDocument();
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeVisible();
    expect(screen.getByText(/shown only once/i)).toBeVisible();
    for (const backupCode of BACKUP_CODES) {
      expect(screen.getByText(backupCode)).toBeVisible();
    }

    // Enrollment activates only after a valid code, so the refreshed session
    // then reports it as on.
    client.getSession.mockResolvedValue(enabledSession);
    await user.type(screen.getByLabelText("Authentication code"), "123456");
    await user.click(
      screen.getByRole("button", { name: "Verify and turn on" }),
    );

    await waitFor(() =>
      expect(client.verifyTotp).toHaveBeenCalledWith("123456", false),
    );
    expect(
      await screen.findByText("Two-factor authentication is on."),
    ).toBeVisible();
  });

  it("turns off two-factor authentication", async () => {
    const client = renderSettings(
      [{ providerId: "credential" }],
      enabledSession,
    );
    client.disableTwoFactor.mockResolvedValue();

    expect(
      await screen.findByText("Two-factor authentication is on."),
    ).toBeVisible();
    // The turn-off refresh reports the disabled session.
    client.getSession.mockResolvedValue(session);

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", {
        name: "Turn off two-factor authentication",
      }),
    );
    await user.type(
      screen.getByLabelText("Confirm your password"),
      "super-secret-1",
    );
    await user.click(screen.getByRole("button", { name: "Turn off" }));

    await waitFor(() =>
      expect(client.disableTwoFactor).toHaveBeenCalledWith("super-secret-1"),
    );
    expect(
      await screen.findByText("Two-factor authentication is off."),
    ).toBeVisible();
  });

  it("regenerates backup codes", async () => {
    const client = renderSettings(
      [{ providerId: "credential" }],
      enabledSession,
    );
    const codes = ["new1-1111", "new2-2222"];
    client.generateBackupCodes.mockResolvedValue({ backupCodes: codes });

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Regenerate backup codes" }),
    );
    await user.type(
      screen.getByLabelText("Confirm your password"),
      "super-secret-1",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(client.generateBackupCodes).toHaveBeenCalledWith("super-secret-1"),
    );
    expect(screen.getByText(/shown only once/i)).toBeVisible();
    for (const backupCode of codes) {
      expect(screen.getByText(backupCode)).toBeVisible();
    }
  });

  it("shows an error when the password is rejected while enabling", async () => {
    const client = renderSettings([{ providerId: "credential" }]);
    client.enableTwoFactor.mockRejectedValue(new Error("Invalid password."));

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: "Enable two-factor authentication",
      }),
    );
    await user.type(
      screen.getByLabelText("Confirm your password"),
      "wrong-password",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Invalid password.")).toBeVisible();
  });

  it("shows an error when the verification code is invalid", async () => {
    const client = renderSettings([{ providerId: "credential" }]);
    client.enableTwoFactor.mockResolvedValue({
      backupCodes: BACKUP_CODES,
      totpURI: TOTP_URI,
    });
    client.verifyTotp.mockRejectedValue(new Error("Invalid code."));

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: "Enable two-factor authentication",
      }),
    );
    await user.type(
      screen.getByLabelText("Confirm your password"),
      "super-secret-1",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(
      await screen.findByLabelText("Authentication code"),
      "000000",
    );
    await user.click(
      screen.getByRole("button", { name: "Verify and turn on" }),
    );

    expect(await screen.findByText("Invalid code.")).toBeVisible();
  });
});
