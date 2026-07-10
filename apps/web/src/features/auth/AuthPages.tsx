import { type FormEvent, useState } from "react";
import {
  Link,
  useNavigate,
  useSearchParams,
  type NavigateFunction,
} from "react-router-dom";

import { useAuth } from "./AuthProvider";
import type { OAuthProvider } from "./auth-client";
import { getSafeReturnPath } from "./return-path";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MINIMUM_PASSWORD_LENGTH = 12;
const MAXIMUM_NAME_LENGTH = 120;

interface Credentials {
  email: string;
  name: string;
  password: string;
}

type AuthPageMode = "login" | "signup";

const validateCredentials = (
  mode: AuthPageMode,
  credentials: Credentials,
): string | null => {
  if (mode === "signup" && !credentials.name.trim()) {
    return "Enter your name.";
  }

  if (
    mode === "signup" &&
    credentials.name.trim().length > MAXIMUM_NAME_LENGTH
  ) {
    return `Name must be ${MAXIMUM_NAME_LENGTH} characters or fewer.`;
  }

  if (!EMAIL_PATTERN.test(credentials.email.trim())) {
    return "Enter a valid email address.";
  }

  if (credentials.password.length < MINIMUM_PASSWORD_LENGTH) {
    return `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`;
  }

  return null;
};

const finishAuthentication = (
  navigate: NavigateFunction,
  returnPath: string,
) => {
  void navigate(returnPath, { replace: true });
};

const AuthPage = ({ mode }: { mode: AuthPageMode }) => {
  const auth = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnPath = getSafeReturnPath(searchParams.get("returnTo"));
  const verificationFailed = searchParams.has("error");
  const [credentials, setCredentials] = useState<Credentials>({
    email: "",
    name: "",
    password: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [signupNextStep, setSignupNextStep] = useState<
    "signin" | "verification" | null
  >(null);
  const [verificationNotice, setVerificationNotice] = useState<string | null>(
    null,
  );
  const isSignUp = mode === "signup";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validationError = validateCredentials(mode, credentials);

    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      if (isSignUp) {
        const nextSession = await auth.signUp({
          callbackURL: returnPath,
          email: credentials.email.trim(),
          name: credentials.name.trim(),
          password: credentials.password,
        });
        if (!nextSession.user) {
          setSignupNextStep(auth.capabilities.smtp ? "verification" : "signin");
          return;
        }
      } else {
        await auth.signIn({
          email: credentials.email.trim(),
          password: credentials.password,
        });
      }

      finishAuthentication(navigate, returnPath);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Authentication failed. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const startOAuth = async (provider: OAuthProvider) => {
    setSubmitting(true);
    setError(null);

    try {
      await auth.startOAuth(provider, returnPath);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not start OAuth sign in.",
      );
      setSubmitting(false);
    }
  };

  const resendVerification = async () => {
    const email = credentials.email.trim();
    if (!EMAIL_PATTERN.test(email)) {
      setError("Enter your email address before requesting another link.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await auth.resendVerification(email, returnPath);
      setVerificationNotice("A new verification link has been requested.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not request another verification link.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <section aria-labelledby="auth-title" className="auth-card">
        <Link className="auth-brand" to="/">
          Open Excalidraw
        </Link>
        <h1 id="auth-title">
          {isSignUp ? "Create your account" : "Welcome back"}
        </h1>
        <p>
          {isSignUp
            ? "Save drawings and collaborate with your team."
            : "Sign in to open your saved drawings."}
        </p>

        {verificationFailed ? (
          <p role="alert">
            That verification link is invalid or expired. Enter your email and
            request a new link.
          </p>
        ) : null}
        {verificationNotice ? <p role="status">{verificationNotice}</p> : null}

        {signupNextStep ? (
          <section aria-live="polite" className="auth-next-step">
            <h2>
              {signupNextStep === "verification"
                ? "Check your email"
                : "Account created"}
            </h2>
            <p>
              {signupNextStep === "verification"
                ? `We sent a verification link to ${credentials.email.trim()}. Open it to finish signing in.`
                : "Sign in to continue to your destination."}
            </p>
            <Link to={`/login?returnTo=${encodeURIComponent(returnPath)}`}>
              {signupNextStep === "verification"
                ? "Sign in after verifying"
                : "Continue to sign in"}
            </Link>
          </section>
        ) : (
          <form noValidate onSubmit={(event) => void submit(event)}>
            {isSignUp ? (
              <label>
                Name
                <input
                  autoComplete="name"
                  maxLength={MAXIMUM_NAME_LENGTH}
                  name="name"
                  onChange={(event) =>
                    setCredentials((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  value={credentials.name}
                />
              </label>
            ) : null}
            <label>
              Email
              <input
                autoComplete="email"
                inputMode="email"
                name="email"
                onChange={(event) =>
                  setCredentials((current) => ({
                    ...current,
                    email: event.target.value,
                  }))
                }
                type="email"
                value={credentials.email}
              />
            </label>
            <label>
              Password
              <input
                autoComplete={isSignUp ? "new-password" : "current-password"}
                name="password"
                onChange={(event) =>
                  setCredentials((current) => ({
                    ...current,
                    password: event.target.value,
                  }))
                }
                type="password"
                value={credentials.password}
              />
            </label>

            {error ? <p role="alert">{error}</p> : null}
            <button
              disabled={submitting || auth.status === "loading"}
              type="submit"
            >
              {submitting
                ? "Please wait…"
                : isSignUp
                  ? "Create account"
                  : "Sign in"}
            </button>
            {verificationFailed && auth.capabilities.smtp ? (
              <button
                disabled={submitting || auth.status === "loading"}
                onClick={() => void resendVerification()}
                type="button"
              >
                Resend verification email
              </button>
            ) : null}
          </form>
        )}

        {!signupNextStep &&
        (auth.capabilities.google || auth.capabilities.github) ? (
          <div aria-label="Social sign in" className="auth-social">
            <span>or</span>
            {auth.capabilities.google ? (
              <button
                disabled={submitting || auth.status === "loading"}
                onClick={() => void startOAuth("google")}
                type="button"
              >
                Continue with Google
              </button>
            ) : null}
            {auth.capabilities.github ? (
              <button
                disabled={submitting || auth.status === "loading"}
                onClick={() => void startOAuth("github")}
                type="button"
              >
                Continue with GitHub
              </button>
            ) : null}
          </div>
        ) : null}

        <p>
          {isSignUp ? "Already have an account?" : "New to Open Excalidraw?"}{" "}
          <Link
            to={`${isSignUp ? "/login" : "/signup"}?returnTo=${encodeURIComponent(returnPath)}`}
          >
            {isSignUp ? "Sign in" : "Create an account"}
          </Link>
        </p>
      </section>
    </main>
  );
};

export const LoginPage = () => <AuthPage mode="login" />;
export const SignUpPage = () => <AuthPage mode="signup" />;
