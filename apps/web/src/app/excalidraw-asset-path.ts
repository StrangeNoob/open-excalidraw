/**
 * Excalidraw resolves its font files against `window.EXCALIDRAW_ASSET_PATH`,
 * and falls back to a public CDN when it is unset. The production CSP allows
 * scripts, fonts, and connections from this origin only, so that fallback is
 * blocked and the canvas silently renders in a substitute face.
 *
 * Point the editor at this origin, where the build serves the package's own
 * fonts. Import this before any Excalidraw module so the value is set before
 * the editor's font loader reads it; the CSP also forbids inline scripts, so
 * it cannot be set from index.html.
 */
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

window.EXCALIDRAW_ASSET_PATH = "/";

export {};
