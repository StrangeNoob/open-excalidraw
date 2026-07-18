import { createReadStream } from "node:fs";
import { cp, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, normalize, resolve, sep } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// The package ships its fonts beside the entry point it resolves to.
const EXCALIDRAW_FONTS = join(
  dirname(createRequire(import.meta.url).resolve("@excalidraw/excalidraw")),
  "fonts",
);

/**
 * Excalidraw resolves its fonts relative to `window.EXCALIDRAW_ASSET_PATH` and
 * falls back to a public CDN when it is unset. The production CSP allows fonts
 * from this origin only, so that request fails and the canvas silently renders
 * in a fallback face. Serve the package's own fonts instead, in dev and in the
 * build, so a self-hosted deployment never depends on a third party.
 */
const excalidrawFonts = (): Plugin => ({
  name: "excalidraw-fonts",
  configureServer(server) {
    server.middlewares.use("/fonts", (request, response, next) => {
      const requested = decodeURIComponent(
        (request.url ?? "").split("?")[0] ?? "",
      );
      const file = resolve(EXCALIDRAW_FONTS, `.${normalize(requested)}`);
      if (!file.startsWith(EXCALIDRAW_FONTS + sep)) {
        next();
        return;
      }

      void stat(file)
        .then((entry) => {
          if (!entry.isFile()) {
            next();
            return;
          }
          response.setHeader("content-type", "font/woff2");
          createReadStream(file).pipe(response);
        })
        .catch(() => next());
    });
  },
  async closeBundle() {
    await cp(EXCALIDRAW_FONTS, resolve(import.meta.dirname, "dist/fonts"), {
      recursive: true,
    });
  },
});

// Overridable so parallel checkouts can run against their own API port.
const apiTarget = process.env.API_PROXY_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [
    react(),
    // Must precede VitePWA: it copies the self-hosted fonts into dist during
    // closeBundle, and workbox globs dist in a later closeBundle hook — so the
    // fonts only make it into the precache if they are already on disk.
    excalidrawFonts(),
    VitePWA({
      // Ship each new build's service worker without a user-facing prompt.
      registerType: "autoUpdate",
      // The app entry registers the worker itself via virtual:pwa-register.
      injectRegister: false,
      // No service worker in dev or in vitest/e2e — production builds only.
      devOptions: { enabled: false },
      manifest: {
        name: "Open Excalidraw",
        short_name: "Excalidraw",
        description:
          "A self-hosted, collaborative Excalidraw whiteboard you can use offline.",
        start_url: "/",
        display: "standalone",
        // Mirrors the light-scheme theme-color in index.html.
        background_color: "#faf9f3",
        theme_color: "#faf9f3",
        icons: [
          { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
          { src: "/icon-32.png", sizes: "32x32", type: "image/png" },
          {
            src: "/apple-touch-icon.png",
            sizes: "180x180",
            type: "image/png",
          },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        // App shell plus every static asset, including the self-hosted
        // Excalidraw fonts under dist/fonts.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        // The Excalidraw chunk is several MiB, well over workbox's 2 MiB
        // default; precache it so the editor loads offline.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // Serve the SPA shell for client-side routes when offline...
        navigateFallback: "index.html",
        // ...but never shadow the API or the socket.io upgrade (the only
        // non-SPA paths, per the dev proxy and every server route living
        // under /api).
        navigateFallbackDenylist: [/^\/api\//, /^\/socket\.io\//],
        // The only API route we runtime-cache. Thumbnails are versioned by
        // ?v=<thumbnailUpdatedAt>, so a cached entry is never served for a new
        // version and CacheFirst is safe. Cleared per-browser on logout.
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              /^\/api\/v1\/drawings\/[^/]+\/thumbnail$/.test(url.pathname),
            handler: "CacheFirst",
            options: {
              cacheName: "drawing-thumbnails",
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 30 * 24 * 60 * 60,
              },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": apiTarget,
      "/socket.io": {
        target: apiTarget,
        ws: true,
      },
    },
  },
});
