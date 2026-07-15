import { useState } from "react";

import { useAuth } from "./AuthProvider";

/**
 * Nudges signed-in users with an unverified email to verify it. Sign-in is
 * not blocked on verification, but linking providers and accepting invites
 * still require it.
 */
export const VerifyEmailNotice = () => {
  const auth = useAuth();
  const [status, setStatus] = useState<"error" | "idle" | "sending" | "sent">(
    "idle",
  );

  if (!auth.user || auth.user.emailVerified || !auth.capabilities.smtp) {
    return null;
  }
  const email = auth.user.email;

  const resend = async () => {
    setStatus("sending");
    try {
      await auth.resendVerification(email, "/app");
      setStatus("sent");
    } catch {
      setStatus("error");
    }
  };

  return (
    <section
      aria-label="Verify your email"
      className="migration-prompt"
      role="status"
    >
      <strong>Verify your email</strong>
      <p>
        {status === "sent"
          ? `A new verification link is on its way to ${email}.`
          : status === "error"
            ? "Could not send a verification link. Please try again."
            : `We sent a verification link to ${email}. Verifying unlocks provider sign-in and shared-drawing invites.`}
      </p>
      <button
        disabled={status === "sending"}
        onClick={() => void resend()}
        type="button"
      >
        {status === "sending" ? "Sending…" : "Resend link"}
      </button>
    </section>
  );
};
