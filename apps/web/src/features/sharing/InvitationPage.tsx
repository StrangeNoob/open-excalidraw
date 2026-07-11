import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { useAuth } from "../auth";
import { InvitationClient, type InvitationInspection } from "./api";

import "./sharing.css";

const client = new InvitationClient();

export const InvitationPage = () => {
  const auth = useAuth();
  const navigate = useNavigate();
  const { token = "" } = useParams();
  const [invitation, setInvitation] = useState<InvitationInspection | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    let active = true;
    void client
      .inspect(token)
      .then((result) => {
        if (active) setInvitation(result);
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(
            caught instanceof Error
              ? caught.message
              : "This invitation is invalid or no longer available.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [token]);

  const accept = async () => {
    setAccepting(true);
    setError(null);
    try {
      await client.accept(token);
      if (invitation) {
        void navigate(`/drawings/${invitation.invitation.drawingId}`, {
          replace: true,
        });
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not accept invitation.",
      );
    } finally {
      setAccepting(false);
    }
  };

  const returnPath = `/invite/${encodeURIComponent(token)}`;

  return (
    <main className="invitation-page">
      <section className="invitation-card">
        <Link to="/">Open Excalidraw</Link>
        <h1>Drawing invitation</h1>
        {error ? <p role="alert">{error}</p> : null}
        {!invitation && !error ? (
          <p aria-live="polite">Loading invitation…</p>
        ) : null}
        {invitation ? (
          <>
            <h2>{invitation.drawingTitle}</h2>
            <p>
              You were invited as an{" "}
              <strong>{invitation.invitation.role}</strong> using{" "}
              {invitation.invitation.email}.
            </p>
            {invitation.invitation.status !== "pending" ? (
              <p role="alert">
                {unavailableInvitationMessage(invitation.invitation.status)}
              </p>
            ) : auth.status === "loading" ? (
              <p aria-live="polite">Loading your account…</p>
            ) : auth.user ? (
              <button
                disabled={accepting}
                onClick={() => void accept()}
                type="button"
              >
                {accepting ? "Accepting…" : "Accept invitation"}
              </button>
            ) : (
              <div className="invitation-actions">
                <Link to={`/login?returnTo=${encodeURIComponent(returnPath)}`}>
                  Sign in to accept
                </Link>
                <Link to={`/signup?returnTo=${encodeURIComponent(returnPath)}`}>
                  Create account
                </Link>
              </div>
            )}
          </>
        ) : null}
      </section>
    </main>
  );
};

const unavailableInvitationMessage = (
  status: InvitationInspection["invitation"]["status"],
) => {
  switch (status) {
    case "accepted":
      return "This invitation has already been accepted.";
    case "expired":
      return "This invitation has expired. Ask the drawing owner for a new link.";
    case "revoked":
      return "This invitation was revoked. Ask the drawing owner if you still need access.";
    default:
      return "This invitation is no longer available.";
  }
};
