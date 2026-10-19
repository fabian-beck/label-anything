#!/usr/bin/env python3
"""Draw the logo — a label whose leader grows out of it, to a dot — for places without
the site's CSS and scripts:

* docs/assets/logo-lockup.svg and, lighter for dark backgrounds, logo-lockup-dark.svg:
  the logo with the name on its label, as the home page's header shows it (the README);
* docs/assets/logo.svg (the favicon) and docs/_overrides/.icons/la/logo.svg (the site's
  header icon, drawn in the header's colour): the logo as an icon, a label without text.
  The playground's pages (ts/packages/playground/index.html, explain.html) inline the
  icon's path, which the script prints.

Each is one outline: the label's box with rounded corners, except the one the leader
leaves from, whose edges flow into the leader's sides in concave fillets; the leader; the
dot. The name is set in the bundled Noto Sans Bold (fonts/), as outlines, so the image
looks the same everywhere. The proportions are those of the header's static logo
(docs/_overrides/home.html, docs/assets/extra.css): padding 0.2 em × 0.42 em, corner
radius 0.24 em, line height 1.2, the leader 0.12 em wide from the label's corner to a dot
0.75 em right and down, the dot 0.2 em in radius, the fillets 0.4 em; the script prints
the header's join (`data-la-hero-join`) in its tail's units. The live header draws the
same shape wherever the name goes (ts/packages/playground/src/logo.ts). Requires
`pip install fonttools`.

Usage: python3 tools/logo/make_logo.py
"""
import math
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
TEXT = "Label Anything"
SIZE = 48.0  # px per em
COLORS = {"logo-lockup.svg": "#4051b5", "logo-lockup-dark.svg": "#5c6bc0"}
ICON_COLOR = "#3949ab"


def num(v: float) -> str:
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s == "-0" else s


def leaving(w, h, dot, stroke, fillet):
    """Where the leader leaves the corner (w, h) for `dot`: per side (lower, upper) the
    corner it makes with the box's edge and the fillet's ends on the edge and on the side;
    the leader's direction and normal."""
    ux, uy = dot[0] - w, dot[1] - h
    d = math.hypot(ux, uy)
    ux, uy = ux / d, uy / d
    nx, ny = -uy, ux  # towards the lower side
    hw = stroke / 2
    # the lower side meets the bottom edge, the upper side the right edge
    x1 = (w + hw * nx - hw * ny / uy * ux, h)
    x2 = (w, h - hw * ny + hw * nx / ux * uy)
    t1 = fillet / math.tan(math.acos(-ux) / 2)
    t2 = fillet / math.tan(math.acos(-uy) / 2)
    lower = (x1, (x1[0] - t1, h), (x1[0] + t1 * ux, x1[1] + t1 * uy))
    upper = (x2, (w, x2[1] - t2), (x2[0] + t2 * ux, x2[1] + t2 * uy))
    return lower, upper, (ux, uy), (nx, ny)


def tag(w, h, radius, dot, r, stroke, fillet, x=0.0, y=0.0):
    """The outline of the label (w × h at x, y), its leader from the bottom-right corner
    to `dot` (relative to the label) and the dot (radius r): one path, clockwise."""
    (x1, a1, b1), (x2, a2, b2), (ux, uy), (nx, ny) = leaving(w, h, dot, stroke, fillet)
    hw, k = stroke / 2, math.sqrt(r * r - stroke * stroke / 4)
    # where the leader's sides meet the dot
    up = (dot[0] - k * ux - hw * nx, dot[1] - k * uy - hw * ny)
    lo = (dot[0] - k * ux + hw * nx, dot[1] - k * uy + hw * ny)

    def p(q):
        return f"{num(x + q[0])} {num(y + q[1])}"

    rr = num(radius)
    return (
        f"M{p((radius, 0))}H{num(x + w - radius)}A{rr} {rr} 0 0 1 {p((w, radius))}"
        f"V{num(y + a2[1])}Q{p(x2)} {p(b2)}L{p(up)}A{num(r)} {num(r)} 0 1 1 {p(lo)}L{p(b1)}Q{p(x1)} {p(a1)}"
        f"H{num(x + radius)}A{rr} {rr} 0 0 1 {p((0, h - radius))}V{num(y + radius)}A{rr} {rr} 0 0 1 {p((radius, 0))}Z"
    )


def join(dot, stroke, fillet, inset):
    """The header's join in its tail's coordinates (the label's corner at 0, 0): from
    inside the label along the bottom edge, the fillet into the leader, across it, the
    fillet into the right edge, back inside the label."""
    (x1, a1, b1), (x2, a2, b2), _, _ = leaving(0, 0, dot, stroke, fillet)

    def p(q):
        return f"{num(q[0])} {num(q[1])}"

    return f"M{num(a1[0])} {num(-inset)}V0Q{p(x1)} {p(b1)}L{p(b2)}Q{p(x2)} {p(a2)}H{num(-inset)}V{num(-inset)}Z"


def main() -> None:
    font = TTFont(ROOT / "fonts" / "NotoSans-Bold.ttf")
    upm = font["head"].unitsPerEm
    s = SIZE / upm
    hhea = font["hhea"]
    asc, desc = hhea.ascent * s, -hhea.descent * s
    cmap, glyphs, hmtx = font.getBestCmap(), font.getGlyphSet(), font["hmtx"]

    pad_x, pad_y, line = 0.42 * SIZE, 0.2 * SIZE, 1.2 * SIZE
    baseline = pad_y + (line - (asc + desc)) / 2 + asc
    pen = SVGPathPen(glyphs, ntos=num)
    x = pad_x
    for ch in TEXT:
        name = cmap[ord(ch)]
        glyphs[name].draw(TransformPen(pen, (s, 0, 0, -s, x, baseline)))
        x += hmtx[name][0] * s
    w, h = x + pad_x, line + 2 * pad_y
    dot, r = (w + 0.75 * SIZE, h + 0.75 * SIZE), 0.2 * SIZE
    outline = tag(w, h, 0.24 * SIZE, dot, r, 0.12 * SIZE, 0.4 * SIZE)
    vw, vh = dot[0] + r + 1, dot[1] + r + 1
    for file, color in COLORS.items():
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {num(vw)} {num(vh)}" width="{num(vw)}" height="{num(vh)}">'
            f"<title>{TEXT}</title>"
            f'<path d="{outline}" fill="{color}"/>'
            f'<path d="{pen.getCommands()}" fill="#ffffff"/>'
            "</svg>\n"
        )
        (ROOT / "docs" / "assets" / file).write_text(svg, encoding="utf-8")
        print(f"docs/assets/{file}: {num(vw)} × {num(vh)} px")

    # the icon: a label of 20 × 11 at (3, 9) in 32 × 32, its leader and dot bolder than the
    # lockup's, so that they hold at 16 px
    icon = tag(20, 11, 2, (25, 16), 2.8, 2.2, 3, 3, 9)
    head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    (ROOT / "docs" / "assets" / "logo.svg").write_text(
        f'{head}<title>{TEXT}</title><path d="{icon}" fill="{ICON_COLOR}"/></svg>\n', encoding="utf-8"
    )
    (ROOT / "docs" / "_overrides" / ".icons" / "la" / "logo.svg").write_text(f'{head}<path d="{icon}"/></svg>\n', encoding="utf-8")
    print("docs/assets/logo.svg, docs/_overrides/.icons/la/logo.svg: the icon, path")
    print(f"  {icon}")
    print("docs/_overrides/home.html: the tail's join (1 em = 100)")
    print(f"  {join((75, 75), 12, 40, 10)}")


if __name__ == "__main__":
    main()
