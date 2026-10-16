#!/usr/bin/env python3
"""Reproduce the bundled font files in fonts/ from the upstream Noto Sans release.

Upstream: Noto Sans 2.015 static instances (SIL OFL 1.1), as redistributed in the
npm package @expo-google-fonts/noto-sans@0.4.2 (files NotoSans_400Regular.ttf and
NotoSans_700Bold.ttf). Requires `pip install fonttools==4.60.1`.

Usage: python3 tools/fonts/subset.py <dir-with-upstream-ttfs> fonts/

Produces, per weight:
  NotoSans-<Weight>.ttf          Latin/Greek/Cyrillic subset with outlines (rendering)
  NotoSans-<Weight>.metrics.ttf  same, outlines removed (measurement only; embedded
                                 by la-text and @label-anything/text)
Both files carry identical cmap/hmtx/hhea/OS/2/GDEF/GSUB/GPOS data, so text widths
measured from either are identical.
"""
import subprocess
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._g_l_y_f import Glyph

UNICODES = ",".join([
    "U+0020-007E", "U+00A0-024F", "U+02B0-036F", "U+0370-03FF", "U+0400-052F",
    "U+1E00-1FFF", "U+2000-20CF", "U+2100-218F", "U+2190-21FF", "U+2200-22FF",
    "U+25A0-25FF", "U+FB00-FB06", "U+FEFF", "U+FFFD",
])
FEATURES = "kern,liga,clig,calt,ccmp,locl,mark,mkmk,dist,case,frac,sups,subs"
WEIGHTS = {"400Regular": "Regular", "700Bold": "Bold"}


def main(src_dir: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for upstream, name in WEIGHTS.items():
        src = src_dir / f"NotoSans_{upstream}.ttf"
        full = out_dir / f"NotoSans-{name}.ttf"
        subprocess.run([
            sys.executable, "-m", "fontTools.subset", str(src),
            f"--unicodes={UNICODES}", f"--layout-features={FEATURES}",
            "--no-hinting", "--desubroutinize", "--drop-tables+=STAT,gasp,prep",
            "--name-IDs=*", "--name-legacy", "--name-languages=*", "--glyph-names",
            f"--output-file={full}",
        ], check=True)
        font = TTFont(full)
        for g in font.getGlyphOrder():
            font["glyf"][g] = Glyph()
            adv, _ = font["hmtx"][g]
            font["hmtx"][g] = (adv, 0)
        font["post"].formatType = 3.0
        font.save(out_dir / f"NotoSans-{name}.metrics.ttf")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
