"""Figures of the documentation site, made from the tutorial problems with the CLI.

    python3 examples/tutorials/make_figures.py --cli rust/target/release/label-anything

* ``docs/assets/gallery/*.png``: debug renderings (``label-anything render problem.json
  result.json -o x.png``): item shapes, vector and SVG obstacles in grey, label boxes,
  leaders, omitted items as red crosses.
* ``docs/assets/figures/*.png``: what a host would draw over a raster background: the
  image, the marks, and the labels and leaders of the result (Pillow, bundled Noto Sans).

The figures are committed; re-run this script after changing a tutorial problem or the
engine (it needs Pillow). Solves are deterministic, so unchanged inputs give unchanged
figures.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
GALLERY = ROOT / "docs" / "assets" / "gallery"
FIGURES = ROOT / "docs" / "assets" / "figures"
FONT = ROOT / "rust" / "crates" / "la-cli" / "assets" / "NotoSans-Regular.ttf"

# (output name, problem relative to examples/tutorials)
RENDERINGS = [
    ("svg-background", "problems/svg-classes.json"),
    ("leaders-straight", "problems/leaders-straight.json"),
    ("leaders-angles", "problems/leaders-angles.json"),
    ("leaders-orthogonal", "problems/leaders-orthogonal.json"),
    ("leaders-elbow", "problems/leaders-elbow.json"),
    ("leaders-curved", "problems/leaders-curved.json"),
    ("leaders-boundary", "problems/leaders-boundary.json"),
    ("priority-cities", "problems/priority-cities.json"),
    ("shapes", "problems/shapes.json"),
    ("node-link", "problems/graph.json"),
]
COMPOSITES = [
    ("outliers", "data/outliers.json"),
    ("raster-ink", "problems/raster-ink.json"),
    ("raster-alpha", "problems/raster-alpha.json"),
    ("raster-cost", "problems/raster-cost.json"),
    ("raster-classmap", "problems/raster-classmap.json"),
    ("raster-saliency", "problems/raster-saliency.json"),
]


def solve(cli: str, problem: Path, tmp: Path) -> Path:
    out = tmp / (problem.stem + ".result.json")
    subprocess.run([cli, "place", str(problem), "-o", str(out)], check=True)
    return out


def composite(problem_path: Path, result: dict[str, Any], out: Path, ss: int = 2) -> None:
    """Background raster + marks + labels + leaders, rendered at ``ss``x and downsampled."""
    from PIL import Image, ImageDraw, ImageFont

    problem = json.loads(problem_path.read_text(encoding="utf-8"))
    raster = problem["obstacles"]["raster"]
    raster = raster[0] if isinstance(raster, list) else raster
    bg = Image.open(problem_path.parent / raster["source"]).convert("RGBA")
    scale = float(raster.get("scale", 1))
    ox, oy = raster.get("offset", [0, 0])
    canvas = problem.get("canvas") or {"width": bg.width / scale, "height": bg.height / scale}
    w, h = round(canvas["width"]), round(canvas["height"])
    img = Image.new("RGBA", (w * ss, h * ss), "white")
    bg = bg.resize((round(bg.width / scale * ss), round(bg.height / scale * ss)), Image.LANCZOS)
    img.alpha_composite(bg, (round(ox * ss), round(oy * ss)))
    d = ImageDraw.Draw(img, "RGBA")
    for item in problem["items"]:
        a = item["anchor"]
        if a["type"] != "point":
            continue
        r = (a.get("mark") or {}).get("r", 2) * ss
        x, y = a["x"] * ss, a["y"] * ss
        d.ellipse([x - r, y - r, x + r, y + r], fill=(29, 53, 87, 255))
    fonts: dict[float, Any] = {}
    for p in result["placements"]:
        if not p["placed"]:
            continue
        for leader in [p["leader"]] if p.get("leader") else p.get("leaders", []):
            pts = [(x * ss, y * ss) for x, y in leader["points"]]
            d.line(pts, fill=(40, 40, 40, 255), width=ss, joint="curve")
        b = p["box"]
        d.rectangle([b["x"] * ss, b["y"] * ss, (b["x"] + b["w"]) * ss, (b["y"] + b["h"]) * ss], fill=(255, 255, 255, 200))
        t = p.get("text")
        if not t:
            continue
        size = t["font_size"] * ss
        font = fonts.setdefault(size, ImageFont.truetype(str(FONT), size))
        for line, base in zip(t["lines"], t["baseline_offsets"]):
            pos = ((b["x"] + t.get("x_offset", 0)) * ss, (b["y"] + base) * ss)
            d.text(pos, line, font=font, fill=(25, 25, 25, 255), anchor="ls")
    img = img.resize((w, h), Image.LANCZOS).convert("RGB")
    img.save(out, optimize=True)


def python_figure(python: str, program: str, output: str, name: str, tmp: Path) -> None:
    """Run a Python tutorial program in a copy of the data and keep the image it writes."""
    work = tmp / name
    shutil.copytree(HERE / "data", work / "data")
    shutil.copytree(HERE / "problems", work / "problems")
    subprocess.run([python, str(HERE / "python" / program)], cwd=work / "data", check=True, env={**os.environ, "MPLBACKEND": "Agg"})
    shutil.copyfile(work / "data" / output, FIGURES / f"{name}.png")


# (output name, Python program, the image it writes)
PYTHON_FIGURES = [("matplotlib", "helpers_matplotlib.py", "matplotlib.png")]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--cli", required=True, help="the label-anything executable")
    ap.add_argument("--python", help="a Python with label_anything[matplotlib] (figures of the Python helpers)")
    ap.add_argument("--only", nargs="*", help="figure names to (re)make")
    args = ap.parse_args()
    cli = str(Path(args.cli).resolve())
    GALLERY.mkdir(parents=True, exist_ok=True)
    FIGURES.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="la-figures-"))
    try:
        for name, rel in RENDERINGS:
            if args.only and name not in args.only:
                continue
            problem = HERE / rel
            result = solve(cli, problem, tmp)
            subprocess.run([cli, "render", str(problem), str(result), "-o", str(GALLERY / f"{name}.png")], check=True)
            print(f"docs/assets/gallery/{name}.png")
        for name, rel in COMPOSITES:
            if args.only and name not in args.only:
                continue
            problem = HERE / rel
            result = json.loads(solve(cli, problem, tmp).read_text(encoding="utf-8"))
            composite(problem, result, FIGURES / f"{name}.png")
            print(f"docs/assets/figures/{name}.png")
        for name, program, output in PYTHON_FIGURES if args.python else []:
            if args.only and name not in args.only:
                continue
            python_figure(args.python, program, output, name, tmp)
            print(f"docs/assets/figures/{name}.png")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
