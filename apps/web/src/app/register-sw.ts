import { registerSW } from "virtual:pwa-register";

/**
 * Register the app-shell service worker. With registerType "autoUpdate" workbox
 * takes over updating and reloading; we only need to kick off registration.
 *
 * In dev and in vitest/e2e this virtual module is a no-op (devOptions disabled),
 * so importing it here is safe everywhere and only does work in a production
 * build. `immediate` registers without waiting for the window load event.
 */
registerSW({ immediate: true });
