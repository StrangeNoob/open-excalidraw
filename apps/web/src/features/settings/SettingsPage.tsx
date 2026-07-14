import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactElement, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useAuth } from "../auth";
import type { OAuthProvider } from "../auth";
import { githubIcon, googleIcon } from "../auth/provider-icons";

const MINIMUM_PASSWORD_LENGTH = 12;
const MAXIMUM_PASSWORD_LENGTH = 128;
const ACCOUNTS_QUERY_KEY = ["auth", "accounts"] as const;
const CREDENTIAL_PROVIDER_ID = "credential";

const PROVIDERS: Array<{
  id: OAuthProvider;
  label: string;
  icon: ReactElement;
}> = [
  { id: "google", label: "Google", icon: googleIcon },
  { id: "github", label: "GitHub", icon: githubIcon },
];

const errorMessage = (caught: unknown): string =>
  caught instanceof Error ? caught.message : "The request failed.";

const PasswordSection = ({ hasPassword }: { hasPassword: boolean }) => {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (newPassword.length < MINIMUM_PASSWORD_LENGTH) {
      setError(
        `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`,
      );
      return;
    }
    setSubmitting(true);
    try {
      if (hasPassword) {
        await auth.changePassword(currentPassword, newPassword);
        setNotice("Password changed. Other devices were signed out.");
      } else {
        await auth.setPassword(newPassword);
        setNotice("Password set. You can now sign in with email and password.");
        await queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
      }
      setCurrentPassword("");
      setNewPassword("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section aria-labelledby="settings-password-title">
      <h2 id="settings-password-title">
        {hasPassword ? "Change password" : "Set a password"}
      </h2>
      {hasPassword ? null : (
        <p>
          Your account currently signs in with a provider only. Set a password
          to also sign in with email.
        </p>
      )}
      <form noValidate onSubmit={(event) => void submit(event)}>
        {hasPassword ? (
          <label>
            Current password
            <input
              autoComplete="current-password"
              maxLength={MAXIMUM_PASSWORD_LENGTH}
              onChange={(event) => setCurrentPassword(event.target.value)}
              type="password"
              value={currentPassword}
            />
          </label>
        ) : null}
        <label>
          New password (at least {MINIMUM_PASSWORD_LENGTH} characters)
          <input
            autoComplete="new-password"
            maxLength={MAXIMUM_PASSWORD_LENGTH}
            onChange={(event) => setNewPassword(event.target.value)}
            type="password"
            value={newPassword}
          />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        {notice ? <p role="status">{notice}</p> : null}
        <button disabled={submitting} type="submit">
          {submitting
            ? "Please wait…"
            : hasPassword
              ? "Change password"
              : "Set password"}
        </button>
      </form>
    </section>
  );
};

const ProvidersSection = ({
  linkedProviderIds,
}: {
  linkedProviderIds: string[];
}) => {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const available = PROVIDERS.filter(({ id }) => auth.capabilities[id]);
  // Keep at least one way to sign in; the server enforces this too.
  const lastAccount = linkedProviderIds.length <= 1;

  if (available.length === 0) {
    return null;
  }

  const connect = async (provider: OAuthProvider) => {
    setError(null);
    setBusyProvider(provider);
    try {
      await auth.linkSocial(provider, "/app/settings");
    } catch (caught) {
      setError(errorMessage(caught));
      setBusyProvider(null);
    }
  };

  const disconnect = async (provider: OAuthProvider) => {
    setError(null);
    setBusyProvider(provider);
    try {
      await auth.unlinkAccount(provider);
      await queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyProvider(null);
    }
  };

  return (
    <section aria-labelledby="settings-providers-title">
      <h2 id="settings-providers-title">Connected sign-in providers</h2>
      {error ? <p role="alert">{error}</p> : null}
      <ul className="settings-provider-list">
        {available.map(({ icon, id, label }) => {
          const connected = linkedProviderIds.includes(id);
          return (
            <li className="settings-provider" key={id}>
              <span className="settings-provider-name">
                {icon}
                {label}
              </span>
              {connected ? (
                <button
                  disabled={busyProvider !== null || lastAccount}
                  onClick={() => void disconnect(id)}
                  title={
                    lastAccount
                      ? "Set a password or connect another provider first."
                      : undefined
                  }
                  type="button"
                >
                  {busyProvider === id ? "Please wait…" : "Disconnect"}
                </button>
              ) : (
                <button
                  disabled={busyProvider !== null}
                  onClick={() => void connect(id)}
                  type="button"
                >
                  {busyProvider === id ? "Redirecting…" : "Connect"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};

const SignOutSection = () => {
  const auth = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const signOut = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await auth.logout();
      void navigate("/login", { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
      setSubmitting(false);
    }
  };

  return (
    <section aria-labelledby="settings-signout-title">
      <h2 id="settings-signout-title">Sign out</h2>
      {error ? <p role="alert">{error}</p> : null}
      <button
        className="danger-button"
        disabled={submitting}
        onClick={() => void signOut()}
        type="button"
      >
        {submitting ? "Signing out…" : "Sign out"}
      </button>
    </section>
  );
};

export const SettingsPage = () => {
  const auth = useAuth();
  const accounts = useQuery({
    queryFn: () => auth.listAccounts(),
    queryKey: ACCOUNTS_QUERY_KEY,
  });

  return (
    <main className="dashboard-page settings-page">
      <header className="dashboard-header">
        <div>
          <p className="dashboard-eyebrow">
            <Link to="/app">← Back to your drawings</Link>
          </p>
          <h1>Account settings</h1>
        </div>
      </header>
      {accounts.isPending ? (
        <p aria-live="polite">Loading your account…</p>
      ) : accounts.isError ? (
        <section className="dashboard-error" role="alert">
          <h2>Could not load your account</h2>
          <p>{accounts.error.message}</p>
          <button onClick={() => void accounts.refetch()} type="button">
            Try again
          </button>
        </section>
      ) : (
        <>
          {auth.capabilities.emailPassword ? (
            <PasswordSection
              hasPassword={accounts.data.some(
                (account) => account.providerId === CREDENTIAL_PROVIDER_ID,
              )}
            />
          ) : null}
          <ProvidersSection
            linkedProviderIds={accounts.data.map(
              (account) => account.providerId,
            )}
          />
          <SignOutSection />
        </>
      )}
    </main>
  );
};
