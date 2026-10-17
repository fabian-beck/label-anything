"""Gallery: benchmark problems solved by Label Anything, as one HTML page of renderings.

    python -m bench.gallery --engine rust/target/release/label-anything [--run bench-report] [--out DIR]

Every figure is a problem of the benchmark (``bench/out/problems``, built by ``python -m
bench.scenarios build``), solved with that problem's settings and the engine's defaults
(``ENGINE place PROBLEM -o RESULT --warmup 3``, the command of ``bench/run.py --engine``) and
drawn by the benchmark's renderer (``bench/render.py``). The numbers under a figure come from
the evaluator (``bench/eval``, independent of the engine), the runtime from the engine
(``stats.runtime_ms``). With ``--run``, the output directory of a ``bench/run.py`` run that
rendered its results, the page adds the run's renderings of the same problems by the
baselines and the frames of its stability sequence.

Output (default ``<run>/gallery``, else ``bench-report/gallery``): ``index.html``,
``img/*.webp`` (the page's images), ``img/full/*.webp`` (the same renderings at twice the
resolution, loaded by the page's image viewer: pinch, double-tap or scroll to zoom, drag to
pan, swipe or the arrow keys for the next image), ``fonts/`` (Noto Sans and its licence: the
page loads nothing from other servers) and ``gallery.json`` (the numbers of every figure). A gallery written into its run
directory is linked from the run's report (``index.html`` is rebuilt). CI's ``baselines`` job
does that, so the Pages workflow publishes it at ``<site>/benchmark-report/gallery/``.
"""
from __future__ import annotations

import argparse
import html
import os
import shlex
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image  # noqa: E402

from bench import render  # noqa: E402
from bench.common import paths  # noqa: E402
from bench.common.jsonio import read_json, write_json  # noqa: E402
from bench.eval import evaluate  # noqa: E402

E = html.escape
SITE = "https://fabian-beck.github.io/label-anything/"
REPO_URL = "https://github.com/fabian-beck/label-anything"
Solve = Callable[[Path, Path], dict]


@dataclass(frozen=True)
class Fig:
    """A benchmark problem (``scenario/config``) and its caption. ``text`` is HTML; it may use the
    figure's numbers (``{placed}``, ``{total}``, ``{leaders}``, ``{omitted}``) as in str.format."""
    key: str
    title: str
    text: str
    wide: bool = False


@dataclass(frozen=True)
class Section:
    id: str
    title: str
    sub: str
    lede: str
    figs: tuple[Fig, ...]


SECTIONS = (
    Section("charts", "Charts", "scatterplots, bubbles, line ends", "", (
        Fig("01-software-metrics/cbo-rfc-100-svg", "The 100 most unusual classes of React Native's Java code",
            "Coupling vs. response for 1,206 classes; the 100 k-NN outliers are labeled with their fully "
            "qualified names, which wrap at package dots; the five most unusual in bold, the rest a size "
            "smaller (font classes). The plot is an SVG whose points, axes and tick labels the engine reads "
            "as obstacles."),
        Fig("02-volcano/top50-svg", "Top 50 genes of a volcano plot",
            "16,406 genes from a differential-expression table; the 50 most significant ones are labeled "
            "over an SVG plot with colored significant genes and dashed thresholds, the top three in bold."),
        Fig("03-gapminder/y2005-svg", "Gapminder 2005",
            "Life expectancy vs. fertility, bubble area by population, the most populous countries named "
            "in bold. The year watermark is a soft obstacle, the region legend a hard one."),
        Fig("09-line-end-labels/unemployment-14-vector", "Unemployment by industry",
            "Labels at the right ends of 14 series: only positions right of the line ends are allowed. "
            "Where the ends crowd, their labels stand in a column beside them, in the order of the ends, "
            "with fanning leaders ({fans} fan labels; {omitted} left out)."),
        Fig("01-software-metrics/wmc-loc-30-raster", "A chart that is only a picture",
            "The whole scatterplot is a PNG. The engine finds axes, points and text in the pixels "
            "(raster ink mode) and keeps the 30 labels off them."),
        Fig("09-line-end-labels/life-62-boundary", "Life expectancy of 62 countries",
            "A label right of its line end, or in a stack in the right margin. The crowded ends at the "
            "top get a column of {fans} fan labels instead, as tall as leaders of at most 10 em allow; "
            "the others are left out ({placed} of {total} placed)."),
    )),
    Section("maps", "Maps", "vector, SVG and raster backgrounds", "", (
        Fig("05-airports/europe-names-400-svg", "400 European airports, by city name",
            "An SVG map at 30 px per degree, the busiest airports in bold. Names avoid each other and the "
            "airport dots; where they crowd, short leaders.", wide=True),
        Fig("05-airports/world-iata-1000-vector", "The 1,000 busiest airports of the world",
            "IATA codes over country outlines and graticule (soft lines). The most connected airports "
            "come first; red crosses are the {omitted} that did not fit.", wide=True),
        Fig("06-city-pois/monaco-pins-ink", "375 points of interest in Monaco",
            "Icon and name labels over an OpenStreetMap raster, the main sights in bold; the engine reads "
            "streets and buildings from the pixels (ink mode) and keeps names off the busiest parts."),
        Fig("06-city-pois/monaco-ink", "The same map with small dots instead of pins",
            "Composite labels (icon + name) over the same raster."),
    )),
    Section("images", "Photos and illustrations", "area anchors, leaders, margin labels", "", (
        Fig("08-illustration/astronaut-boundary", "Annotated portrait",
            "Twelve regions of a NASA portrait are area anchors (one is a ring with a hole). Labels sit "
            "in the margins on purpose, elbow leaders end inside each region."),
        Fig("08-illustration/retina-boundary", "Fundus photograph",
            "Ten anatomical structures of a retina image (raster at scale 2), labeled at the sides with "
            "elbow leaders."),
        Fig("08-illustration/rocket-distant", "Falcon 9 on the launch pad",
            "Twelve parts labeled with straight leaders to positions off the rocket; duplicate label "
            "texts are allowed."),
    )),
    Section("graphs", "Embeddings and networks", "", "", (
        Fig("04-embedding/k120-areas", "120 topics of WordNet",
            "50,000 noun glosses embedded with t-SNE; 120 clusters are area anchors (hulls of their "
            "cores), labeled inside or next to them over a raster of the points.", wide=True),
        Fig("04-embedding/k40-ink", "40 cluster names over 50,000 points",
            "Long topic names wrap; the point cloud is a raster the engine reads in ink mode."),
        Fig("07-node-link/lesmis-shapes", "Les Misérables, with UML-like nodes",
            "77 characters; rounded rectangles hold internal labels, ellipses get external ones."),
        Fig("07-node-link/cora-circles", "Cora citation network",
            "150 papers of a citation graph in a ForceAtlas2 layout, the most cited first and in bold. "
            "Edges are obstacles; a label that would need a leader through other nodes is left out "
            "instead ({placed} of {total} placed)."),
    )),
    Section("priority", "Priority decides what is left out", "",
            "3,221 airports, scored by how isolated they are. With <code>strict</code> omission, a label "
            "is left out only if more important labels leave no room for it. With <code>prefix</code>, the "
            "labels shown are exactly the top of the ranking: everything after the first label that does "
            "not fit is left out.", (
                Fig("12-priority/airports-outlier-strict", "strict: {placed} labels",
                    "Every omitted airport is blocked by a more important label.", wide=True),
                Fig("12-priority/airports-outlier-prefix", "prefix: {placed} labels",
                    "A reader can trust that every airport ranked above a shown label is shown too.",
                    wide=True),
            )),
)

# (scenario, config, title, caption) of the baseline comparisons, if the run has them
COMPARISONS = (
    ("03-gapminder", "y2005-vector", "Gapminder 2005, labeled by six tools",
     "The same 46 bubbles, the same obstacles, scored by the same evaluator. Hard violations count "
     "labels on top of each other, of bubbles or of axes. adjustText never omits a label, so it "
     "overlaps instead; ggrepel's repulsion does not always separate everything."),
    ("05-airports", "world-iata-300-none", "300 busiest airports, labeled by six tools",
     "IATA codes, other airports as soft points."),
    ("02-volcano", "top20-vector", "Volcano plot, top 20 genes",
     "A sparse case: every tool places almost everything, and the differences are in overlaps."),
)
COMPARE_SOLVERS = ("rust", "ggrepel", "adjusttext", "textalloc", "vega-label", "greedy")
NAMES = {"rust": "Label Anything", "ggrepel": "ggrepel (R)", "adjusttext": "adjustText", "textalloc": "textalloc",
         "vega-label": "vega-label", "greedy": "Greedy baseline", "naive": "Naive (no collision test)"}


# ---------------------------------------------------------------------------
# figures
# ---------------------------------------------------------------------------
def problem_files(problems: Path, key: str) -> dict | None:
    """Problem, truth and background of ``scenario/config`` from its scenario manifest (None if not built)."""
    scenario, _, config = key.partition("/")
    man_path = problems / scenario / "scenario.json"
    if not man_path.exists():
        return None
    c = next((c for c in read_json(man_path).get("configs", []) if c.get("name") == config), None)
    if c is None:
        return None
    files = {k: man_path.parent / v for k, v in c["files"].items()}
    return {"problem": files["problem"], "truth": files.get("truth"),
            "background": files.get("background_png") or render.default_background_png(files["problem"])}


def engine_solve(engine: str, warmup: int, timeout: float) -> Solve:
    """``ENGINE place PROBLEM -o RESULT --warmup N`` (``engine`` may be a command with arguments)."""
    cmd = shlex.split(engine)

    def solve(problem: Path, result: Path) -> dict:
        args = cmd + ["place", str(problem), "-o", str(result)] + (["--warmup", str(warmup)] if warmup else [])
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        if r.returncode != 0:
            raise RuntimeError(f"exit code {r.returncode}: {r.stderr.strip()[-500:]}")
        return read_json(result)

    return solve


def render_scale(width: float) -> float:
    """Wide canvases at 1×, smaller ones larger, so that text stays sharp at the page's column widths."""
    return 1.0 if width >= 1200 else 1.5 if width >= 700 else 2.0


def save_webp(img: Image.Image, path: Path, quality: int = 90) -> list[int]:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(path, "WEBP", quality=quality, method=6)
    return list(img.size)


ZOOM = 2.0  # pixels of the zoomable image (img/full/…) per pixel of the page image


def render_pair(problem: dict, result: dict, background: Path | None, out: Path, rel: str) -> dict:
    """Render once at ZOOM × the page scale: the image the viewer zooms into and, scaled down, the page image.
    Labels, leaders and marks stay sharp at that scale; background images keep their own resolution."""
    width = float((problem.get("canvas") or {}).get("width", 800))
    full = render.render_png(problem, result, background, render_scale(width) * ZOOM)
    page = full.resize((max(1, round(full.width / ZOOM)), max(1, round(full.height / ZOOM))), Image.LANCZOS)
    full_rel = "img/full/" + rel.removeprefix("img/")
    return {"img": rel, "size": save_webp(page, out / rel), "full": full_rel,
            "full_size": save_webp(full, out / full_rel, quality=85)}


def solve_figure(fig: Fig, files: dict, solve: Solve, out: Path, tmp: Path) -> dict:
    """Solve, evaluate and render one figure; the numbers of its chips and its image."""
    name = fig.key.replace("/", "__")
    problem = read_json(files["problem"])
    result = solve(files["problem"], tmp / f"{name}.json")
    truth = read_json(files["truth"]) if files.get("truth") else None
    s = evaluate(problem, result, truth, removal_test=False)["summary"]
    images = render_pair(problem, result, files["background"], out, f"img/{name}.webp")
    leaders = sum(1 for p in result.get("placements", []) if p.get("placed") and p.get("leader"))
    fans = sum(1 for p in result.get("placements", []) if p.get("placed") and p.get("model") == "fan")
    return {"key": fig.key, **images, "placed": s["placed"], "total": s["total"], "omitted": s["total"] - s["placed"],
            "leaders": leaders, "fans": fans,
            "hard_violations": s["hard_violations"], "leader_len_max_em": s.get("leader_len_max_em"),
            "leader_near_crossings": s.get("leader_near_crossings"),
            "leader_mark_touches": s.get("leader_mark_touches"),
            "runtime_ms": (result.get("stats") or {}).get("runtime_ms")}


# ---------------------------------------------------------------------------
# the run's baselines and stability frames
# ---------------------------------------------------------------------------
def comparisons(run: Path, report: dict, out: Path, problems: Path = paths.PROBLEMS) -> list[dict]:
    """The run's results for COMPARISONS, by every solver of COMPARE_SOLVERS it has, rendered like the
    figures (the run's own rendering when its result or problem file is gone)."""
    rows = {(r["solver"], r["scenario"], r["config"]): r for r in report.get("results", [])}
    figs = []
    for scenario, config, title, text in COMPARISONS:
        cells = []
        for s in COMPARE_SOLVERS:
            r = rows.get((s, scenario, config))
            if r is None:
                continue
            cell = {"solver": s, "name": NAMES.get(s, s)}
            src = run / r["image"] if r.get("image") else None
            if src is not None and src.exists() and "summary" in r:
                rel = f"img/cmp/{s}/{scenario}__{config}.webp"
                res = run / r["result"] if r.get("result") else None
                prob = paths.REPO / r["problem"] if r.get("problem") else None
                if res is not None and res.exists() and prob is not None and prob.exists():
                    files = problem_files(problems, f"{scenario}/{config}") or {}
                    bg = files.get("background") or render.default_background_png(prob)
                    cell.update(render_pair(read_json(prob), read_json(res), bg, out, rel))
                else:
                    with Image.open(src) as im:
                        size = save_webp(im, out / rel)
                    cell.update(img=rel, size=size, full=rel, full_size=size)
                sm = r["summary"]
                cell.update(placed=sm["placed"], total=sm["total"], hard_violations=sm.get("hard_violations") or 0)
            else:
                cell["why"] = r.get("skipped") or r.get("error") or "no rendering"
            cells.append(cell)
        if any(c["solver"] == "rust" and "img" in c for c in cells) and len(cells) > 1:
            figs.append({"scenario": scenario, "config": config, "title": title, "text": text, "cells": cells})
    return figs


def stability(run: Path, report: dict, out: Path) -> dict | None:
    """The first and middle and last frame of the run's first rendered Label Anything sequence."""
    seq = next((q for q in report.get("sequences", []) if q.get("solver") == "rust" and q.get("images")), None)
    if seq is None:
        return None
    frames = []
    for rel in seq["images"]:
        src = run / rel
        if not src.exists():
            return None
        stem = Path(rel).stem
        dst = f"img/seq/{seq['sequence']}/{stem}.webp"
        with Image.open(src) as im:
            size = save_webp(im, out / dst)
        frames.append({"img": dst, "size": size, "full": dst, "full_size": size,
                       "frame": int(stem.removeprefix("frame")) + 1})
    m = seq.get("metrics") or {}
    steps = m.get("steps") or []

    def median_flips(kind: str) -> float | None:
        v = [x["flip_rate"] for x in steps if x.get("step") == kind and x.get("flip_rate") is not None]
        return statistics.median(v) if v else None

    return {"scenario": seq["scenario"], "sequence": seq["sequence"], "frames": frames,
            "n_frames": len(seq.get("frames") or []),
            "zoom_steps": sum(1 for x in steps if str(x.get("step", "")).startswith("zoom")),
            "pan_steps": sum(1 for x in steps if x.get("step") == "pan"),
            "displacement_median_px": m.get("displacement_median_px"),
            "nesting": m.get("nesting_fraction_mean"),
            "flips_pan": median_flips("pan"), "flips_zoom": median_flips("zoom_in")}


# ---------------------------------------------------------------------------
# the page
# ---------------------------------------------------------------------------
CSS = r"""
@font-face { font-family: "Noto Sans"; src: url("fonts/NotoSans-Regular.ttf") format("truetype"); font-weight: 400; font-display: swap; }
@font-face { font-family: "Noto Sans"; src: url("fonts/NotoSans-Bold.ttf") format("truetype"); font-weight: 700; font-display: swap; }
/* A contact sheet of figure cards on a cool grey ground; chips drawn like the label boxes of the images:
   black text on white in both themes */
:root {
  --paper: #f3f5f8; --card: #ffffff; --ink: #16202a; --muted: #586474; --rule: #d6dce4;
  --label: #3b6aa0; --label-soft: #e6edf6; --omit: #c0352f; --good: #2d7a4c;
  --chip: #ffffff; --chip-ink: #000000;
  --body: "Noto Sans", system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
  --mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace;
  /* the image viewer is dark in both themes */
  --scrim: #0d1218; --scrim-ink: #e8edf2; --scrim-muted: #9eabb8; --scrim-btn: #1c2631; --scrim-line: #3a4856;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --paper: #0e1318; --card: #151c24; --ink: #e3e8ee; --muted: #9ba6b2; --rule: #27313c;
  --label: #8bb2e3; --label-soft: #1b2939; --omit: #ff7a72; --good: #67c792; color-scheme: dark } }
:root[data-theme="dark"] {
  --paper: #0e1318; --card: #151c24; --ink: #e3e8ee; --muted: #9ba6b2; --rule: #27313c;
  --label: #8bb2e3; --label-soft: #1b2939; --omit: #ff7a72; --good: #67c792; color-scheme: dark }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--body); font-size: 15px; line-height: 1.55; }
a { color: var(--label); }
.wrap { max-width: 1280px; margin: 0 auto; padding-block: 44px 72px;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px));
  display: grid; gap: 56px; }
header { display: grid; gap: 14px; max-width: 72ch; }
.eyebrow { font-family: var(--mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--label); }
.eyebrow a { color: inherit; text-decoration: none; }
.eyebrow a:hover { text-decoration: underline; }
h1 { font-weight: 700; font-size: clamp(2.1rem, 5vw, 3.4rem); line-height: 1.1; margin: 0; letter-spacing: -0.02em; text-wrap: balance; }
h1 .box { display: inline-block; margin-top: 0.06em; padding: 0 0.18em; background: var(--chip); color: var(--chip-ink); }
header p { margin: 0; color: var(--muted); font-size: 16px; }
.key { display: flex; flex-wrap: wrap; gap: 10px 22px; font-size: 13px; color: var(--muted); align-items: center; }
.key span { display: inline-flex; align-items: center; gap: 8px; }
.key svg { flex: none; }
nav.toc ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
nav.toc a { display: inline-block; font-size: 13px; padding: 2px 9px; border: 1px solid var(--rule); background: var(--card);
  border-radius: 2px; color: var(--ink); text-decoration: none; }
nav.toc a:hover, nav.toc a:focus-visible { border-color: var(--label); color: var(--label); }
section { display: grid; gap: 22px; scroll-margin-top: 16px; }
section > h2 { font-weight: 700; font-size: 1.55rem; margin: 0; display: flex; flex-wrap: wrap; align-items: baseline;
  gap: 4px 12px; text-wrap: balance; letter-spacing: -0.01em; }
section > h2 small { font-weight: 400; font-size: 14px; color: var(--muted); letter-spacing: 0; }
section > p.lede { margin: -10px 0 0; color: var(--muted); max-width: 72ch; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 520px), 1fr)); gap: 26px; }
.fig, .cmp { margin: 0; background: var(--card); border: 1px solid var(--rule); border-radius: 4px;
  display: grid; align-content: start; min-width: 0; overflow: hidden; scroll-margin-top: 16px; }
.fig.wide { grid-column: 1 / -1; }
.shot { display: block; background: #fff; border-bottom: 1px solid var(--rule); line-height: 0; cursor: zoom-in; }
.shot img { width: 100%; height: auto; display: block; }
.shot:focus-visible { outline: 3px solid var(--label); outline-offset: -3px; }
figcaption { padding: 14px 16px 16px; display: grid; gap: 6px; min-width: 0; }
.src { font-family: var(--mono); font-size: 11.5px; color: var(--muted); letter-spacing: 0.02em; overflow-wrap: anywhere; }
figcaption h3 { margin: 0; font-weight: 700; font-size: 1.08rem; line-height: 1.3; text-wrap: balance; }
figcaption p { margin: 0; color: var(--muted); max-width: 75ch; }
.chips { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.chips li { font-family: var(--mono); font-size: 12px; font-variant-numeric: tabular-nums; padding: 1px 7px;
  border: 1px solid var(--rule); background: var(--chip); color: var(--chip-ink); border-radius: 1px; }
.chips li.bad { border-color: var(--omit); color: var(--omit); background: transparent; }
.chips li.ok { border-color: var(--good); color: var(--good); background: transparent; }
.pairhead { border-bottom: 1px solid var(--rule); }
.cellhead { font-family: var(--mono); font-size: 12px; padding: 8px 14px; color: var(--muted); border-bottom: 1px solid var(--rule); }
.cmpgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); }
.cmpgrid.three { grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); }
.cell { display: grid; align-content: start; min-width: 0; border-right: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
.cell .chips { padding: 8px 12px 12px; margin: 0; }
.cell.mine .cellhead { color: var(--label); font-weight: 700; }
.cell.mine { box-shadow: inset 0 0 0 2px var(--label); }
.naw { margin: 0; padding: 12px 14px; color: var(--muted); font-size: 13px; }
.notes { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 26px; }
.note { margin: 0; background: var(--card); border: 1px solid var(--rule); border-left: 3px solid var(--omit);
  border-radius: 4px; padding: 14px 16px 16px; display: grid; align-content: start; gap: 6px; min-width: 0; }
.note h3 { margin: 0; font-weight: 700; font-size: 1.08rem; line-height: 1.3; }
.note p { margin: 0; color: var(--muted); }
footer { color: var(--muted); font-size: 13px; display: grid; gap: 8px; max-width: 80ch; }
code { font-family: var(--mono); font-size: 0.9em; background: var(--label-soft); padding: 1px 4px; border-radius: 2px; overflow-wrap: anywhere; }
@media (prefers-reduced-motion: no-preference) { .shot img { transition: filter 0.15s ease; } .shot:hover img { filter: brightness(0.97); } }
/* image viewer: the stage takes every touch (pinch, pan, double-tap); the bars float over it */
html.viewing { overflow: hidden; }
dialog.viewer { position: fixed; inset: 0; width: 100%; height: 100%; max-width: none; max-height: none; margin: 0;
  padding: 0; border: 0; background: var(--scrim); color: var(--scrim-ink); overscroll-behavior: contain; touch-action: none; }
dialog.viewer::backdrop { background: var(--scrim); }
.stage { position: absolute; inset: 0; overflow: hidden; touch-action: none; cursor: zoom-in; }
.stage.zoomed { cursor: grab; }
.stage.zoomed.dragging { cursor: grabbing; }
.stage img { position: absolute; left: 0; top: 0; max-width: none; transform-origin: 0 0; background: #fff;
  user-select: none; -webkit-user-select: none; -webkit-user-drag: none; -webkit-touch-callout: none; will-change: transform; }
.vbar { position: absolute; left: 0; right: 0; display: flex; align-items: center; gap: 8px; pointer-events: none;
  padding-left: max(12px, env(safe-area-inset-left, 0px)); padding-right: max(12px, env(safe-area-inset-right, 0px)); }
.vbar > * { pointer-events: auto; }
.vbar.top { top: 0; padding-top: max(10px, env(safe-area-inset-top, 0px)); padding-bottom: 18px;
  background: linear-gradient(var(--scrim) 45%, transparent); }
.vbar.bottom { bottom: 0; justify-content: center; padding-top: 18px; padding-bottom: max(12px, env(safe-area-inset-bottom, 0px));
  background: linear-gradient(transparent, var(--scrim) 55%); }
.vtitle { flex: 1; min-width: 0; display: grid; gap: 2px; pointer-events: none; }
.vcap { margin: 0; font-size: 14px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vhint { margin: 0; font-size: 12px; color: var(--scrim-muted); }
@media (pointer: coarse) { .vhint .fine { display: none; } }
@media (pointer: fine) { .vhint .touch { display: none; } }
.vbtn { flex: none; min-width: 44px; height: 44px; padding: 0 10px; border-radius: 22px; border: 1px solid var(--scrim-line);
  background: var(--scrim-btn); color: var(--scrim-ink); font: 700 15px/1 var(--body); display: inline-grid;
  place-items: center; cursor: pointer; }
.vbtn svg { width: 20px; height: 20px; }
.vbtn:disabled { opacity: 0.35; cursor: default; }
.vbtn:focus-visible { outline: 2px solid var(--scrim-ink); outline-offset: 2px; }
.vpct { min-width: 4.5em; text-align: center; font-family: var(--mono); font-size: 12px; color: var(--scrim-muted);
  font-variant-numeric: tabular-nums; }
"""


def _img(m: dict, alt: str, caption: str, lazy: bool) -> str:
    """The page image, linked to the image the viewer zooms into (``data-w``/``data-h``: its size)."""
    load = ' loading="lazy" decoding="async"' if lazy else ""
    full, fs = m.get("full", m["img"]), m.get("full_size", m["size"])
    return (f'<a class="shot" href="{E(full)}" target="_blank" rel="noopener" data-w="{fs[0]}" data-h="{fs[1]}" '
            f'data-caption="{E(caption)}"><img src="{E(m["img"])}" alt="{E(alt)}" width="{m["size"][0]}" '
            f'height="{m["size"][1]}"{load}></a>')


def _chips(items: list[tuple[str, str]]) -> str:
    lis = (f'<li class="{c}">{E(t)}</li>' if c else f"<li>{E(t)}</li>" for t, c in items)
    return '<ul class="chips">' + "".join(lis) + "</ul>"


def _fig_chips(m: dict) -> str:
    chips = [(f"{m['placed']:,} of {m['total']:,} placed", "")]
    if m["leaders"]:
        chips.append((f"{m['leaders']:,} leader{'s' if m['leaders'] != 1 else ''}", ""))
        if m.get("leader_len_max_em") is not None:
            chips.append((f"longest {m['leader_len_max_em']:.1f} em", ""))
    hv = m["hard_violations"]
    chips.append(("no hard violations", "ok") if hv == 0 else (f"{hv:,} hard violations", "bad"))
    if m.get("runtime_ms") is not None:
        chips.append((f"{m['runtime_ms']:,.0f} ms", ""))
    return _chips(chips)


def _icon(d: str) -> str:
    return (f'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="{d}" fill="none" stroke="currentColor" '
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>')


VIEWER_HTML = f"""<dialog class="viewer" id="viewer" aria-label="Image viewer">
  <div class="stage" id="v-stage"><img id="v-img" alt="" draggable="false"></div>
  <div class="vbar top">
    <div class="vtitle"><p class="vcap" id="v-cap"></p>
      <p class="vhint"><span class="touch">Pinch or double-tap to zoom, swipe for the next image</span><span
        class="fine">Scroll or double-click to zoom, drag to pan, arrow keys for the next image</span></p></div>
    <button type="button" class="vbtn" id="v-close" aria-label="Close">{_icon("M5 5L15 15M15 5L5 15")}</button>
  </div>
  <div class="vbar bottom">
    <button type="button" class="vbtn" id="v-prev" aria-label="Previous image">{_icon("M12 4L6 10L12 16")}</button>
    <button type="button" class="vbtn" id="v-out" aria-label="Zoom out">{_icon("M4 10H16")}</button>
    <span class="vpct" id="v-pct">100 %</span>
    <button type="button" class="vbtn" id="v-in" aria-label="Zoom in">{_icon("M4 10H16M10 4V16")}</button>
    <button type="button" class="vbtn" id="v-fit">Fit</button>
    <button type="button" class="vbtn" id="v-next" aria-label="Next image">{_icon("M8 4L14 10L8 16")}</button>
  </div>
</dialog>"""

# Pinch, double-tap, the wheel or the buttons zoom; a drag pans; a swipe at fit, the arrow buttons or
# keys step through the images and keep the view between images of the same size (one problem drawn
# by several labelers). Without <dialog> support the links open the images.
VIEWER_JS = r"""(() => {
  const dlg = document.getElementById("viewer");
  if (!dlg || typeof dlg.showModal !== "function") return;
  const $ = (id) => document.getElementById(id);
  const stage = $("v-stage"), img = $("v-img"), cap = $("v-cap"), pct = $("v-pct");
  const prev = $("v-prev"), next = $("v-next");
  const shots = Array.from(document.querySelectorAll("a.shot"));
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  const ptrs = new Map();
  let cur = -1, natW = 1, natH = 1, fw = 1, fh = 1, s = 1, X = 0, Y = 0, nudge = 0, g = null, tap = null;

  const rect = () => stage.getBoundingClientRect();
  const at = (e) => { const r = rect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const maxScale = () => Math.max(4, (4 * natW) / fw); // up to 4 screen px per image px

  function fit() {
    const r = rect();
    const k = Math.min(r.width / natW, r.height / natH);
    fw = natW * k;
    fh = natH * k;
    img.style.width = fw + "px";
    img.style.height = fh + "px";
  }
  function apply(animate) {
    const r = rect();
    s = Math.min(Math.max(s, 1), maxScale());
    const w = fw * s, h = fh * s;
    X = w <= r.width ? (r.width - w) / 2 : Math.min(0, Math.max(r.width - w, X));
    Y = h <= r.height ? (r.height - h) / 2 : Math.min(0, Math.max(r.height - h, Y));
    img.style.transition = animate && !still.matches ? "transform 0.2s ease-out" : "none";
    img.style.transform = "translate(" + (X + nudge) + "px, " + Y + "px) scale(" + s + ")";
    pct.textContent = Math.round((100 * w) / natW) + " %";
    stage.classList.toggle("zoomed", s > 1.001);
  }
  function zoomAt(px, py, ns, animate) {
    ns = Math.min(Math.max(ns, 1), maxScale());
    X = px - ((px - X) / s) * ns;
    Y = py - ((py - Y) / s) * ns;
    s = ns;
    apply(animate);
  }
  function zoomBy(k) {
    const r = rect();
    zoomAt(r.width / 2, r.height / 2, s * k, true);
  }
  function show(i, keepView) {
    const a = shots[i];
    if (!a) return;
    const w = Number(a.dataset.w) || 1, h = Number(a.dataset.h) || 1;
    const keep = keepView && w === natW && h === natH;
    const thumb = a.querySelector("img");
    cur = i;
    natW = w;
    natH = h;
    img.src = thumb.currentSrc || thumb.src;
    img.alt = thumb.alt;
    cap.textContent = a.dataset.caption || thumb.alt;
    if (a.href !== img.src) {
      const hi = new Image();
      hi.onload = () => { if (cur === i) img.src = a.href; };
      hi.src = a.href;
    }
    prev.disabled = i === 0;
    next.disabled = i === shots.length - 1;
    fit();
    if (!keep) s = 1;
    nudge = 0;
    apply(false);
  }
  function step(d) {
    if (cur + d >= 0 && cur + d < shots.length) show(cur + d, true);
  }

  shots.forEach((a, i) => a.addEventListener("click", (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    document.documentElement.classList.add("viewing");
    if (!dlg.open) dlg.showModal();
    show(i, false);
  }));
  dlg.addEventListener("close", () => {
    document.documentElement.classList.remove("viewing");
    cur = -1;
    ptrs.clear();
    g = null;
  });
  $("v-close").addEventListener("click", () => dlg.close());
  $("v-in").addEventListener("click", () => zoomBy(1.6));
  $("v-out").addEventListener("click", () => zoomBy(1 / 1.6));
  $("v-fit").addEventListener("click", () => { s = 1; apply(true); });
  prev.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "+" || e.key === "=") zoomBy(1.6);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.6);
    else if (e.key === "0") { s = 1; apply(true); }
    else return;
    e.preventDefault();
  });
  window.addEventListener("resize", () => { if (dlg.open) { fit(); apply(false); } });

  // one pointer pans (at fit: swipes), two pinch around their midpoint; a second tap toggles the zoom
  function begin(before) {
    const p = Array.from(ptrs.values());
    if (p.length >= 2) {
      const a = p[0], b = p[1];
      g = { pinch: true, d: Math.hypot(b.x - a.x, b.y - a.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, s, X, Y };
    } else if (p.length === 1) {
      g = { pinch: false, x: p[0].x, y: p[0].y, s, X, Y, t: performance.now(), moved: false, multi: !!before };
    } else g = null;
  }
  stage.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, at(e));
    begin(ptrs.size > 1 ? g : null);
    stage.classList.add("dragging");
  });
  stage.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, at(e));
    if (!g) return;
    const p = Array.from(ptrs.values());
    if (g.pinch) {
      if (p.length < 2) return;
      const a = p[0], b = p[1];
      const ns = Math.min(Math.max((g.s * Math.hypot(b.x - a.x, b.y - a.y)) / g.d, 1), maxScale());
      X = (a.x + b.x) / 2 - ((g.mx - g.X) / g.s) * ns;
      Y = (a.y + b.y) / 2 - ((g.my - g.Y) / g.s) * ns;
      s = ns;
      apply(false);
      return;
    }
    const dx = p[0].x - g.x, dy = p[0].y - g.y;
    if (!g.moved && Math.abs(dx) + Math.abs(dy) > 8) g.moved = true;
    if (!g.moved) return;
    if (g.s > 1.001) {
      X = g.X + dx;
      Y = g.Y + dy;
    } else if (!g.multi) nudge = dx * 0.6;
    apply(false);
  });
  function end(e) {
    if (!ptrs.has(e.pointerId)) return;
    const q = e.type === "pointercancel" ? ptrs.get(e.pointerId) : at(e);
    ptrs.delete(e.pointerId);
    const was = g;
    if (ptrs.size > 0) { begin(was); return; }
    g = null;
    stage.classList.remove("dragging");
    const swiping = nudge !== 0;
    nudge = 0;
    if (!was || was.pinch || was.multi || e.type === "pointercancel") { apply(true); return; }
    if (!was.moved) {
      const now = performance.now();
      if (now - was.t > 350) { tap = null; return; }
      if (tap && now - tap.t < 400 && Math.hypot(q.x - tap.x, q.y - tap.y) < 32) {
        tap = null;
        if (s > 1.001) { s = 1; apply(true); }
        else zoomAt(q.x, q.y, Math.max(2.5, natW / 2 / fw), true);
      } else tap = { t: now, x: q.x, y: q.y };
      return;
    }
    tap = null;
    const dx = q.x - was.x, dy = q.y - was.y;
    const d = dx < 0 ? 1 : -1;
    if (was.s <= 1.001 && Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy) && cur + d >= 0 && cur + d < shots.length) {
      step(d);
    } else if (swiping) apply(true);
  }
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = at(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    zoomAt(p.x, p.y, s * Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015)), false);
  }, { passive: false });
})();"""


def figure_html(fig: Fig, m: dict, lazy: bool) -> str:
    title = fig.title.format(**m)
    scenario, _, config = fig.key.partition("/")
    return f"""<figure class="fig{' wide' if fig.wide else ''}" id="{E(fig.key.replace('/', '--'))}">
  {_img(m, title, f"{title} · {scenario} · {config}", lazy)}
  <figcaption>
    <span class="src">{E(scenario)} · {E(config)}</span>
    <h3>{E(title)}</h3>
    <p>{fig.text.format(**m)}</p>
    {_fig_chips(m)}
  </figcaption>
</figure>"""


def comparison_html(c: dict) -> str:
    cells = []
    for x in c["cells"]:
        mine = " mine" if x["solver"] == "rust" else ""
        if "img" not in x:
            cells.append(f'<div class="cell"><div class="cellhead">{E(x["name"])}</div>'
                         f'<p class="naw">Could not run this problem: {E(x["why"])}</p></div>')
            continue
        hv = x["hard_violations"]
        chips = _chips([(f"{x['placed']:,} of {x['total']:,} placed", ""),
                        ("no hard violations", "ok") if hv == 0 else (f"{hv:,} hard violations", "bad")])
        cells.append(f'<div class="cell{mine}"><div class="cellhead">{E(x["name"])}</div>'
                     f'{_img(x, c["title"] + ", " + x["name"], c["title"] + " · " + x["name"], True)}{chips}</div>')
    return f"""<figure class="cmp">
  <figcaption class="pairhead"><span class="src">{E(c['scenario'])} · {E(c['config'])}</span><h3>{E(c['title'])}</h3><p>{c['text']}</p></figcaption>
  <div class="cmpgrid">{''.join(cells)}</div>
</figure>"""


def stability_html(st: dict) -> str:
    n = st["n_frames"] or len(st["frames"])
    cells = []
    for f in st["frames"]:
        label = f"Frame {f['frame']} of {n}"
        cells.append(f'<div class="cell"><div class="cellhead">{label}</div>'
                     f'{_img(f, "Zoom sequence, " + label.lower(), label, True)}</div>')
    cells = "".join(cells)
    chips = []
    if st["displacement_median_px"] is not None:
        chips.append((f"median movement {st['displacement_median_px']:.0f} px per frame", ""))
    if st["nesting"] is not None:
        chips.append((f"{st['nesting'] * 100:.0f} % of labels stay when zooming in", ""))
    if st["flips_pan"] is not None:
        chips.append((f"{st['flips_pan'] * 100:.0f} % change side per pan step", ""))
    if st["flips_zoom"] is not None:
        chips.append((f"{st['flips_zoom'] * 100:.0f} % change side per zoom step",
                      "bad" if st["flips_zoom"] > 0.1 else ""))
    flips = ""
    if st["flips_zoom"] is not None and st["flips_zoom"] > 0.1:
        flips = (f" Zooming in still makes {st['flips_zoom'] * 100:.0f} % of the labels change sides at each step, "
                 "which a reader notices.")
    return f"""<figure class="cmp">
  <figcaption class="pairhead"><span class="src">{E(st['scenario'])} · {E(st['sequence'])}</span>
  <h3>Zooming into a map of airports, then panning</h3>
  <p>{n} frames of an interactive map: {st['zoom_steps']} zoom steps, then {st['pan_steps']} pan steps. Each frame is
  solved with the previous result as a warm start, so most labels keep their place.{flips}</p>{_chips(chips)}</figcaption>
  <div class="cmpgrid three">{cells}</div>
</figure>"""


def key_html() -> str:
    mark, lead, omit = render.MARK_STROKE, render.LEADER, render.UNPLACED
    return f"""<div class="key" aria-label="How to read the images">
  <span><svg width="44" height="18" viewBox="0 0 44 18" aria-hidden="true"><rect width="44" height="18" fill="{render.OBST}"/><rect x="3" y="2" width="38" height="14" fill="#fff" fill-opacity="{render.LABEL_FILL_OPACITY}"/><text x="22" y="13" font-size="10" text-anchor="middle" fill="{render.LABEL_TEXT}" font-family="Noto Sans, sans-serif">Label</text></svg>label box as reported by the engine</span>
  <span><svg width="44" height="18" viewBox="0 0 44 18" aria-hidden="true"><circle cx="6" cy="12" r="4" fill="{render.MARK_FILL}" stroke="{mark}"/><polyline points="10,10 30,4 42,4" fill="none" stroke="{lead}" stroke-width="1.5"/></svg>item mark and leader</span>
  <span><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M4 4 L14 14 M14 4 L4 14" stroke="{omit}" stroke-width="2.2"/></svg>item whose label was omitted</span>
</div>"""


def notes_html(figs: dict[str, dict]) -> str:
    """What the defaults still do badly, with the numbers of this build."""
    def n(key: str) -> dict | None:
        return figs.get(key)

    def ref(key: str, name: str) -> str:
        m = n(key)
        return f'<a href="#{key.replace("/", "--")}">{E(name)}</a> {m["placed"]:,} of {m["total"]:,}'

    notes = []
    crowd = [(k, t) for k, t in (("06-city-pois/monaco-pins-ink", "Monaco"),
                                 ("05-airports/world-iata-1000-vector", "world airports")) if n(k)]
    if crowd:
        notes.append(("Crowds keep few labels",
                      "Where marks overlap, a label that would need a leader across other marks or close to "
                      f"another leader is left out rather than drawn ambiguously ({', '.join(ref(k, t) for k, t in crowd)} "
                      "placed). Omitted items are reported with the reason; showing more of them takes a larger "
                      "canvas, smaller text or fewer items."))
    ends = [(k, t) for k, t in (("09-line-end-labels/unemployment-14-vector", "unemployment"),
                                ("09-line-end-labels/life-62-boundary", "life expectancy")) if n(k)]
    if ends:
        notes.append(("Crowded line ends",
                      "Where line ends crowd, their labels stand in a column beside them with fanning leaders. A "
                      "column grows only as far as its leaders stay within <code>leaders.max_length</code> (10 em) "
                      "and clear of the other marks; ends beyond that stay without a label "
                      f"({', '.join(ref(k, t) for k, t in ends)} placed). A larger limit gives taller columns."))
    return "".join(f'<div class="note"><h3>{E(h)}</h3><p>{p}</p></div>' for h, p in notes)


def page(meta: dict, figs: dict[str, dict], sections=SECTIONS, cmps=(), stab=None, notes: str = "") -> str:
    body, toc, first = [], [], True
    for sec in sections:
        items = []
        for f in sec.figs:
            if f.key in figs:
                items.append(figure_html(f, figs[f.key], lazy=not first))
                first = False
        if not items:
            continue
        sub = f" <small>{E(sec.sub)}</small>" if sec.sub else ""
        lede = f'<p class="lede">{sec.lede}</p>' if sec.lede else ""
        toc.append((sec.id, sec.title))
        body.append(f'<section id="{sec.id}"><h2>{E(sec.title)}{sub}</h2>{lede}<div class="grid">'
                    + "\n".join(items) + "</div></section>")
    if cmps:
        toc.append(("baselines", "Other labelers"))
        body.append('<section id="baselines"><h2>Next to other labelers</h2><p class="lede">The benchmark runs other '
                    "label placers on the same problems: ggrepel (R), adjustText and textalloc (Python), vega-label "
                    "(JavaScript) and a plain greedy baseline. Label Anything's cell has the blue frame.</p>"
                    + "".join(comparison_html(c) for c in cmps) + "</section>")
    if stab:
        toc.append(("stability", "Interactive use"))
        body.append(f'<section id="stability"><h2>Interactive use</h2>{stability_html(stab)}</section>')
    if notes:
        toc.append(("weak", "Limits"))
        body.append('<section id="weak"><h2>Where it falls short</h2><p class="lede">What the current defaults '
                    f'still do badly.</p><div class="notes">{notes}</div></section>')
    nav = ('<nav class="toc" aria-label="Sections"><ul>'
           + "".join(f'<li><a href="#{i}">{E(t)}</a></li>' for i, t in toc) + "</ul></nav>")
    report = (f' The <a href="{E(meta["report"])}">benchmark report</a> has every metric of every problem.'
              if meta.get("report") else "")
    machine = f" on {E(meta['machine'])}" if meta.get("machine") else ""
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Label Anything Gallery</title>
<meta name="description" content="Labels placed by Label Anything on problems of its real-world benchmark: charts, maps, photos, embeddings and networks.">
<style>{CSS}</style>
</head>
<body>
<div class="wrap">
<header>
  <span class="eyebrow"><a href="{SITE}">Label Anything</a> · gallery</span>
  <h1>Labels placed <span class="box">by the engine</span></h1>
  <p>Problems of the project's real-world benchmark, solved by the engine at commit <code>{E(meta['commit'])}</code>
  ({E(meta['date'])}): real data sets, each problem with its own settings and the engine's defaults otherwise.
  Every picture comes from the benchmark's renderer; the numbers under it from its evaluator, which checks the result
  independently of the engine.{report} Select an image to inspect it: pinch or double-tap to zoom on a phone,
  scroll or double-click with a mouse.</p>
  {key_html()}
  {nav}
</header>
{''.join(body)}
<footer>
  <p>Times are the engine's own (<code>stats.runtime_ms</code>), for a solve after three warm-up solves{machine}.
  Hard violations are counted by the benchmark's evaluator: labels overlapping each other or what they must avoid,
  crossing leaders, leaders through other marks, labels outside the canvas.</p>
  <p>Reproduce: <code>python -m bench.gallery --engine rust/target/release/label-anything --run bench-report</code>
  after <code>python bench/run.py --suite quick --engine rust/target/release/label-anything --baselines</code>
  (<a href="{REPO_URL}/blob/main/bench/README.md">bench/README.md</a>). Source:
  <a href="{REPO_URL}">{E(REPO_URL.removeprefix('https://'))}</a>.</p>
</footer>
</div>
{VIEWER_HTML}
<script>
{VIEWER_JS}
</script>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
def commit() -> str:
    sha = os.environ.get("GITHUB_SHA", "")
    if not sha:
        try:
            sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=paths.REPO, capture_output=True, text=True,
                                 check=True).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            sha = "unknown"
    return sha[:7]


def machine_text(m: dict | None) -> str:
    if not m:
        return ""
    cpu, cores = m.get("cpu") or "", m.get("cores")
    return ", ".join(x for x in (cpu, f"{cores} cores" if cores else "") if x)


def build(out: Path, solve: Solve, problems: Path = paths.PROBLEMS, run: Path | None = None,
          sections=SECTIONS, log=print) -> int:
    """Write the gallery to ``out``; 1 if a figure failed (the page is written without it), else 0."""
    out.mkdir(parents=True, exist_ok=True)
    report = read_json(run / "results.json") if run is not None and (run / "results.json").exists() else None
    figs, failed = {}, []
    with tempfile.TemporaryDirectory(prefix="la-gallery-") as tmp:
        for sec in sections:
            for f in sec.figs:
                files = problem_files(problems, f.key)
                if files is None:
                    log(f"{f.key}: not built, skipped")
                    continue
                t0 = time.time()
                try:
                    figs[f.key] = m = solve_figure(f, files, solve, out, Path(tmp))
                except Exception as e:  # noqa: BLE001 - report, leave the figure out
                    failed.append(f.key)
                    log(f"{f.key}: FAILED: {type(e).__name__}: {e}")
                    continue
                log(f"{f.key}: placed {m['placed']}/{m['total']}, {m['leaders']} leaders, "
                    f"hard {m['hard_violations']} ({time.time() - t0:.1f} s)")
    cmps = comparisons(run, report, out, problems) if report is not None else []
    stab = stability(run, report, out) if report is not None else None
    for name in ("NotoSans-Regular.ttf", "NotoSans-Bold.ttf", "OFL.txt"):
        (out / "fonts").mkdir(exist_ok=True)
        shutil.copy2(paths.FONTS / name, out / "fonts" / name)
    inside = run is not None and out.resolve().parent == run.resolve()
    meta = {"commit": commit(), "date": time.strftime("%Y-%m-%d"),
            "machine": machine_text((report or {}).get("machine") if report else None) or machine_text(_machine()),
            "report": "../index.html" if inside and (run / "index.html").exists() else None}
    (out / "index.html").write_text(page(meta, figs, sections, cmps, stab, notes_html(figs)), encoding="utf-8")
    write_json(out / "gallery.json", {"meta": meta, "figures": figs, "comparisons": cmps, "stability": stab},
               nd=3, indent=1)
    if inside and report is not None and (run / "index.html").exists():
        from bench import report as rep

        rep.write_html(run, report, report.get("plots"))
    log(f"wrote {out / 'index.html'}: {len(figs)} figures, {len(cmps)} comparisons"
        + (", stability frames" if stab else ""))
    return 1 if failed or not figs else 0


def _machine() -> dict:
    from bench.perf.runner import machine

    return machine()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m bench.gallery", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--engine", required=True, help="the label-anything CLI binary (or a command) that solves the figures")
    ap.add_argument("--run", help="output directory of a bench/run.py run with renderings (results.json): adds "
                                  "its baseline comparisons and stability frames")
    ap.add_argument("--problems", default=str(paths.PROBLEMS), help="built problems (default bench/out/problems)")
    ap.add_argument("--out", help="output directory (default <run>/gallery, else bench-report/gallery)")
    ap.add_argument("--warmup", type=int, default=3, help="warm-up solves before the reported one (default 3)")
    ap.add_argument("--timeout", type=float, default=600.0, help="seconds per solve")
    a = ap.parse_args(argv)
    run = Path(a.run) if a.run else None
    out = Path(a.out) if a.out else (run / "gallery" if run is not None else paths.REPORT / "gallery")
    if run is not None and out.resolve() == run.resolve():
        ap.error("--out must not be the run directory (its index.html is the report)")
    return build(out, engine_solve(a.engine, a.warmup, a.timeout), Path(a.problems), run)


if __name__ == "__main__":
    raise SystemExit(main())
