# Workspace editor height regression

Date observed: 2026-07-11
Status: fixed on 2026-07-11 — `.drawing-workspace` now uses a column flex
layout (`apps/web/src/features/workspace/workspace.css`), so the editor is
the flexible element regardless of how many conditional banners render.

## Summary

The authenticated drawing workspace renders the Excalidraw editor at roughly its minimum height instead of filling the remaining viewport. The empty lower portion of the page shows the app's dotted-paper background.

This is a layout regression that became visually obvious after the updated UI introduced the global paper background. The underlying grid-row mismatch appears to have existed before the visual refresh.

## Affected screen

- Authenticated drawing workspace: `/drawings/:drawingId`
- Example tested locally: `http://localhost:5173/drawings/d7b027d8-bf3e-5c1c-8120-ebbe7321167f`

## User-visible symptom

- Header, status, and Excalidraw toolbar render correctly.
- The Excalidraw canvas/editor only occupies the upper portion of the viewport.
- The remaining lower viewport shows the app background instead of editor surface.

## Root cause

The workspace shell uses a fixed five-row grid:

```css
.drawing-workspace {
  display: grid;
  grid-template-rows: auto auto auto auto minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}
```

However, the normal successful workspace render usually has only two direct grid children:

1. `header.workspace-header`
2. `div.workspace-editor`

Because `.workspace-editor` is the second direct child, CSS grid places it in the second `auto` row. The flexible `minmax(0, 1fr)` fifth row receives the remaining height, but it is empty. As a result, the editor's `height: 100%` resolves against an auto-sized row and the host falls back to its minimum height.

The editor host then reinforces the visible behavior:

```css
.excalidraw-host {
  height: 100%;
  min-height: 360px;
}
```

## Relevant files

- `apps/web/src/features/workspace/workspace.css`
  - `.drawing-workspace`
  - `.workspace-editor`
- `apps/web/src/features/workspace/DrawingPage.tsx`
  - Workspace render tree and direct grid-child order
- `apps/web/src/features/editor/excalidraw-host.css`
  - `.excalidraw-host` height/min-height behavior
- `apps/web/src/app/styles.css`
  - Global dotted-paper background that makes the empty grid area obvious

## Reproduction

1. Start the local stack:

   ```bash
   pnpm dev
   ```

2. Sign in as a user with an existing drawing.
3. Open an authenticated drawing route:

   ```text
   http://localhost:5173/drawings/:drawingId
   ```

4. Observe that the editor surface does not fill the available viewport height.

## Expected behavior

The workspace header and any transient banners should consume their natural height. The Excalidraw editor should occupy all remaining vertical space.

## Recommended fix

Prefer restructuring the workspace layout so optional banners/status messages do not depend on hard-coded grid row positions.

Recommended direction:

```css
.drawing-workspace {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}

.workspace-editor {
  min-height: 0;
}
```

Then wrap optional viewer/conflict/asset/collaboration messages in a single chrome/status region above the editor if they need to occupy space between the header and canvas.

Short-term patch option:

```css
.workspace-editor {
  grid-row: -2 / -1;
  min-height: 0;
  padding-top: 0.65rem;
}
```

This forces the editor into the final flexible row, but it is less robust because optional banners may still interact awkwardly with the hard-coded grid.

## Verification checklist

- Authenticated drawing editor fills remaining viewport height.
- Viewer banner still appears above the editor for viewer-only users.
- Save conflict banner still appears above the editor.
- Asset warning and collaboration warning still appear above the editor.
- Share and History modals still overlay correctly.
- Guest canvas layout is unchanged.
- Run:

  ```bash
  pnpm --filter @open-excalidraw/web typecheck
  pnpm --filter @open-excalidraw/web test:e2e
  pnpm --filter @open-excalidraw/web build
  ```
