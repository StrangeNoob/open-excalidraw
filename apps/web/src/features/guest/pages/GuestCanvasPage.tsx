import { Link } from "react-router-dom";

import { ExcalidrawHost } from "../../editor";
import {
  DEFAULT_GUEST_DRAWING_ID,
  DEFAULT_GUEST_DRAWING_TITLE,
} from "../model";
import {
  useGuestCanvas,
  type GuestCanvasRepository,
} from "../hooks/useGuestCanvas";

export interface GuestCanvasPageProps {
  drawingId?: string;
  repository?: GuestCanvasRepository;
  saveDelayMs?: number;
  title?: string;
}

export const GuestCanvasPage = ({
  drawingId = DEFAULT_GUEST_DRAWING_ID,
  repository,
  saveDelayMs,
  title = DEFAULT_GUEST_DRAWING_TITLE,
}: GuestCanvasPageProps) => {
  const guest = useGuestCanvas({
    drawingId,
    repository,
    saveDelayMs,
    title,
  });

  return (
    <main className="guest-canvas-page">
      <header className="guest-canvas-header">
        <div>
          <strong>{title}</strong>
          <span className="local-only-badge">Local only</span>
        </div>
        <nav aria-label="Guest account actions">
          <Link to="/login?returnTo=%2Fapp">Sign in</Link>
          <Link to="/signup?returnTo=%2Fapp">Create account</Link>
        </nav>
      </header>

      {guest.status === "loading" ? (
        <p aria-live="polite" className="guest-canvas-loading">
          Loading your local drawing…
        </p>
      ) : guest.initialLoadFailed ? (
        <section className="guest-canvas-error" role="alert">
          <strong>Could not open this local drawing.</strong>
          <span>{guest.error?.message}</span>
        </section>
      ) : (
        <div className="guest-canvas-editor">
          <ExcalidrawHost
            initialData={guest.initialData}
            onChange={guest.onChange}
            title={title}
          />
        </div>
      )}

      <footer className="guest-save-status" role="status">
        {guest.status === "saving"
          ? "Saving locally…"
          : guest.status === "saved"
            ? "Saved on this device"
            : guest.status === "error"
              ? "Local save failed"
              : "Changes stay on this device"}
      </footer>
    </main>
  );
};
