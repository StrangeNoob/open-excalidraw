// jsdom 29 ships no type declarations and DefinitelyTyped stops at 28, so
// declare the sliver the renderer uses rather than depending on skewed types.
declare module "jsdom" {
  export class JSDOM {
    public constructor(
      html?: string,
      options?: { url?: string; pretendToBeVisual?: boolean },
    );
    public readonly window: Window & typeof globalThis;
  }
}
