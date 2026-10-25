#!/usr/bin/env python3
"""Add the vertical glyph bounds table `LAvb` to the bundled metrics fonts (spec §5.2).

The metrics fonts (fonts/NotoSans-<Weight>.metrics.ttf) have no outlines. So that a label's
box can fit the ink of its text, they carry the vertical extent of every glyph's outline in
a private table, taken from the outline font of the same subset (fonts/NotoSans-<Weight>.ttf,
the same glyph ids):

    uint16 version (1), uint16 numGlyphs, then per glyph id: int16 yMin, int16 yMax

in font units; a glyph without outline (space, empty) has yMin = yMax = 0. Every other table
is copied byte for byte, so widths and kerning do not change.

Usage: python3 tools/fonts/bounds.py fonts/      (fonttools; also called by subset.py)
"""
import struct
import sys
from io import BytesIO
from pathlib import Path

from fontTools.ttLib import TTFont, newTable

TAG = "LAvb"
WEIGHTS = ["Regular", "Bold"]


def bounds_table(outlines: TTFont) -> bytes:
    """The `LAvb` data of a font with outlines."""
    glyf = outlines["glyf"]
    order = outlines.getGlyphOrder()
    out = [struct.pack(">HH", 1, len(order))]
    for name in order:
        g = glyf[name]
        if g.numberOfContours == 0:
            out.append(struct.pack(">hh", 0, 0))
            continue
        g.recalcBounds(glyf)
        out.append(struct.pack(">hh", g.yMin, g.yMax))
    return b"".join(out)


def add_bounds(metrics_path: Path, outlines_path: Path) -> None:
    """Write the `LAvb` table of the outline font into the metrics font, in place."""
    outlines = TTFont(outlines_path)
    data = bounds_table(outlines)
    font = TTFont(metrics_path, lazy=True, recalcBBoxes=False, recalcTimestamp=False)
    before = {tag: font.reader[tag] for tag in font.reader.keys() if tag != TAG}
    if font["maxp"].numGlyphs != len(outlines.getGlyphOrder()):
        raise SystemExit(f"{metrics_path}: glyph count differs from {outlines_path}")
    table = newTable(TAG)
    table.data = data
    font[TAG] = table
    buf = BytesIO()
    font.save(buf)
    check = TTFont(BytesIO(buf.getvalue()), lazy=True)
    for tag, raw in before.items():
        new = check.reader[tag]
        if tag == "head":  # checkSumAdjustment (bytes 8-11) is recomputed
            raw, new = raw[:8] + raw[12:], new[:8] + new[12:]
        if new != raw:
            raise SystemExit(f"{metrics_path}: table {tag} would change")
    metrics_path.write_bytes(buf.getvalue())


def main(font_dir: Path) -> None:
    for weight in WEIGHTS:
        add_bounds(font_dir / f"NotoSans-{weight}.metrics.ttf", font_dir / f"NotoSans-{weight}.ttf")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
