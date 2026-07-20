import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactElement, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { renderSVG } from "uqr";

import { useAuth } from "../auth";
import type { OAuthProvider } from "../auth";
import { githubIcon, googleIcon, ssoIcon } from "../auth/provider-icons";

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
  // The OIDC provider is labelled by the deployment, so its row cannot live
  // in the static list.
  const providers = [
    ...PROVIDERS,
    {
      id: "oidc" as const,
      label: auth.capabilities.oidcProviderName || "SSO",
      icon: ssoIcon,
    },
  ];
  // Linked providers stay visible even if their capability was disabled
  // later, so the user can still disconnect them.
  const available = providers.filter(
    ({ id }) => auth.capabilities[id] || linkedProviderIds.includes(id),
  );
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

const BACKUP_CODES_WARNING =
  "Save these backup codes now. They are shown only once and each code works a single time if you lose your authenticator.";

// The otpauth URI carries the base32 secret as a query parameter; surface it
// for authenticator apps that only take manual entry.
const totpSecret = (totpURI: string): string => {
  try {
    return new URL(totpURI).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
};

const BackupCodesPanel = ({ codes }: { codes: string[] }) => {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      setCopyError(null);
    } catch {
      setCopyError("Could not copy automatically. Select and copy the codes.");
    }
  };

  return (
    <div className="settings-backup-codes">
      <h3>Backup codes</h3>
      <p role="alert">{BACKUP_CODES_WARNING}</p>
      <ul>
        {codes.map((backupCode) => (
          <li key={backupCode}>{backupCode}</li>
        ))}
      </ul>
      <button onClick={() => void copy()} type="button">
        {copied ? "Copied" : "Copy codes"}
      </button>
      {copyError ? <p role="status">{copyError}</p> : null}
    </div>
  );
};

type TwoFactorStep =
  | "disable-password"
  | "enable-password"
  | "enroll"
  | "regenerate-password"
  | "regenerated"
  | "summary";

const TwoFactorSection = () => {
  const auth = useAuth();
  const enabled = auth.user?.twoFactorEnabled ?? false;
  const [step, setStep] = useState<TwoFactorStep>("summary");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [enrollment, setEnrollment] = useState<{
    backupCodes: string[];
    totpURI: string;
  } | null>(null);
  const [newBackupCodes, setNewBackupCodes] = useState<string[] | null>(null);

  const qrSvg = useMemo(
    () => (enrollment ? renderSVG(enrollment.totpURI) : null),
    [enrollment],
  );

  const reset = () => {
    setStep("summary");
    setPassword("");
    setCode("");
    setError(null);
    setEnrollment(null);
    setNewBackupCodes(null);
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (step === "enable-password") {
        setEnrollment(await auth.enableTwoFactor(password));
        setPassword("");
        setStep("enroll");
      } else if (step === "disable-password") {
        await auth.disableTwoFactor(password);
        reset();
      } else if (step === "regenerate-password") {
        const { backupCodes } = await auth.generateBackupCodes(password);
        setNewBackupCodes(backupCodes);
        setPassword("");
        setStep("regenerated");
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  // Enrollment only activates once a generated code verifies, so the session's
  // twoFactorEnabled flag flips here rather than on enable.
  const submitVerification = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await auth.verifyTotp(code.trim(), false);
      reset();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const passwordForm = (submitLabel: string) => (
    <form noValidate onSubmit={(event) => void submitPassword(event)}>
      <label>
        Confirm your password
        <input
          autoComplete="current-password"
          maxLength={MAXIMUM_PASSWORD_LENGTH}
          onChange={(event) => setPassword(event.target.value)}
          type="password"
          value={password}
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <button disabled={submitting} type="submit">
        {submitting ? "Please wait…" : submitLabel}
      </button>
      <button disabled={submitting} onClick={reset} type="button">
        Cancel
      </button>
    </form>
  );

  return (
    <section aria-labelledby="settings-2fa-title">
      <h2 id="settings-2fa-title">Two-factor authentication</h2>
      <p className="settings-2fa-note">
        Sign-ins through a connected provider (Google, GitHub, or SSO) are
        verified by that provider and skip this step.
      </p>

      {step === "summary" ? (
        <>
          <p role="status">
            Two-factor authentication is {enabled ? "on" : "off"}.
          </p>
          {enabled ? (
            <div className="settings-2fa-actions">
              <button
                onClick={() => setStep("regenerate-password")}
                type="button"
              >
                Regenerate backup codes
              </button>
              <button
                className="danger-button"
                onClick={() => setStep("disable-password")}
                type="button"
              >
                Turn off two-factor authentication
              </button>
            </div>
          ) : (
            <button onClick={() => setStep("enable-password")} type="button">
              Enable two-factor authentication
            </button>
          )}
        </>
      ) : null}

      {step === "enable-password" ? (
        <>
          <p>Enter your password to begin setting up an authenticator app.</p>
          {passwordForm("Continue")}
        </>
      ) : null}

      {step === "enroll" && enrollment ? (
        <div className="settings-2fa-enroll">
          <p>
            Scan this QR code with your authenticator app, or enter the setup
            key manually.
          </p>
          {qrSvg ? (
            <div
              aria-label="Two-factor QR code"
              className="settings-2fa-qr"
              dangerouslySetInnerHTML={{ __html: qrSvg }}
              role="img"
            />
          ) : null}
          <p>
            Setup key: <code>{totpSecret(enrollment.totpURI)}</code>
          </p>
          <BackupCodesPanel codes={enrollment.backupCodes} />
          <form noValidate onSubmit={(event) => void submitVerification(event)}>
            <label>
              Authentication code
              <input
                autoComplete="one-time-code"
                inputMode="numeric"
                onChange={(event) => setCode(event.target.value)}
                value={code}
              />
            </label>
            {error ? <p role="alert">{error}</p> : null}
            <button disabled={submitting} type="submit">
              {submitting ? "Verifying…" : "Verify and turn on"}
            </button>
            <button disabled={submitting} onClick={reset} type="button">
              Cancel
            </button>
          </form>
        </div>
      ) : null}

      {step === "disable-password" ? (
        <>
          <p>Enter your password to turn off two-factor authentication.</p>
          {passwordForm("Turn off")}
        </>
      ) : null}

      {step === "regenerate-password" ? (
        <>
          <p>
            Enter your password to generate new backup codes. Your existing
            codes stop working.
          </p>
          {passwordForm("Continue")}
        </>
      ) : null}

      {step === "regenerated" && newBackupCodes ? (
        <>
          <BackupCodesPanel codes={newBackupCodes} />
          <button onClick={reset} type="button">
            Done
          </button>
        </>
      ) : null}
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
          <TwoFactorSection />
          <SignOutSection />
        </>
      )}
    </main>
  );
};
