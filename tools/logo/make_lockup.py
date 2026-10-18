#!/usr/bin/env python3
"""Draw the logo with the name on its label, as the home page's header shows it, for
places without the site's CSS (the README): docs/assets/logo-lockup.svg and, lighter for
dark backgrounds, docs/assets/logo-lockup-dark.svg.

The name is set in the bundled Noto Sans Bold (fonts/), as outlines, so the image looks
the same everywhere; the proportions are those of the header's static logo
(docs/_overrides/home.html, docs/assets/extra.css): padding 0.18 em × 0.5 em, corner
radius 0.24 em, line height 1.2, the leader from the label's corner to a dot 0.6 em right
and 0.68 em down, 0.12 em wide, the dot 0.22 em in radius. Requires
`pip install fonttools`.

Usage: python3 tools/logo/make_lockup.py
"""
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
TEXT = "Label Anything"
SIZE = 48.0  # px per em
COLORS = {"logo-lockup.svg": "#4051b5", "logo-lockup-dark.svg": "#5c6bc0"}


def num(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


def main() -> None:
    font = TTFont(ROOT / "fonts" / "NotoSans-Bold.ttf")
    upm = font["head"].unitsPerEm
    s = SIZE / upm
    hhea = font["hhea"]
    asc, desc = hhea.ascent * s, -hhea.descent * s
    cmap, glyphs, hmtx = font.getBestCmap(), font.getGlyphSet(), font["hmtx"]

    pad_x, pad_y, line = 0.5 * SIZE, 0.18 * SIZE, 1.2 * SIZE
    baseline = pad_y + (line - (asc + desc)) / 2 + asc
    pen = SVGPathPen(glyphs, ntos=num)
    x = pad_x
    for ch in TEXT:
        name = cmap[ord(ch)]
        glyphs[name].draw(TransformPen(pen, (s, 0, 0, -s, x, baseline)))
        x += hmtx[name][0] * s
    w, h = x + pad_x, line + 2 * pad_y
    dot = (w + 0.6 * SIZE, h + 0.68 * SIZE)
    r, stroke, radius = 0.22 * SIZE, 0.12 * SIZE, 0.24 * SIZE
    vw, vh = dot[0] + r + 1, dot[1] + r + 1
    for file, color in COLORS.items():
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {num(vw)} {num(vh)}" width="{num(vw)}" height="{num(vh)}">'
            f"<title>{TEXT}</title>"
            f'<path d="M{num(w - radius / 2)} {num(h - radius / 2)}L{num(dot[0])} {num(dot[1])}" stroke="{color}" '
            f'stroke-width="{num(stroke)}" stroke-linecap="round" fill="none"/>'
            f'<rect width="{num(w)}" height="{num(h)}" rx="{num(radius)}" fill="{color}"/>'
            f'<circle cx="{num(dot[0])}" cy="{num(dot[1])}" r="{num(r)}" fill="{color}"/>'
            f'<path d="{pen.getCommands()}" fill="#ffffff"/>'
            "</svg>\n"
        )
        (ROOT / "docs" / "assets" / file).write_text(svg, encoding="utf-8")
        print(f"docs/assets/{file}: {num(vw)} × {num(vh)} px")


if __name__ == "__main__":
    main()
