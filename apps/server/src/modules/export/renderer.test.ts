import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { build } from "esbuild";

import {
  createSceneRenderer,
  MAX_RENDER_DIMENSION,
  type SceneRenderer,
} from "./renderer.js";

const packageRoot = join(import.meta.dirname, "..", "..", "..");
const bundlePath = join(packageRoot, "dist", "excalidraw-export.mjs");
const assetRoot = dirname(
  createRequire(import.meta.url).resolve("@excalidraw/excalidraw"),
);

const element = (overrides: Record<string, unknown>) => ({
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: 12345,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
  index: "a0",
  ...overrides,
});

// 400x200 of scene plus the exporter's 10px padding on each side.
const FIXTURE = [
  element({
    id: "box",
    type: "rectangle",
    x: 0,
    y: 0,
    width: 400,
    height: 200,
    index: "a0",
  }),
  element({
    id: "label",
    type: "text",
    x: 20,
    y: 20,
    width: 120,
    height: 25,
    index: "a1",
    text: "Hello",
    originalText: "Hello",
    fontSize: 20,
    fontFamily: 5,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    lineHeight: 1.25,
    autoResize: true,
  }),
];

const appState = { exportBackground: true, viewBackgroundColor: "#ffffff" };

/** Width and height straight out of the PNG's IHDR chunk. */
function pngSize(png: Buffer) {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

let renderer: SceneRenderer;

beforeAll(async () => {
  // Mirrors the `bundle:excalidraw-export` package script, so a checkout that
  // has not run a build still exercises the real exporters.
  if (!existsSync(bundlePath)) {
    await build({
      entryPoints: [
        join(packageRoot, "src/modules/export/excalidraw-entry.mjs"),
      ],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      loader: { ".json": "json" },
      outfile: bundlePath,
    });
  }
  renderer = createSceneRenderer({ assetRoot, bundlePath });
}, 60_000);

describe("createSceneRenderer", () => {
  // Booting at all proves the font self-check passed: it throws when a
  // family measures identically to an unregistered one, which is what an
  // Excalidraw upgrade that rotates the latin subset hashes looks like.
  it("renders a scene to SVG with its fonts inlined from disk", async () => {
    const svg = await renderer.svg({ elements: FIXTURE, appState });

    expect(svg).toContain("src: url(data:font/woff2;base64,");
    expect(svg).not.toContain("excalidraw-fonts.invalid");
    expect(elideFonts(svg)).toMatchInlineSnapshot(
      `"<svg xmlns="http://www.w3.org/2000/svg" version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 220" width="420" height="220"><!-- svg-source:excalidraw --><metadata/><defs><style class="style-fonts">§FONT§</style></defs><rect x="0" y="0" width="420" height="220" fill="#ffffff"/><g stroke-linecap="round" transform="translate(10 10) rotate(0 200 100)"><path d="M0 0 C102.2 0, 204.4 0, 400 0 M0 0 C145.46 0, 290.93 0, 400 0 M400 0 C400 64.47, 400 128.94, 400 200 M400 0 C400 50.24, 400 100.48, 400 200 M400 200 C289.27 200, 178.53 200, 0 200 M400 200 C310.19 200, 220.38 200, 0 200 M0 200 C0 122.11, 0 44.21, 0 0 M0 200 C0 133.62, 0 67.24, 0 0" stroke="#1e1e1e" stroke-width="2" fill="none"/></g><g transform="translate(30 30) rotate(0 60 12.5)"><text x="0" y="17.619999999999997" font-family="Excalifont, Xiaolai, Segoe UI Emoji" font-size="20px" fill="#1e1e1e" text-anchor="start" style="white-space: pre;" direction="ltr" dominant-baseline="alphabetic">Hello</text></g></svg>"`,
    );
  }, 60_000);

  it("renders PNG at the requested scale", async () => {
    const [one, two] = await Promise.all([
      renderer.png({ elements: FIXTURE, appState }),
      renderer.png({ elements: FIXTURE, appState, scale: 2 }),
    ]);

    expect(pngSize(one)).toEqual({ width: 420, height: 220 });
    expect(pngSize(two)).toEqual({ width: 840, height: 440 });
  }, 60_000);

  it("refuses to boot when the latin subsets are not where it expects", async () => {
    // What an Excalidraw upgrade that rotates the subset hashes looks like:
    // the families silently fall back and every export is wrong-but-plausible.
    const blind = createSceneRenderer({
      assetRoot: join(assetRoot, "does-not-exist"),
      bundlePath,
    });

    await expect(blind.svg({ elements: FIXTURE, appState })).rejects.toThrow();
  }, 60_000);

  it("clamps a scene far larger than any sane canvas", async () => {
    const huge = [
      {
        ...(FIXTURE[0] as Record<string, unknown>),
        width: 40_000,
        height: 20_000,
      },
    ];

    const png = await renderer.png({ elements: huge, appState, scale: 2 });

    const { width, height } = pngSize(png);
    expect(Math.max(width, height)).toBeLessThanOrEqual(MAX_RENDER_DIMENSION);
  }, 60_000);

  it("fits the render inside maxWidthOrHeight before scaling", async () => {
    const png = await renderer.png({
      elements: FIXTURE,
      appState,
      maxWidthOrHeight: 210,
    });

    // 420x220 fitted to a 210px longest side, halving both.
    expect(pngSize(png)).toEqual({ width: 210, height: 110 });
  }, 60_000);
});

/** Font payloads are big, opaque, and already guarded by the self-check. */
const elideFonts = (svg: string) =>
  svg.replace(
    /<style class="style-fonts">[\s\S]*?<\/style>/,
    '<style class="style-fonts">§FONT§</style>',
  );
