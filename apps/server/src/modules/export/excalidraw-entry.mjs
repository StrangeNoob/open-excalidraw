// esbuild entry for `pnpm --filter @open-excalidraw/server run bundle:excalidraw-export`.
//
// `@excalidraw/excalidraw` cannot be imported by Node directly: its dependency
// on open-color resolves to a JSON module without an import attribute, which
// no runtime flag fixes. Pre-bundling with esbuild (`--loader:.json=json`)
// inlines it, and bundling React in rather than leaving it external avoids
// `react-remove-scroll`'s dynamic `require("react")`.
export { exportToCanvas, exportToSvg } from "@excalidraw/excalidraw";
