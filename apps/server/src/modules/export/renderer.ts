import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type Canvas,
  createCanvas,
  DOMMatrix as NapiDOMMatrix,
  GlobalFonts,
  Image as NapiImage,
  Path2D as NapiPath2D,
} from "@napi-rs/canvas";
import { JSDOM } from "jsdom";

/**
 * The latin (U+20–7E) woff2 subset of each family Excalidraw can render with.
 *
 * Excalifont alone ships as seven unicode-range-split files and `@napi-rs/
 * canvas` has no unicode-range concept: the first registration under a family
 * name wins, so registering the wrong subset leaves every ASCII glyph falling
 * back to a system face — an ~80% text-metric error that renders as plausible
 * output. `assertFontsRegistered` is the guard; a package upgrade that rotates
 * these hashes fails loudly at boot instead.
 */
const LATIN_SUBSETS: Readonly<Record<string, string>> = {
  Excalifont:
    "Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2",
  Nunito:
    "Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTQ3j6zbXWjgeg.woff2",
  "Comic Shanns":
    "ComicShanns/ComicShanns-Regular-279a7b317d12eb88de06167bd672b4b4.woff2",
  "Liberation Sans": "Liberation/LiberationSans-Regular.woff2",
  "Cascadia Code": "Cascadia/CascadiaCode-Regular.woff2",
  Virgil: "Virgil/Virgil-Regular.woff2",
};

/** Origin Excalidraw's font URLs are built from; served off disk, never fetched. */
const ASSET_ORIGIN = "http://excalidraw-fonts.invalid/";

export interface SvgRenderRequest {
  elements: readonly unknown[];
  appState: Record<string, unknown>;
}

export interface PngRenderRequest extends SvgRenderRequest {
  /** Device-pixel multiplier applied after `maxWidthOrHeight` clamping. */
  scale?: number;
  /** Longest side, in CSS pixels, the scene is fitted into before scaling. */
  maxWidthOrHeight?: number;
}

export interface SceneRenderer {
  svg(request: SvgRenderRequest): Promise<string>;
  png(request: PngRenderRequest): Promise<Buffer>;
}

export interface SceneRendererOptions {
  /** Directory holding Excalidraw's `fonts/` tree. */
  assetRoot: string;
  /** The esbuild output of `excalidraw-entry.mjs`. */
  bundlePath: string;
}

interface ExcalidrawExportModule {
  exportToSvg: (options: ExportOptions) => Promise<SVGSVGElement>;
  exportToCanvas: (options: ExportOptions) => Promise<HTMLCanvasElement>;
}

interface ExportOptions {
  elements: readonly unknown[];
  appState: Record<string, unknown>;
  files: null;
  exportPadding: number;
  getDimensions?: (
    width: number,
    height: number,
  ) => { width: number; height: number; scale: number };
}

const EXPORT_PADDING = 10;

/**
 * Hard ceiling on either canvas dimension. Skia accepts far larger surfaces
 * and happily allocates gigabytes for them, so callers that pass no limit of
 * their own still get one.
 */
export const MAX_RENDER_DIMENSION = 8192;

/**
 * Renders scenes with the real Excalidraw exporters under jsdom.
 *
 * Booting costs ~180 ms and ~250 MB of Skia arena, so it happens on the first
 * export rather than at startup, and renders are serialized: the arena grows
 * with concurrency and this process also serves the API.
 */
export function createSceneRenderer(
  options: SceneRendererOptions,
): SceneRenderer {
  let booted: Promise<ExcalidrawExportModule> | null = null;
  const load = () => {
    // A failed boot (missing bundle, missing fonts) must not be cached: the
    // next request gets a fresh attempt rather than a permanently dead export.
    booted ??= boot(options).catch((error: unknown) => {
      booted = null;
      throw error;
    });
    return booted;
  };

  // ponytail: one render at a time bounds the native arena on a small
  // container. Raise to a small pool if export latency ever matters more.
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const next = queue.then(action, action);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    svg: (request) =>
      serialize(async () => {
        const { exportToSvg } = await load();
        const svg = await exportToSvg({
          elements: request.elements,
          appState: request.appState,
          files: null,
          exportPadding: EXPORT_PADDING,
        });
        return new globalThis.XMLSerializer().serializeToString(svg);
      }),
    png: (request) =>
      serialize(async () => {
        const { exportToCanvas } = await load();
        const canvas = await exportToCanvas({
          elements: request.elements,
          appState: request.appState,
          files: null,
          exportPadding: EXPORT_PADDING,
          getDimensions: fitTo(request.scale ?? 1, request.maxWidthOrHeight),
        });
        return backingCanvas(canvas).toBuffer("image/png");
      }),
  };
}

function fitTo(scale: number, maxWidthOrHeight: number | undefined) {
  return (width: number, height: number) => {
    const longest = Math.max(width, height, 1);
    const fit = maxWidthOrHeight ? Math.min(1, maxWidthOrHeight / longest) : 1;
    // The scene bounding box is whatever coordinates the writer chose, so an
    // absolute ceiling is the only thing standing between a legal scene and a
    // multi-gigabyte canvas allocation. It binds the rendered size, after the
    // scale multiplier rather than before it.
    const effective = Math.min(scale * fit, MAX_RENDER_DIMENSION / longest);
    return {
      width: Math.max(1, Math.round(width * effective)),
      height: Math.max(1, Math.round(height * effective)),
      scale: effective,
    };
  };
}

async function boot(
  options: SceneRendererOptions,
): Promise<ExcalidrawExportModule> {
  // Checked first because a failed boot is deliberately not cached: without
  // this, every retry would build another JSDOM and wrap global fetch again
  // around the last wrapper.
  if (!existsSync(options.bundlePath)) {
    throw new Error(
      `Excalidraw export bundle is missing: ${options.bundlePath}`,
    );
  }
  installDom();
  installFontShim(options.assetRoot);
  registerFonts(options.assetRoot);
  assertFontsRegistered();
  // The specifier is a runtime path, so the bundle is not a build-time
  // dependency of the server bundle itself.
  return (await import(
    pathToFileURL(options.bundlePath).href
  )) as ExcalidrawExportModule;
}

type Mutable = Record<string, unknown>;

/**
 * Installs the DOM globals Excalidraw touches while its module body evaluates
 * (`devicePixelRatio`, a 2D context feature-detect) plus the canvas plumbing
 * its renderer needs, backed by Skia rather than jsdom's no-op canvas.
 */
// ponytail: these globals are process-wide from the first export onwards, so
// a library that branches on `typeof window` would see a browser afterwards.
// Everything here is imported at startup, long before that, which is why this
// is in-process rather than in a worker thread — move it to one if a
// dependency ever misbehaves.
function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const window = dom.window;
  const target = globalThis as unknown as Mutable;
  target.window = window;
  target.document = window.document;
  target.self = globalThis;
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis) continue;
    const descriptor = Object.getOwnPropertyDescriptor(window, key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  }
  target.devicePixelRatio ??= 1;
  // Node >= 21 exposes `navigator` as a getter-only global, so plain
  // assignment silently does nothing.
  Object.defineProperty(globalThis, "navigator", {
    value: window.navigator,
    configurable: true,
    writable: true,
  });

  const prototype = window.HTMLCanvasElement.prototype as unknown as Mutable;
  prototype.getContext = function (
    this: HTMLCanvasElement,
    _type: string,
    attributes?: unknown,
  ) {
    return napiCanvasFor(this).getContext(
      "2d",
      attributes as never,
    ) as unknown as CanvasRenderingContext2D;
  };
  prototype.toDataURL = function (this: HTMLCanvasElement, ...args: unknown[]) {
    return napiCanvasFor(this).toDataURL(
      ...(args as Parameters<Canvas["toDataURL"]>),
    );
  };

  target.Path2D = NapiPath2D;
  target.DOMMatrix ??= NapiDOMMatrix;
  target.Image = NapiImage;
}

const BACKING = Symbol.for("open-excalidraw.napi-canvas");

function napiCanvasFor(element: HTMLCanvasElement): Canvas {
  const holder = element as unknown as Record<symbol, Canvas | undefined>;
  const width = element.width || 300;
  const height = element.height || 150;
  const existing = holder[BACKING];
  if (existing && existing.width === width && existing.height === height) {
    return existing;
  }
  const canvas = createCanvas(width, height) as unknown as Canvas & Mutable;
  // Excalidraw treats `ctx.canvas` as a DOM node — it reads attributes and
  // toggles classes on it — which a bare Skia canvas is not.
  canvas.setAttribute = (name: string, value: string) => {
    if (name === "width") canvas.width = Number(value);
    if (name === "height") canvas.height = Number(value);
  };
  canvas.getAttribute = (name: string) =>
    name === "width"
      ? String(canvas.width)
      : name === "height"
        ? String(canvas.height)
        : null;
  canvas.style = {};
  canvas.classList = {
    add: () => undefined,
    remove: () => undefined,
    contains: () => false,
  };
  canvas.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    width: canvas.width,
    height: canvas.height,
    right: canvas.width,
    bottom: canvas.height,
  });
  holder[BACKING] = canvas;
  return canvas;
}

function backingCanvas(element: HTMLCanvasElement): Canvas {
  const canvas = (element as unknown as Record<symbol, Canvas | undefined>)[
    BACKING
  ];
  if (!canvas) {
    throw new Error("The exported canvas has no Skia backing store");
  }
  return canvas;
}

/**
 * jsdom has neither `FontFace` nor `document.fonts`, and Excalidraw's font
 * registry needs both. It also resolves font URLs against
 * `window.EXCALIDRAW_ASSET_PATH` and falls back to a public CDN when that is
 * unset — the exact third-party dependency the CSP work removed — so the
 * asset path points at an unroutable sentinel origin and `fetch` serves those
 * URLs off disk.
 */
function installFontShim(assetRoot: string): void {
  const target = globalThis as unknown as Mutable;
  target.FontFace = class FontFaceShim {
    public status = "unloaded";
    public constructor(
      public readonly family: string,
      public readonly source: unknown,
      descriptors: Record<string, string> = {},
    ) {
      Object.assign(this, {
        style: "normal",
        weight: "400",
        display: "auto",
        unicodeRange: "U+0-10FFFF",
        ...descriptors,
      });
    }
    public load() {
      this.status = "loaded";
      return Promise.resolve(this);
    }
  };

  const faces = new Set<unknown>();
  const fonts = {
    add: (face: unknown) => faces.add(face),
    delete: (face: unknown) => faces.delete(face),
    has: (face: unknown) => faces.has(face),
    check: () => true,
    load: () => Promise.resolve([...faces]),
    ready: Promise.resolve(),
    forEach: (callback: (face: unknown) => void) => faces.forEach(callback),
    [Symbol.iterator]: () => faces[Symbol.iterator](),
    get size() {
      return faces.size;
    },
    onloadingdone: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  for (const scope of [globalThis.document, globalThis.window]) {
    Object.defineProperty(scope, "fonts", { value: fonts, configurable: true });
  }
  (globalThis.window as unknown as Mutable).EXCALIDRAW_ASSET_PATH =
    ASSET_ORIGIN;

  const upstream = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.startsWith(ASSET_ORIGIN)) return upstream(input, init);
    const relative = url.slice(ASSET_ORIGIN.length);
    const file = new URL(relative, pathToFileURL(join(assetRoot, "/")));
    const bytes = await readFile(file);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "content-type": "font/woff2" },
    });
  };
}

function registerFonts(assetRoot: string): void {
  for (const [family, subset] of Object.entries(LATIN_SUBSETS)) {
    const file = join(assetRoot, "fonts", subset);
    if (!GlobalFonts.register(readFileSync(file), family)) {
      throw new Error(`Failed to register the ${family} font from ${file}`);
    }
  }
}

/**
 * Proves each family measures differently from an unregistered one. Skia
 * substitutes silently, so without this a rotated subset hash or a missing
 * fonts directory degrades into wrong-but-plausible geometry.
 */
function assertFontsRegistered(): void {
  const context = createCanvas(1, 1).getContext("2d");
  const measure = (family: string) => {
    context.font = `20px "${family}"`;
    return context.measureText("Hello Wg").width;
  };
  const fallback = measure("open-excalidraw-absent-family");
  for (const family of Object.keys(LATIN_SUBSETS)) {
    if (measure(family) === fallback) {
      throw new Error(
        `The ${family} font is not measurable; the latin woff2 subset in ` +
          "LATIN_SUBSETS no longer matches the installed @excalidraw/excalidraw",
      );
    }
  }
}
