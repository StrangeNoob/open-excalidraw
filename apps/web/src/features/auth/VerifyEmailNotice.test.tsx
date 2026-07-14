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
import { AuthProvider } from "./AuthProvider";
import { VerifyEmailNotice } from "./VerifyEmailNotice";

const session = (emailVerified: boolean): SessionResponse => ({
  capabilities: {
    emailPassword: true,
    github: false,
    google: false,
    smtp: true,
  },
  user: {
    createdAt: "2026-07-10T10:00:00.000Z",
    email: "ada@example.com",
    emailVerified,
    id: "be21c1cd-a5d5-49f9-b9dd-a30e3cb80e09",
    image: null,
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
    const client = renderNotice(true);

    await waitFor(() => expect(client.getSession).toHaveBeenCalled());
    expect(screen.queryByText("Verify your email")).not.toBeInTheDocument();
  });
});
