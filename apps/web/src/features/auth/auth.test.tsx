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
  type OAuthProvider,
} from "./auth-client";
import { LoginPage, SignUpPage } from "./AuthPages";
import { AuthProvider, useAuth } from "./AuthProvider";
import { registerProtectedStatePurge } from "./protected-state";
import { getSafeReturnPath } from "./return-path";

const anonymousSession: SessionResponse = {
  capabilities: {
    emailPassword: true,
    github: true,
    google: false,
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
    name: "Ada",
  },
};

class FakeAuthClient implements AuthClient {
  readonly getSession = vi.fn<() => Promise<SessionResponse>>();
  readonly resendVerification =
    vi.fn<(email: string, callbackURL: string) => Promise<void>>();
  readonly signIn = vi.fn<(input: EmailSignInInput) => Promise<void>>();
  readonly signOut = vi.fn<() => Promise<void>>();
  readonly signUp = vi.fn<(input: EmailSignUpInput) => Promise<void>>();
  readonly startOAuth =
    vi.fn<(provider: OAuthProvider, returnPath: string) => Promise<void>>();
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
    client.signIn.mockResolvedValue();
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
    client.signIn.mockResolvedValue();
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
    await client.signIn({ email: "ada@example.com", password: "password-1" });
    await client.signUp({
      callbackURL: "https://attacker.example/steal",
      email: "ada@example.com",
      name: "Ada",
      password: "password-1",
    });
    await client.startOAuth("github", "/invite/token");
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
});
