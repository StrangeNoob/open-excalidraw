#!/usr/bin/env python3
"""Regenerate wordmark.svg and wordmark-dark.svg.

The letters are set in Gochi Hand — the same face the app uses for headings —
and converted to outlines, so the finished SVG carries no font dependency. That
matters: an SVG that references a font falls back to a serif and overflows its
viewBox wherever the font is absent, and GitHub (which embeds these through
`<img>`) is exactly that case.

    pip install fonttools brotli
    python3 docs/brand/generate-wordmark.py
"""

from glob import glob
from pathlib import Path

from fontTools.misc.transform import Identity
from fontTools.pens.boundsPen import ControlBoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

TEXT = "Open Excalidraw"
TEXT_HEIGHT = 98.0  # visual height of the letters, in viewBox units
MARK_BOX = 175.0  # the mark's artwork fills a square of this side
GAP = 20.0  # space between the mark and the first letter

ROOT = Path(__file__).resolve().parents[2]
FONT = next(
    iter(
        glob(
            str(
                ROOT
                / "node_modules/.pnpm/@fontsource+gochi-hand@*/node_modules"
                / "@fontsource/gochi-hand/files/gochi-hand-latin-400-normal.woff2"
            )
        )
    )
)

font = TTFont(FONT)
glyphs, cmap, hmtx = font.getGlyphSet(), font.getBestCmap(), font["hmtx"]


def draw(pen_for_glyph):
    """Lay the text out and draw it into pens.

    The font has no `kern` table and no GPOS `kern` feature, so stacking plain
    advance widths reproduces exactly what a browser draws.
    """
    x = 0
    for character in TEXT:
        name = cmap[ord(character)]
        if character != " ":
            # Font space is y-up; SVG is y-down.
            transform = Identity.translate(x, 0).scale(1, -1)
            glyphs[name].draw(TransformPen(pen_for_glyph(), transform))
        x += hmtx[name][0]


bounds = ControlBoundsPen(glyphs)
draw(lambda: bounds)
left, top, right, bottom = bounds.bounds

scale = TEXT_HEIGHT / (bottom - top)
# One font unit lands well under a tenth of a pixel here, so integer font units
# are exact to the eye and keep the path data small.
pens = []


def new_pen():
    pens.append(SVGPathPen(glyphs, ntos=lambda value: f"{round(value)}"))
    return pens[-1]


draw(new_pen)
letters = " ".join(filter(None, (pen.getCommands() for pen in pens)))

x_offset = MARK_BOX + GAP - left * scale
y_offset = (MARK_BOX - TEXT_HEIGHT) / 2 - top * scale  # centred against the mark
width = round(MARK_BOX + GAP + (right - left) * scale + 10)

MARK = """  <g transform="scale(1.75)">
    <g transform="translate(-1.5 3.5)" fill="{accent}">
      <g transform="rotate(-18 50 50)">
        <circle cx="50" cy="11" r="5"></circle>
        <rect x="46" y="15" width="8" height="7.5" rx="2"></rect>
        <path d="M30 22 L70 22 Q75 22 75 26.5 Q75 31 70 31 L30 31 Q25 31 25 26.5 Q25 22 30 22 Z"></path>
        <path fill-rule="evenodd" d="M43 33 L57 33 L60 52 L50 72 L40 52 Z M49 55 L51 55 L50.4 69 L49.6 69 Z M52.6 53 a2.6 2.6 0 1 0 -5.2 0 a2.6 2.6 0 1 0 5.2 0 Z"></path>
      </g>
      <path d="M56 71 Q68 81 84 73" fill="none" stroke="{accent}" stroke-width="9.5" stroke-linecap="round" stroke-linejoin="round"></path>
    </g>
  </g>"""


def lockup(accent: str, ink: str) -> str:
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {MARK_BOX:.0f}" width="{width}" height="{MARK_BOX:.0f}" role="img" aria-label="{TEXT}">
{MARK.format(accent=accent)}

  <!-- "{TEXT}" set in Gochi Hand and converted to outlines. -->
  <g transform="translate({x_offset:.1f} {y_offset:.1f}) scale({scale:.5f})" fill="{ink}">
    <path d="{letters}"></path>
  </g>
</svg>
"""


here = Path(__file__).parent
(here / "wordmark.svg").write_text(lockup(accent="#6965db", ink="#1e1d2a"))
(here / "wordmark-dark.svg").write_text(lockup(accent="#a5a2f6", ink="#eceaf4"))
print(f"wrote wordmark.svg and wordmark-dark.svg ({width}x{MARK_BOX:.0f})")
