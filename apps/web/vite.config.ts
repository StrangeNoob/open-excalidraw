import { createReadStream } from "node:fs";
import { cp, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, normalize, resolve, sep } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

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

export default defineConfig({
  plugins: [react(), excalidrawFonts()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/socket.io": {
        target: "http://localhost:3000",
        ws: true,
      },
    },
  },
});
