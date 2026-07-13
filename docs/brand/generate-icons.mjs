/**
 * Regenerate the PNG icon fallbacks in apps/web/public.
 *
 * Rendered through Chromium, not ImageMagick: ImageMagick's built-in SVG
 * renderer silently drops the mark's ink stroke (a `fill="none"` stroke path),
 * producing a pen with nothing flowing from it.
 *
 *   node docs/brand/generate-icons.mjs
 */
import { chromium } from "@playwright/test";
import { rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const brand = dirname(fileURLToPath(import.meta.url));
const out = resolve(brand, "../../apps/web/public");

// A real page on a file:// origin: Chromium refuses to load file:// images into
// a page created with setContent, which lands on an about:blank origin.
const host = `${brand}/.icon.html`;

const shoot =
  (browser) =>
  async ({ file, size, background, inset = 0, path }) => {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.goto(`file://${host}`);
    await page.evaluate(
      ({ file, background, inset }) => {
        document.body.style.cssText = `margin:0;display:grid;place-items:center;width:100vw;height:100vh;background:${background ?? "transparent"}`;
        const img = document.querySelector("img");
        img.src = file;
        img.style.width = `${100 - inset * 2}%`;
      },
      { file, background, inset },
    );
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path, omitBackground: !background });
    await page.close();
  };

await writeFile(host, "<body><img></body>");

try {
  const browser = await chromium.launch();
  try {
    const capture = shoot(browser);
    await Promise.all([
      capture({ file: "icon-tile.svg", size: 16, path: `${out}/icon-16.png` }),
      capture({ file: "icon-tile.svg", size: 32, path: `${out}/icon-32.png` }),
      capture({
        file: "icon-tile.svg",
        size: 512,
        path: `${out}/icon-512.png`,
      }),
      // iOS discards alpha and applies its own mask, so the touch icon is
      // opaque and full-bleed: a transparent rounded tile would gain black
      // corners.
      capture({
        file: "icon-white.svg",
        size: 180,
        background: "#6965db",
        inset: 11,
        path: `${out}/apple-touch-icon.png`,
      }),
    ]);
  } finally {
    await browser.close();
  }
} finally {
  // The temp file is a dotfile: leaving it behind on failure invites an
  // accidental commit.
  await rm(host, { force: true });
}

console.log("wrote icon-16, icon-32, icon-512, apple-touch-icon");
