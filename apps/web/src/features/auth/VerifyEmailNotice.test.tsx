import type { SessionResponse } from "@open-excalidraw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type {
  AuthClient,
  EmailSignInInput,
  EmailSignUpInput,
  LinkedAccount,
  OAuthProvider,
} from "./auth-client";
import { AuthProvider, useAuth } from "./AuthProvider";
import { VerifyEmailNotice } from "./VerifyEmailNotice";

const AuthStatusProbe = () => <p>{`auth status: ${useAuth().status}`}</p>;

const session = (emailVerified: boolean): SessionResponse => ({
  capabilities: {
    emailPassword: true,
    github: false,
    google: false,
    oidc: false,
    oidcProviderName: "SSO",
    signupsDisabled: false,
    smtp: true,
  },
  user: {
    createdAt: "2026-07-10T10:00:00.000Z",
    email: "ada@example.com",
    emailVerified,
    id: "be21c1cd-a5d5-49f9-b9dd-a30e3cb80e09",
    image: null,
    isAdmin: false,
    name: "Ada",
    twoFactorEnabled: false,
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

const renderNotice = (emailVerified: boolean) => {
  const client = new FakeAuthClient();
  client.getSession.mockResolvedValue(session(emailVerified));
  client.resendVerification.mockResolvedValue();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider client={client}>
        <VerifyEmailNotice />
        <AuthStatusProbe />
      </AuthProvider>
    </QueryClientProvider>,
  );

  return client;
};

describe("VerifyEmailNotice", () => {
  it("prompts unverified users and resends the verification link", async () => {
    const client = renderNotice(false);

    expect(await screen.findByText("Verify your email")).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Resend link" }));

    await waitFor(() =>
      expect(client.resendVerification).toHaveBeenCalledWith(
        "ada@example.com",
        "/app",
      ),
    );
    expect(
      await screen.findByText(/A new verification link is on its way/),
    ).toBeVisible();
  });

  it("renders nothing for verified users", async () => {
    renderNotice(true);

    // Wait for the session to be committed, not merely requested, so the
    // absence check runs against the verified user's render.
    expect(await screen.findByText("auth status: ready")).toBeInTheDocument();
    expect(screen.queryByText("Verify your email")).not.toBeInTheDocument();
  });
});
