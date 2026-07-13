# Brand assets

The "blade-pen" mark: a sword-hilted fountain-pen nib, held at a drawing tilt,
laying down a stroke. It reads as **draw** first, with an Excalibur nod in the
hilt. This is an independent community project — not affiliated with or
endorsed by Excalidraw, and the mark is deliberately its own.

## Files

| File                | Use                                                          |
| ------------------- | ------------------------------------------------------------ |
| `icon.svg`          | Mark in violet `#6965db`, for light/paper backgrounds        |
| `icon-dark.svg`     | Mark in light violet `#a5a2f6`, for dark backgrounds         |
| `icon-white.svg`    | Knockout white mark, to place on a coloured fill             |
| `icon-mono.svg`     | Single flat ink `#1e1d2a`, for one-colour **light** contexts |
| `icon-tile.svg`     | Violet rounded tile, white mark — favicon and avatar         |
| `wordmark.svg`      | Horizontal lockup for light backgrounds                      |
| `wordmark-dark.svg` | The same lockup for dark backgrounds                         |

All are SVG with no external references, so they pass the app's Content Security
Policy and need no fonts at render time.

## The wordmark letters

They are set in **Gochi Hand** — the same face the app uses for headings, from
the `@fontsource/gochi-hand` package it already depends on — and converted to
outlines. Regenerate both lockups after any change:

```sh
pip install fonttools brotli
python3 docs/brand/generate-wordmark.py
```

The conversion is not decoration. An SVG that _references_ a font falls back to
a serif and overflows its viewBox wherever that font is absent, and GitHub —
which embeds these through `<img>`, with no access to the page's fonts — is
exactly that case. Outlines are the only form that renders identically
everywhere. The original handoff shipped both a live-text wordmark (broken on
GitHub for that reason) and an outline one whose letters were freehand
approximations rather than Gochi Hand; neither is kept.

## Colour

| Token  | Light     | Dark      |
| ------ | --------- | --------- |
| Accent | `#6965db` | `#a5a2f6` |
| Ink    | `#1e1d2a` | `#eceaf4` |
| Paper  | `#faf9f3` | `#17171f` |

## Where each asset is used

- **Favicon and touch icon:** `icon-tile.svg` is copied to
  `apps/web/public/favicon.svg`, with PNG fallbacks generated beside it. The
  bare mark is not used here; see the size limit below.
- **In the app:** `apps/web/src/features/brand/BrandMark.tsx` is the mark
  redrawn as a component filled with `currentColor`, so one copy serves both
  colour schemes and inherits whatever accent its container sets. It appears on
  the guest welcome screen and the auth cards, beside the wordmark set in live
  Gochi Hand.
- **README:** the light and dark wordmarks are selected with `<picture>` and
  `prefers-color-scheme`.

## Limits worth knowing

- **The bare mark is not legible below about 32px.** The crossguard and the
  stroke collapse into each other. Use `icon-tile.svg` for anything smaller —
  the filled tile survives 16px, the bare mark does not.
- **`icon-mono.svg` is for light backgrounds only.** Its ink is nearly
  invisible on the dark surface; use `icon-white.svg` there.
- **The mark reads as a pen before it reads as a sword.** If the sword should
  read harder, flare the crossguard into pointed quillons.
- **Do not rasterise these with ImageMagick.** Its built-in SVG renderer
  silently drops the mark's ink stroke — a `fill="none"` stroke path — leaving a
  pen with nothing flowing from it. It fails quietly, so the loss is easy to
  ship. Regenerate the PNG fallbacks through Chromium instead:

  ```sh
  node docs/brand/generate-icons.mjs
  ```

  The touch icon it writes is deliberately opaque and full-bleed: iOS discards
  alpha and applies its own mask, so a transparent rounded tile would gain black
  corners.

## Rules

Do not add gradients, drop shadows, or glows inside the mark. The offset
"sticker" shadow is a UI motif applied around elements, never part of the
artwork.

Do not hand-edit the wordmark SVGs or the PNG icons; change the generator that
produces them (`generate-wordmark.py`, `generate-icons.mjs`) and re-run it.
