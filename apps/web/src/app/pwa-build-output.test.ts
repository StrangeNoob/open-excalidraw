import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { build } from "vite";

const WEB = join(import.meta.dirname, "../..");
const DIST = join(WEB, "dist");

// ponytail: build on demand so the test is self-contained. CI runs `pnpm test`
// before `pnpm build`, so dist may not exist yet; an existing build is reused —
// but only when it is newer than the config that shapes the service worker,
// or a stale sw.js would fail (or falsely pass) these assertions.
async function ensureBuild(): Promise<void> {
  const sw = join(DIST, "sw.js");
  if (existsSync(sw)) {
    const swMtime = statSync(sw).mtimeMs;
    const fresh = [join(WEB, "vite.config.ts"), join(WEB, "index.html")].every(
      (input) => statSync(input).mtimeMs < swMtime,
    );
    if (fresh) return;
  }
  await build({ root: WEB, logLevel: "silent" });
}

describe("pwa build output", () => {
  beforeAll(async () => {
    await ensureBuild();
  }, 120_000);

  it("emits the service worker, its workbox runtime chunk, and the manifest", async () => {
    const files = await readdir(DIST);

    expect(files).toContain("sw.js");
    expect(files).toContain("manifest.webmanifest");
    expect(files.some((file) => /^workbox-[\w-]+\.js$/.test(file))).toBe(true);
  });

  it("precaches the self-hosted Excalidraw fonts", async () => {
    const sw = await readFile(join(DIST, "sw.js"), "utf8");

    // The editor's fonts are self-hosted under dist/fonts; without them in the
    // precache the offline canvas renders in a fallback face.
    expect(sw).toMatch(/"fonts\/[^"]+\.woff2"/);
  });

  it("runtime-caches drawing thumbnails with a versioned CacheFirst route", async () => {
    const sw = await readFile(join(DIST, "sw.js"), "utf8");

    // The only API route cached at runtime. Thumbnails are versioned by ?v=, so
    // CacheFirst is safe; the route matches only the thumbnail path and is
    // capped so the cache cannot grow without bound.
    expect(sw).toContain("drawing-thumbnails");
    expect(sw).toContain("CacheFirst");
    expect(sw).toContain("thumbnail$");
    // Minification varies by build environment; match both spellings.
    expect(sw).toMatch(/maxEntries:\s*200/);
  });

  it("never lets the SPA fallback shadow the API or socket.io", async () => {
    const sw = await readFile(join(DIST, "sw.js"), "utf8");

    // The navigation fallback carries the denylist regexes verbatim.
    expect(sw).toContain("NavigationRoute");
    expect(sw).toContain("/^\\/api\\//");
    expect(sw).toContain("/^\\/socket\\.io\\//");
  });

  it("links the manifest from index.html", async () => {
    const html = await readFile(join(DIST, "index.html"), "utf8");

    expect(html).toMatch(
      /<link[^>]+rel="manifest"[^>]+href="\/manifest\.webmanifest"/,
    );
  });
});
