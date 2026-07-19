import { registerSW } from "virtual:pwa-register";

/**
 * Register the app-shell service worker in "prompt" mode: a new deploy's
 * worker waits until the user opts in, so an update never reloads a tab
 * mid-drawing-session. Declining leaves the current version running; the
 * update applies when every tab is closed.
 *
 * In dev and in vitest/e2e this virtual module is a no-op (devOptions
 * disabled), so importing it here is safe everywhere and only does work in a
 * production build. `immediate` registers without waiting for the window load
 * event.
 */
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // ponytail: confirm() over a styled toast; swap if the modality annoys.
    if (window.confirm("A new version is available. Reload to update?")) {
      void updateSW(true);
    }
  },
});
