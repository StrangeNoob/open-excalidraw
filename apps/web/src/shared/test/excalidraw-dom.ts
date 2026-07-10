type ResizeObserverCallbackLike = (entries: ResizeObserverEntry[]) => void;

const canvasGradient = {
  addColorStop: () => undefined,
};

const canvasContext = new Proxy(
  {
    canvas: document.createElement("canvas"),
    createLinearGradient: () => canvasGradient,
    createPattern: () => null,
    createRadialGradient: () => canvasGradient,
    getImageData: () => ({
      data: new Uint8ClampedArray(4),
      height: 1,
      width: 1,
    }),
    measureText: (text: string) => ({
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 2,
      width: text.length * 8,
    }),
  },
  {
    get(target, property) {
      if (property in target) {
        return target[property as keyof typeof target];
      }

      return () => undefined;
    },
  },
) as unknown as CanvasRenderingContext2D;

export const installExcalidrawDomSupport = () => {
  class TestPath2D {
    addPath() {}
    arc() {}
    arcTo() {}
    bezierCurveTo() {}
    closePath() {}
    ellipse() {}
    lineTo() {}
    moveTo() {}
    quadraticCurveTo() {}
    rect() {}
    roundRect() {}
  }

  class TestFontFace {
    readonly family: string;
    readonly status = "loaded";

    constructor(family: string) {
      this.family = family;
    }

    load() {
      return Promise.resolve(this);
    }
  }

  class TestResizeObserver implements ResizeObserver {
    readonly #callback: ResizeObserverCallbackLike;

    constructor(callback: ResizeObserverCallbackLike) {
      this.#callback = callback;
    }

    disconnect() {}

    observe(target: Element) {
      this.#callback([
        {
          borderBoxSize: [],
          contentBoxSize: [],
          contentRect: new DOMRect(0, 0, 800, 600),
          devicePixelContentBoxSize: [],
          target,
        },
      ] as ResizeObserverEntry[]);
    }

    unobserve() {}
  }

  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("Path2D", TestPath2D);
  vi.stubGlobal("FontFace", TestFontFace);
  vi.stubGlobal(
    "IntersectionObserver",
    class TestIntersectionObserver {
      disconnect() {}
      observe() {}
      takeRecords() {
        return [];
      }
      unobserve() {}
    },
  );

  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => canvasContext,
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: () => "blob:test",
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      add: () => undefined,
      check: () => true,
      delete: () => true,
      forEach: () => undefined,
      has: () => true,
      load: () => Promise.resolve([]),
      ready: Promise.resolve(),
    },
  });
};

installExcalidrawDomSupport();
