"""Figures of the documentation site, made from the tutorial problems with the CLI.

    bench/.venv/bin/python examples/tutorials/make_figures.py --cli rust/target/release/label-anything

The figures are vector graphics: standalone SVGs (``bench/render.py``) with the labels set in
an embedded subset of Noto Sans, so that zooming in stays sharp; raster backgrounds are
embedded as they are.

* ``docs/assets/gallery/*.svg``: item marks, vector and SVG obstacles in grey (SVG
  backgrounds as they are), labels, leaders, omitted items as red crosses.
* ``docs/assets/figures/debug-overlay.svg``: a debug overlay written during the solve
  (``place --debug-svg``), with the cost heatmap of every obstacle class.
* ``docs/assets/figures/*.svg``: what a host would draw over a raster background: the
  image, the marks, and the labels and leaders of the result (labels in black on white
  boxes at 75 % opacity, as in all renderings).
* ``docs/assets/figures/matplotlib.png``: the image the Matplotlib helper writes.

The figures are committed; re-run this script after changing a tutorial problem or the
engine (it needs the benchmark's Python environment: fontTools and Pillow). Solves are
deterministic, so unchanged inputs give unchanged figures.
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
    ("raster-contrast", "problems/raster-contrast.json"),
]
# (output name, problem, options merged into it): variants of a problem for comparisons
VARIANTS = [("raster-contrast-off", "problems/raster-contrast.json", {"weights": {"contrast": 0}})]
# debug overlays rendered during the solve (place --debug-svg): with the cost heatmaps
DEBUG_SVGS = [("debug-overlay", "problems/raster-classmap.json")]


def solve(cli: str, problem: Path, tmp: Path) -> Path:
    out = tmp / (problem.stem + ".result.json")
    subprocess.run([cli, "place", str(problem), "-o", str(out)], check=True)
    return out


def figure(problem_path: Path, result: dict[str, Any], out: Path) -> None:
    """A standalone SVG of the result (``bench/render.py``): background files resolved against
    the problem, the canvas of a problem without one taken from its raster background."""
    sys.path.insert(0, str(ROOT))
    from bench.common.model import raster_size
    from bench.render import standalone_svg

    problem = json.loads(problem_path.read_text(encoding="utf-8"))
    obstacles = problem.get("obstacles") or {}
    for kind, key in (("raster", "source"), ("svg", "path")):
        layers = obstacles.get(kind)
        for layer in [layers] if isinstance(layers, dict) else layers or []:
            ref = layer.get(key)
            if isinstance(ref, str) and len(ref) < 1024 and (problem_path.parent / ref).is_file():
                layer[key] = str((problem_path.parent / ref).resolve())
    if "canvas" not in problem and obstacles.get("raster"):
        raster = obstacles["raster"]
        raster = raster[0] if isinstance(raster, list) else raster
        w, h = raster_size(raster)
        scale = float(raster.get("scale", 1))
        problem["canvas"] = {"width": round(w / scale), "height": round(h / scale)}
    out.write_text(standalone_svg(problem, result, show_obstacles="auto"), encoding="utf-8")


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
            result = json.loads(solve(cli, problem, tmp).read_text(encoding="utf-8"))
            figure(problem, result, GALLERY / f"{name}.svg")
            print(f"docs/assets/gallery/{name}.svg")
        for name, rel in COMPOSITES:
            if args.only and name not in args.only:
                continue
            problem = HERE / rel
            result = json.loads(solve(cli, problem, tmp).read_text(encoding="utf-8"))
            figure(problem, result, FIGURES / f"{name}.svg")
            print(f"docs/assets/figures/{name}.svg")
        for name, rel, options in VARIANTS:
            if args.only and name not in args.only:
                continue
            base = HERE / rel
            problem = json.loads(base.read_text(encoding="utf-8"))
            for key, value in options.items():
                problem[key] = {**problem.get(key, {}), **value}
            # next to the original: its raster sources are relative paths
            variant = base.with_name(f".{name}.json")
            variant.write_text(json.dumps(problem), encoding="utf-8")
            try:
                result = json.loads(solve(cli, variant, tmp).read_text(encoding="utf-8"))
                figure(variant, result, FIGURES / f"{name}.svg")
            finally:
                variant.unlink()
            print(f"docs/assets/figures/{name}.svg")
        for name, rel in DEBUG_SVGS:
            if args.only and name not in args.only:
                continue
            out = FIGURES / f"{name}.svg"
            subprocess.run([cli, "place", str(HERE / rel), "-o", str(tmp / "debug.json"), "--debug-svg", str(out)], check=True)
            print(f"docs/assets/figures/{name}.svg")
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
