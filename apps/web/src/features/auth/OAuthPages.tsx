import { useEffect, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { z } from "zod";

import { HttpApiClient } from "../../shared/api";
import { BrandMark } from "../brand";
import { useAuth } from "./AuthProvider";

/** Better Auth's authorization endpoint; a full navigation, not a route. */
const AUTHORIZE_ENDPOINT = "/api/auth/mcp/authorize";

/**
 * Plain language for the only two scopes a connector can be granted. The
 * server refuses anything else, so this list is the whole vocabulary.
 */
const SCOPE_DESCRIPTIONS: Record<string, string> = {
  read: "See your drawings and everything in them",
  write: "Create drawings, and change or delete anything in them",
};

const clientSchema = z.object({
  name: z.string(),
  icon: z.string().nullable(),
  redirectOrigins: z.array(z.string()),
});

const consentSchema = z.object({ redirectURI: z.string() });

const api = new HttpApiClient();
const navigateAway = (url: string) => {
  // The server validates redirect URIs at registration; this is the last line
  // if one ever slips through, since a javascript: URL here would run as us.
  const protocol = URL.parse(url)?.protocol;
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error("The application asked for an unsupported redirect.");
  }
  globalThis.location.assign(url);
};

const AuthShell = ({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) => (
  <main className="auth-page">
    <section aria-labelledby="oauth-title" className="auth-card">
      <Link className="auth-brand" to="/">
        <BrandMark size={26} />
        Open Excalidraw
      </Link>
      <h1 id="oauth-title">{title}</h1>
      {children}
    </section>
  </main>
);

const signInFirst = (search: string, path: string) => (
  <Navigate
    replace
    to={`/login?returnTo=${encodeURIComponent(`${path}${search}`)}`}
  />
);

/**
 * Where an authorization request lands when the caller is signed out. The
 * server bounces here through the app's normal login flow, and this page hands
 * the request back to the authorization endpoint once a session exists.
 */
export const OAuthAuthorizePage = () => {
  const auth = useAuth();
  const location = useLocation();
  const signedIn = auth.status === "ready" && Boolean(auth.user);
  const hasRequest = new URLSearchParams(location.search).has("client_id");

  useEffect(() => {
    if (signedIn && hasRequest) {
      navigateAway(`${AUTHORIZE_ENDPOINT}${location.search}`);
    }
  }, [signedIn, hasRequest, location.search]);

  if (auth.status === "loading") {
    return (
      <AuthShell title="One moment">
        <p aria-live="polite">Checking your account…</p>
      </AuthShell>
    );
  }
  if (!hasRequest) {
    return (
      <AuthShell title="Nothing to authorize">
        <p>This page finishes a connection request that has already expired.</p>
        <Link to="/app">Go to your drawings</Link>
      </AuthShell>
    );
  }
  if (!signedIn) {
    return signInFirst(location.search, "/oauth/authorize");
  }
  return (
    <AuthShell title="Connecting">
      <p aria-live="polite">Taking you back to the connection request…</p>
    </AuthShell>
  );
};

/**
 * The consent screen. The authorization endpoint sends every request here
 * before any code is handed out, so this is the point where the user decides.
 */
export const OAuthConsentPage = () => {
  const auth = useAuth();
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const consentCode = query.get("consent_code") ?? "";
  const clientId = query.get("client_id") ?? "";
  const scopes = (query.get("scope") ?? "")
    .split(" ")
    .filter((scope) => scope in SCOPE_DESCRIPTIONS);

  const [clientName, setClientName] = useState<string | null>(null);
  const [redirectOrigins, setRedirectOrigins] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const signedIn = auth.status === "ready" && Boolean(auth.user);

  useEffect(() => {
    if (!signedIn || !clientId) {
      return;
    }
    let active = true;
    void api
      .request(
        `/v1/oauth/clients/${encodeURIComponent(clientId)}`,
        { method: "GET" },
        clientSchema,
      )
      .then((client) => {
        if (active) {
          setClientName(client.name);
          setRedirectOrigins(client.redirectOrigins);
        }
      })
      .catch(() => {
        if (active) {
          setError("That application is no longer registered.");
        }
      });
    return () => {
      active = false;
    };
  }, [signedIn, clientId]);

  const decide = async (accept: boolean) => {
    setSubmitting(true);
    setError(null);
    try {
      const { redirectURI } = await api.request(
        "/auth/oauth2/consent",
        {
          method: "POST",
          body: JSON.stringify({ accept, consent_code: consentCode }),
        },
        consentSchema,
      );
      navigateAway(redirectURI);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The request could not be completed.",
      );
      setSubmitting(false);
    }
  };

  if (auth.status === "loading") {
    return (
      <AuthShell title="One moment">
        <p aria-live="polite">Checking your account…</p>
      </AuthShell>
    );
  }
  if (!signedIn) {
    return signInFirst(location.search, "/oauth/consent");
  }
  if (!consentCode || !clientId) {
    return (
      <AuthShell title="Nothing to approve">
        <p>
          This connection request has expired. Start it again from the app you
          were connecting.
        </p>
        <Link to="/app">Go to your drawings</Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={`${clientName ?? "An application"} wants access`}>
      <p>
        Signed in as {auth.user?.email}. It will act as you, and only within
        Open Excalidraw.
      </p>
      {redirectOrigins.length > 0 && (
        <p>
          Anyone can register an application under any name. Approving this
          sends your access to <strong>{redirectOrigins.join(", ")}</strong> —
          only continue if you recognise it.
        </p>
      )}
      <ul>
        {scopes.map((scope) => (
          <li key={scope}>{SCOPE_DESCRIPTIONS[scope]}</li>
        ))}
      </ul>
      <p>
        It cannot manage your account, your access tokens, or this instance.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <button
        disabled={submitting}
        onClick={() => void decide(true)}
        type="button"
      >
        {submitting ? "Please wait…" : "Allow"}
      </button>
      <button
        disabled={submitting}
        onClick={() => void decide(false)}
        type="button"
      >
        Deny
      </button>
    </AuthShell>
  );
};
