import type { SessionResponse } from "@open-excalidraw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { HttpApiClient } from "../../shared/api";
import {
  CookieAuthClient,
  type AuthClient,
  type EmailSignInInput,
  type EmailSignUpInput,
  type LinkedAccount,
  type OAuthProvider,
} from "./auth-client";
import {
  ForgotPasswordPage,
  LoginPage,
  ResetPasswordPage,
  SignUpPage,
} from "./AuthPages";
import { AuthProvider, useAuth } from "./AuthProvider";
import { registerProtectedStatePurge } from "./protected-state";
import { getSafeReturnPath } from "./return-path";

const anonymousSession: SessionResponse = {
  capabilities: {
    emailPassword: true,
    github: true,
    google: false,
    oidc: true,
    oidcProviderName: "Keycloak",
    signupsDisabled: false,
    smtp: false,
  },
  user: null,
};

const signedInSession: SessionResponse = {
  ...anonymousSession,
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
  readonly disableTwoFactor = vi.fn<(password: string) => Promise<void>>();
  readonly enableTwoFactor =
    vi.fn<
      (password: string) => Promise<{ backupCodes: string[]; totpURI: string }>
    >();
  readonly generateBackupCodes =
    vi.fn<(password: string) => Promise<{ backupCodes: string[] }>>();
  readonly getSession = vi.fn<() => Promise<SessionResponse>>();
  readonly getTotpUri =
    vi.fn<(password: string) => Promise<{ totpURI: string }>>();
  readonly linkSocial =
    vi.fn<(provider: OAuthProvider, returnPath: string) => Promise<void>>();
  readonly listAccounts = vi.fn<() => Promise<LinkedAccount[]>>();
  readonly setPassword = vi.fn<(newPassword: string) => Promise<void>>();
  readonly unlinkAccount = vi.fn<(providerId: string) => Promise<void>>();
  readonly requestPasswordReset =
    vi.fn<(email: string, redirectTo: string) => Promise<void>>();
  readonly resendVerification =
    vi.fn<(email: string, callbackURL: string) => Promise<void>>();
  readonly resetPassword =
    vi.fn<(newPassword: string, token: string) => Promise<void>>();
  readonly signIn =
    vi.fn<
      (input: EmailSignInInput) => Promise<{ twoFactorRedirect: boolean }>
    >();
  readonly signOut = vi.fn<() => Promise<void>>();
  readonly signUp = vi.fn<(input: EmailSignUpInput) => Promise<void>>();
  readonly startOAuth =
    vi.fn<(provider: OAuthProvider, returnPath: string) => Promise<void>>();
  readonly verifyBackupCode =
    vi.fn<(code: string, trustDevice: boolean) => Promise<void>>();
  readonly verifyTotp =
    vi.fn<(code: string, trustDevice: boolean) => Promise<void>>();
}

const renderAuthRoute = (
  path: string,
  client: FakeAuthClient,
  page: "login" | "signup" = "login",
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              element={page === "login" ? <LoginPage /> : <SignUpPage />}
              path={page === "login" ? "/login" : "/signup"}
            />
            <Route
              element={<p>Invitation destination</p>}
              path="/invite/:token"
            />
            <Route element={<p>Dashboard destination</p>} path="/app" />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
};

const renderPasswordRoute = (
  path: string,
  client: FakeAuthClient,
  page: "forgot" | "reset",
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          {page === "forgot" ? <ForgotPasswordPage /> : <ResetPasswordPage />}
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
};

describe("safe auth return paths", () => {
  it("accepts local invitation paths and rejects cross-origin targets", () => {
    expect(
      getSafeReturnPath(
        "/invite/invitation-token?source=email",
        "https://draw.example",
      ),
    ).toBe("/invite/invitation-token?source=email");
    expect(
      getSafeReturnPath(
        "https://draw.example/drawings/one#canvas",
        "https://draw.example",
      ),
    ).toBe("/drawings/one#canvas");
    expect(
      getSafeReturnPath(
        "https://attacker.example/phish",
        "https://draw.example",
      ),
    ).toBe("/app");
    expect(
      getSafeReturnPath("//attacker.example", "https://draw.example"),
    ).toBe("/app");
  });
});

describe("auth pages", () => {
  it("validates credentials, shows only enabled OAuth providers, and returns to an invitation", async () => {
    const user = userEvent.setup();
    const client = new FakeAuthClient();
    client.getSession
      .mockResolvedValueOnce(anonymousSession)
      .mockResolvedValueOnce(signedInSession);
    client.signIn.mockResolvedValue({ twoFactorRedirect: false });
    client.startOAuth.mockResolvedValue();
    renderAuthRoute("/login?returnTo=%2Finvite%2Fpending-token", client);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /github/i }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /google/i }),
    ).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Email"), "not-an-email");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a valid email address.",
    );
    expect(client.signIn).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText("Email"));
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(screen.getByText("Invitation destination")).toBeInTheDocument(),
    );
    expect(client.signIn).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "correct-horse",
    });
  });

  it("signs in without a challenge when two-factor is disabled", async () => {
    const user = userEvent.setup();
    const client = new FakeAuthClient();
    client.getSession
      .mockResolvedValueOnce(anonymousSession)
      .mockResolvedValueOnce(signedInSession);
    client.signIn.mockResolvedValue({ twoFactorRedirect: false });
    renderAuthRoute("/login?returnTo=%2Finvite%2Fpending-token", client);

    await user.type(await screen.findByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(screen.getByText("Invitation destination")).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("heading", { name: "Two-factor authentication" }),
    ).not.toBeInTheDocument();
    expect(client.verifyTotp).not.toHaveBeenCalled();
  });

  it("challenges for a TOTP code and finishes sign-in on success", async () => {
    const user = userEvent.setup();
    const client = new FakeAuthClient();
    client.getSession
      .mockResolvedValueOnce(anonymousSession)
      .mockResolvedValue(signedInSession);
    client.signIn.mockResolvedValue({ twoFactorRedirect: true });
    client.verifyTotp.mockResolvedValue();
    renderAuthRoute("/login?returnTo=%2Finvite%2Fpending-token", client);

    await user.type(await screen.findByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(
      await screen.findByRole("heading", {
        name: "Two-factor authentication",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Invitation destination"),
    ).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Authentication code"), "123456");
    await user.click(
      screen.getByRole("checkbox", { name: /trust this device/i }),
    );
    await user.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() =>
      expect(screen.getByText("Invitation destination")).toBeInTheDocument(),
    );
    expect(client.verifyTotp).toHaveBeenCalledWith("123456", true);
  });

  it("verifies a backup code when the authenticator is unavailable", async () => {
    const user = userEvent.setup();
    const client = new FakeAuthClient();
    client.getSession
      .mockResolvedValueOnce(anonymousSession)
      .mockResolvedValue(signedInSession);
    client.signIn.mockResolvedValue({ twoFactorRedirect: true });
    client.verifyBackupCode.mockResolvedValue();
    renderAuthRoute("/login?returnTo=%2Finvite%2Fpending-token", client);

    await user.type(await screen.findByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await user.click(
      await screen.findByRole("button", {
        name: "Use a backup code instead",
      }),
    );
    await user.type(screen.getByLabelText("Backup code"), "abcde-fghij");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() =>
      expect(screen.getByText("Invitation destination")).toBeInTheDocument(),
    );
    expect(client.verifyBackupCode).toHaveBeenCalledWith("abcde-fghij", false);
    expect(client.verifyTotp).not.toHaveBeenCalled();
  });

  it("shows an inline error and stays on the challenge when a code is rejected", async () => {
    const user = userEvent.setup();
    const client = new FakeAuthClient();
    client.getSession.mockResolvedValue(anonymousSession);
    client.signIn.mockResolvedValue({ twoFactorRedirect: true });
    client.verifyTotp.mockRejectedValue(new Error("Invalid code"));
    renderAuthRoute("/login", client);

    await user.type(await screen.findByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await user.type(
      await screen.findByLabelText("Authentication code"),
      "000000",
    );
    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid code");
    expect(
      screen.getByRole("heading", { name: "Two-factor authentication" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(
      screen.getByRole("button", { name: "Sign in" }),
    ).toBeInTheDocument();
  });

  it("starts single sign-on with the provider named by the deployment", async () => {
    const user = userEvent.setup();
    const client = new FakeAuthClient();
    client.getSession.mockResolvedValue(anonymousSession);
    client.startOAuth.mockResolvedValue();
    renderAuthRoute("/login?returnTo=%2Finvite%2Fpending-token", client);

    await user.click(
      await screen.findByRole("button", { name: "Continue with Keycloak" }),
    );

    await waitFor(() =>
      expect(client.startOAuth).toHaveBeenCalledWith(
        "oidc",
        "/invite/pending-token",
      ),
    );
  });

  it("hides the single sign-on button when the deployment disables it", async () => {
    const client = new FakeAuthClient();
    client.getSession.mockResolvedValue({
      ...anonymousSession,
      capabilities: { ...anonymousSession.capabilities, oidc: false },
    });
    renderAuthRoute("/login", client);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /github/i }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /continue with keycloak/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the single sign-on button when it is the only provider", async () => {
    const client = new FakeAuthClient();
    client.getSession.mockResolvedValue({
      ...anonymousSession,
      capabilities: {
        ...anonymousSession.capabilities,
        github: false,
        google: false,
      },
    });
    renderAuthRoute("/login", client);

    expect(
      await screen.findByRole("button", { name: "Continue with Keycloak" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /github/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /google/i }),
    ).not.toBeInTheDocument();
  });

  it("validates sign-up names and falls back from an unsafe return path", async () => {
    const user = userEvent.setup();
    const client = new FakeAuthClient();
    client.getSession
      .mockResolvedValueOnce(anonymousSession)
      .mockResolvedValueOnce(signedInSession);
    client.signUp.mockResolvedValue();
    renderAuthRoute(
      "/signup?returnTo=https%3A%2F%2Fattacker.example%2Fsteal",
      client,
      "signup",
    );

    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your name.");

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "x".repeat(121) },
    });
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Name must be 120 characters or fewer.",
    );

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "12345678901");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Password must be at least 12 characters.",
    );

    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() =>
      expect(screen.getByText("Dashboard destination")).toBeInTheDocument(),
    );
    expect(client.signUp).toHaveBeenCalledWith({
      callbackURL: "/app",
      email: "ada@example.com",
      name: "Ada",
      password: "correct-horse",
    });
  });

  it("replaces the sign-up form with a notice when signups are disabled", async () => {
    const client = new FakeAuthClient();
    client.getSession.mockResolvedValue({
      ...anonymousSession,
      capabilities: { ...anonymousSession.capabilities, signupsDisabled: true },
    });
    renderAuthRoute("/signup", client, "signup");

    expect(
      await screen.findByRole("heading", { name: "Signups are disabled" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create account" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
  });

  it("hides the create-account link on sign in only when signups are disabled", async () => {
    const enabled = new FakeAuthClient();
    enabled.getSession.mockResolvedValue(anonymousSession);
    const { unmount } = renderAuthRoute("/login", enabled);
    expect(
      await screen.findByRole("link", { name: "Create an account" }),
    ).toBeInTheDocument();
    unmount();

    const disabled = new FakeAuthClient();
    disabled.getSession.mockResolvedValue({
      ...anonymousSession,
      capabilities: { ...anonymousSession.capabilities, signupsDisabled: true },
    });
    renderAuthRoute("/login", disabled);
    await screen.findByRole("button", { name: "Sign in" });
    expect(
      screen.queryByRole("link", { name: "Create an account" }),
    ).not.toBeInTheDocument();
  });

  it("preserves an invitation return path while email verification is pending", async () => {
    const user = userEvent.setup();
    const client = new FakeAuthClient();
    const verificationSession: SessionResponse = {
      capabilities: { ...anonymousSession.capabilities, smtp: true },
      user: null,
    };
    client.getSession.mockResolvedValue(verificationSession);
    client.signUp.mockResolvedValue();
    renderAuthRoute(
      "/signup?returnTo=%2Finvite%2Fpending-token",
      client,
      "signup",
    );

    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      await screen.findByRole("heading", { name: "Check your email" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Invitation destination"),
    ).not.toBeInTheDocument();
    expect(client.signUp).toHaveBeenCalledWith({
      callbackURL: "/invite/pending-token",
      email: "ada@example.com",
      name: "Ada",
      password: "correct-horse",
    });
    expect(
      screen.getByRole("link", { name: "Sign in after verifying" }),
    ).toHaveAttribute("href", "/login?returnTo=%2Finvite%2Fpending-token");
  });

  it("surfaces failed verification callbacks and requests a replacement link", async () => {
    const user = userEvent.setup();
    const client = new FakeAuthClient();
    client.getSession.mockResolvedValue({
      ...anonymousSession,
      capabilities: { ...anonymousSession.capabilities, smtp: true },
    });
    client.resendVerification.mockResolvedValue();
    renderAuthRoute(
      "/login?error=token_expired&returnTo=%2Finvite%2Fpending-token",
      client,
    );

    expect(
      await screen.findByText(/verification link is invalid or expired/i),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(
      screen.getByRole("button", { name: "Resend verification email" }),
    );

    await waitFor(() =>
      expect(client.resendVerification).toHaveBeenCalledWith(
        "ada@example.com",
        "/invite/pending-token",
      ),
    );
    expect(
      screen.getByText("A new verification link has been requested."),
    ).toBeInTheDocument();
  });

  it("requests a non-enumerating password reset", async () => {
    const user = userEvent.setup();
    const client = new FakeAuthClient();
    client.getSession.mockResolvedValue(anonymousSession);
    client.requestPasswordReset.mockResolvedValue();
    renderPasswordRoute("/forgot-password", client, "forgot");

    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Request reset" }));

    expect(
      await screen.findByText(/if an account exists/i),
    ).toBeInTheDocument();
    expect(client.requestPasswordReset).toHaveBeenCalledWith(
      "ada@example.com",
      "/reset-password",
    );
  });

  it("validates and consumes a password-reset token", async () => {
    const user = userEvent.setup();
    const client = new FakeAuthClient();
    client.getSession.mockResolvedValue(anonymousSession);
    client.resetPassword.mockResolvedValue();
    renderPasswordRoute(
      "/reset-password?token=one-time-token",
      client,
      "reset",
    );

    await user.type(screen.getByLabelText("New password"), "new-password-123");
    await user.type(
      screen.getByLabelText("Confirm password"),
      "new-password-123",
    );
    await user.click(screen.getByRole("button", { name: "Update password" }));

    expect(await screen.findByText(/password updated/i)).toBeInTheDocument();
    expect(client.resetPassword).toHaveBeenCalledWith(
      "new-password-123",
      "one-time-token",
    );
  });
});

describe("cookie auth state", () => {
  it("does not let a stale bootstrap response overwrite a newer sign-in", async () => {
    let resolveBootstrap!: (session: SessionResponse) => void;
    const bootstrap = new Promise<SessionResponse>((resolve) => {
      resolveBootstrap = resolve;
    });
    const client = new FakeAuthClient();
    client.getSession
      .mockReturnValueOnce(bootstrap)
      .mockResolvedValueOnce(signedInSession);
    client.signIn.mockResolvedValue({ twoFactorRedirect: false });
    const queryClient = new QueryClient();

    const SessionProbe = () => {
      const auth = useAuth();
      return (
        <>
          <span>{auth.user?.email ?? "anonymous"}</span>
          <button
            onClick={() =>
              void auth.signIn({
                email: "ada@example.com",
                password: "correct-horse",
              })
            }
            type="button"
          >
            Sign in now
          </button>
        </>
      );
    };

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider client={client}>
          <SessionProbe />
        </AuthProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(client.getSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Sign in now" }));
    await screen.findByText("ada@example.com");
    act(() => resolveBootstrap(anonymousSession));
    await Promise.resolve();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
  });

  it("never stores authentication tokens in local or session storage", async () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const navigate = vi.fn();
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.credentials !== "include") {
        return Promise.reject(new Error("Credentials were not included"));
      }

      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

      if (url.endsWith("/v1/me")) {
        return Promise.resolve(
          new Response(JSON.stringify(anonymousSession), { status: 200 }),
        );
      }

      if (url.endsWith("/auth/sign-in/social")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ url: "https://accounts.example/oauth" }),
            { status: 200 },
          ),
        );
      }

      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const client = new CookieAuthClient({
      api: new HttpApiClient({ fetch }),
      navigate,
    });

    await client.getSession();
    await client.requestPasswordReset("ada@example.com", "/reset-password");
    await client.signIn({ email: "ada@example.com", password: "password-1" });
    await client.signUp({
      callbackURL: "https://attacker.example/steal",
      email: "ada@example.com",
      name: "Ada",
      password: "password-1",
    });
    await client.startOAuth("github", "/invite/token");
    await client.resetPassword("new-password-123", "reset-token");
    await client.signOut();

    expect(storageWrite).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("https://accounts.example/oauth");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/sign-in/email"),
      expect.objectContaining({ credentials: "include" }),
    );
    const signUpCall = fetch.mock.calls.find(([input]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return url.endsWith("/auth/sign-up/email");
    });
    const signUpBody = signUpCall?.[1]?.body;
    expect(typeof signUpBody).toBe("string");
    expect(
      JSON.parse(typeof signUpBody === "string" ? signUpBody : "{}"),
    ).toMatchObject({
      callbackURL: "/app",
    });
    storageWrite.mockRestore();
  });

  it("starts and links single sign-on through the oauth2 endpoints", async () => {
    const navigate = vi.fn();
    const bodies = new Map<string, unknown>();
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const body = init?.body;
      bodies.set(url, JSON.parse(typeof body === "string" ? body : "{}"));
      return Promise.resolve(
        new Response(JSON.stringify({ url: "https://sso.example/authorize" }), {
          status: 200,
        }),
      );
    });
    const client = new CookieAuthClient({
      api: new HttpApiClient({ fetch }),
      navigate,
    });

    await client.startOAuth("oidc", "/invite/token");
    await client.linkSocial("oidc", "/app/settings");

    expect(bodies.get("/api/auth/sign-in/oauth2")).toEqual({
      callbackURL: "/invite/token",
      providerId: "oidc",
    });
    expect(bodies.get("/api/auth/oauth2/link")).toEqual({
      callbackURL: "/app/settings",
      providerId: "oidc",
    });
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledWith("https://sso.example/authorize");
  });

  it("links a social provider through the link-social endpoint", async () => {
    const navigate = vi.fn();
    const bodies = new Map<string, unknown>();
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const body = init?.body;
      bodies.set(url, JSON.parse(typeof body === "string" ? body : "{}"));
      return Promise.resolve(
        new Response(
          JSON.stringify({ url: "https://github.example/authorize" }),
          { status: 200 },
        ),
      );
    });
    const client = new CookieAuthClient({
      api: new HttpApiClient({ fetch }),
      navigate,
    });

    await client.linkSocial("github", "/app/settings");

    expect(bodies.get("/api/auth/link-social")).toEqual({
      callbackURL: "/app/settings",
      provider: "github",
    });
    expect(navigate).toHaveBeenCalledWith("https://github.example/authorize");
  });

  it("drives the two-factor endpoints and surfaces a TOTP challenge from a 200 body", async () => {
    const bodies = new Map<string, unknown>();
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const body = init?.body;
      bodies.set(url, JSON.parse(typeof body === "string" ? body : "{}"));

      if (url.endsWith("/auth/sign-in/email")) {
        return Promise.resolve(
          new Response(JSON.stringify({ twoFactorRedirect: true }), {
            status: 200,
          }),
        );
      }
      if (url.endsWith("/auth/two-factor/enable")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              backupCodes: ["aaaaa-bbbbb"],
              totpURI: "otpauth://totp/Example",
            }),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith("/auth/two-factor/get-totp-uri")) {
        return Promise.resolve(
          new Response(JSON.stringify({ totpURI: "otpauth://totp/Example" }), {
            status: 200,
          }),
        );
      }
      if (url.endsWith("/auth/two-factor/generate-backup-codes")) {
        return Promise.resolve(
          new Response(JSON.stringify({ backupCodes: ["ccccc-ddddd"] }), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const client = new CookieAuthClient({
      api: new HttpApiClient({ fetch }),
      navigate: vi.fn(),
    });

    expect(
      await client.signIn({
        email: "ada@example.com",
        password: "correct-horse",
      }),
    ).toEqual({ twoFactorRedirect: true });
    expect(await client.enableTwoFactor("correct-horse")).toEqual({
      backupCodes: ["aaaaa-bbbbb"],
      totpURI: "otpauth://totp/Example",
    });
    expect(await client.getTotpUri("correct-horse")).toEqual({
      totpURI: "otpauth://totp/Example",
    });
    expect(await client.generateBackupCodes("correct-horse")).toEqual({
      backupCodes: ["ccccc-ddddd"],
    });
    await client.verifyTotp("123456", true);
    await client.verifyBackupCode("abcde-fghij", false);

    expect(bodies.get("/api/auth/sign-in/email")).toEqual({
      email: "ada@example.com",
      password: "correct-horse",
    });
    expect(bodies.get("/api/auth/two-factor/enable")).toEqual({
      password: "correct-horse",
    });
    expect(bodies.get("/api/auth/two-factor/get-totp-uri")).toEqual({
      password: "correct-horse",
    });
    expect(bodies.get("/api/auth/two-factor/generate-backup-codes")).toEqual({
      password: "correct-horse",
    });
    expect(bodies.get("/api/auth/two-factor/verify-totp")).toEqual({
      code: "123456",
      trustDevice: true,
    });
    expect(bodies.get("/api/auth/two-factor/verify-backup-code")).toEqual({
      code: "abcde-fghij",
      trustDevice: false,
    });
  });

  it("purges protected queries and editor state on logout", async () => {
    const client = new FakeAuthClient();
    client.getSession.mockResolvedValue(signedInSession);
    client.signOut.mockResolvedValue();
    const queryClient = new QueryClient();
    queryClient.setQueryData(["protected", "drawing"], { secret: true });
    const purgeEditor = vi.fn();
    const unregister = registerProtectedStatePurge(purgeEditor);

    const LogoutButton = () => {
      const auth = useAuth();
      return (
        <button onClick={() => void auth.logout()} type="button">
          Log out
        </button>
      );
    };

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider client={client}>
          <LogoutButton />
        </AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(client.getSession).toHaveBeenCalled());
    act(() => {
      screen.getByRole("button", { name: "Log out" }).click();
    });

    await waitFor(() => expect(client.signOut).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0),
    );
    await waitFor(() => expect(purgeEditor).toHaveBeenCalledOnce());
    unregister();
  });

  it("clears the per-browser thumbnail cache on logout", async () => {
    const cachesDelete = vi.fn().mockResolvedValue(true);
    // jsdom has no Cache API; stand one in so logout can drop the SW cache.
    vi.stubGlobal("caches", { delete: cachesDelete });

    const client = new FakeAuthClient();
    client.getSession.mockResolvedValue(signedInSession);
    client.signOut.mockResolvedValue();

    const LogoutButton = () => {
      const auth = useAuth();
      return (
        <button onClick={() => void auth.logout()} type="button">
          Log out
        </button>
      );
    };

    render(
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider client={client}>
          <LogoutButton />
        </AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(client.getSession).toHaveBeenCalled());
    act(() => {
      screen.getByRole("button", { name: "Log out" }).click();
    });

    await waitFor(() =>
      expect(cachesDelete).toHaveBeenCalledWith("drawing-thumbnails"),
    );
    vi.unstubAllGlobals();
  });
});
