import { Footer } from "@excalidraw/excalidraw";

/**
 * Chrome rendered through Excalidraw's own UI slots, so the canvas pages never
 * wrap the editor in bars that compete with it for viewport height.
 */

export type CanvasStatusTone = "muted" | "active" | "warning" | "error";

/** Sits in Excalidraw's bottom island instead of a page-level footer row. */
export const CanvasStatusFooter = ({
  label,
  tone = "muted",
}: {
  label: string;
  tone?: CanvasStatusTone;
}) => (
  <Footer>
    <div className="canvas-footer">
      <span className={`canvas-status canvas-status--${tone}`} role="status">
        {label}
      </span>
    </div>
  </Footer>
);
