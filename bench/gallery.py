"""Gallery: benchmark problems solved by Label Anything, as one HTML page of vector images.

    python -m bench.gallery --engine rust/target/release/label-anything [--run bench-report] [--out DIR]

Every figure is a problem of the benchmark (``bench/out/problems``, built by ``python -m
bench.scenarios build``), solved with that problem's settings and the engine's defaults
(``ENGINE place PROBLEM -o RESULT --warmup 3``, the command of ``bench/run.py --engine``) and
drawn by the benchmark's renderer as one self-contained SVG (``bench/render.py``,
``standalone_svg``: the background's vectors inlined, raster backgrounds embedded, the label text
set in an embedded subset of Noto Sans at the measured glyph positions), so that zooming in stays
sharp. The numbers under a figure come from the evaluator (``bench/eval``, independent of the
engine), the runtime from the engine (``stats.runtime_ms``); every figure also shows the
settings its problem gives and why the omitted labels were left out. With ``--run``, the output
directory of a ``bench/run.py`` run that rendered its results, the page adds the run's results of
the same problems by the baselines and frames of its stability sequence, drawn the same way.

Output (default ``<run>/gallery``, else ``bench-report/gallery``): ``index.html``, ``img/*.svg``
(the figures; the page's image viewer zooms into them: pinch, double-tap or scroll to zoom, drag
to pan, swipe or the arrow keys for the next image), ``fonts/`` (Noto Sans and its licence: the
page loads nothing from other servers) and ``gallery.json`` (the numbers of every figure). A
gallery written into its run directory is linked from the run's report (``index.html`` is
rebuilt). CI's ``baselines`` job does that, so the Pages workflow publishes it at
``<site>/benchmark-report/gallery/``.
"""
from __future__ import annotations

import argparse
import html
import json
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
    figure's numbers (``{placed}``, ``{total}``, ``{leaders}``, ``{omitted}``, ``{fans}``,
    ``{tier_placed}``, ``{tier_total}``, ``{omitted_ids}``, ``{top_omitted}``, ``{top_placed}``, ``{first_cut}``,
    ``{first_cut_rank}``, …; see ``solve_figure``) as in str.format. ``limit``: the figure shows a
    shortcoming (drawn with the notes of the "Where it falls short" section)."""
    key: str
    title: str
    text: str
    wide: bool = False
    limit: bool = False


@dataclass(frozen=True)
class Section:
    id: str
    title: str
    sub: str
    lede: str
    figs: tuple[Fig, ...]


SECTIONS = (
    Section("maps", "Maps: hubs first", "the busiest airports first, the others as context",
            "On a map of airports the busy ones matter: their labels must be there, next to their dots, and a "
            "small airport's label is welcome only where it leaves them room. The two maps model exactly that. "
            "The busiest airports are a tier of their own (<code>priority.tiers</code>), placed first and set "
            "larger (<code>priority.font_classes</code>); the next ones are items too, labeled where the hubs "
            "leave room, and a hub's label may cover their dots (<code>avoid.label.lower_items</code>), which then "
            "go unlabeled; every other airport is a dot without a label, which a label may cover at a small cost "
            "(<code>avoid.label.points: 0.3</code>), so the map keeps its context. What counts is the dense "
            "regions: London, the Low Countries and the Rhine, northern Italy, the US east coast, eastern China.", (
                Fig("05-airports/europe-hubs-svg", "Europe's busiest airports",
                    "Europe at 30 px per degree. All {tier_placed} of the {tier_total} busiest airports are "
                    "labeled, in larger type, next to their dots, and {rest_placed} of the next {rest_total}; the "
                    "{context} other airports of the map stay dots. The five London airports, Paris, Brussels, "
                    "Amsterdam, Düsseldorf and Cologne keep their names close by; city names with several "
                    "airports carry the airport's code.", wide=True),
                Fig("05-airports/world-hubs-100-svg", "The world's 100 busiest airports",
                    "IATA codes at 8 px on a world map at 6 px per degree, the 30 busiest a size larger; the "
                    "{context} other served airports are dots. {tier_placed} of the {tier_total} hubs and "
                    "{rest_placed} of the next {rest_total} are labeled; left out: {omitted_ids}. In western "
                    "Europe's core eight hubs share a patch smaller than two labels; zoom in: the image is a vector "
                    "graphic.", wide=True),
                Fig("05-airports/world-iata-1000-lower-vector", "Every airport an item, the hubs first",
                    "The 1,000 busiest airports, all of them items, as in the last figure of the page, but a "
                    "label may now cover the dot of a less important airport (<code>avoid.label.lower_items: "
                    "10</code>); that airport then stays unlabeled, so no label sits on a dot it does not belong "
                    "to. {top_placed} of the ten busiest airports are labeled (left out: {top_omitted}), and "
                    "{placed:,} of all {total:,}.", wide=True),
                Fig("06-city-pois/monaco-pins-ink", "375 points of interest in Monaco",
                    "Icon and name labels over an OpenStreetMap raster, the main sights a size larger; the "
                    "engine reads streets and buildings from the pixels (ink mode) and keeps names off the "
                    "busiest parts. Where the pins crowd, {omitted} labels are left out."),
                Fig("06-city-pois/monaco-ink", "The same map with small dots instead of pins",
                    "Composite labels (icon + name) over the same raster."),
            )),
    Section("charts", "Charts", "scatterplots, bubbles, line ends", "", (
        Fig("03-gapminder/y2005-svg", "Gapminder 2005",
            "Life expectancy vs. fertility of 62 countries, bubble area by population, every bubble in the "
            "color of its region (legend). The 40 most populous countries and the 6 farthest from the trend "
            "are labeled, the most populous larger, big bubbles inside; {omitted} labels in the crowded "
            "corner of rich countries are left out. The year watermark is a soft obstacle, the legend a hard "
            "one."),
        Fig("02-volcano/top50-svg", "Top 50 genes of a volcano plot",
            "16,406 genes of a differential-expression table. Red and blue: genes past both dashed thresholds "
            "(p &lt; 0.05 and at least twofold up or down). The 50 most significant genes are labeled and keep "
            "these colors, so the grey ones among them are significant but changed less than twofold; the top "
            "three larger."),
        Fig("09-line-end-labels/unemployment-14-vector", "Unemployment by industry",
            "Labels at the right ends of 14 series, every end in its line's color: only positions right of the "
            "ends are allowed. Where the ends crowd, the labels stand in a column beside them, in the order of "
            "the ends, with fanning leaders ({fans} fan labels)."),
        Fig("09-line-end-labels/life-62-boundary", "Life expectancy of 62 countries",
            "One color per region, as in the bubble chart. The labels stand in one column in the right margin "
            "(models <code>adjacent</code> and <code>boundary</code>), stacked around the ends' heights; the "
            "leaders are matched to the slots so that none cross. The densest band, around 75–80 years, does "
            "not fit: {omitted} of its ends stay unlabeled ({placed:,} of {total:,} placed)."),
        Fig("01-software-metrics/cbo-rfc-100-svg", "The 100 most unusual classes of React Native's Java code",
            "Coupling vs. response for 1,206 classes (log scales); the 100 classes farthest from their five "
            "nearest neighbours are labeled with their names below <code>com.facebook.react</code>, which wrap "
            "at package dots; the five most unusual larger, the others a size smaller. The plot is an SVG whose "
            "points, axes and tick labels the engine reads as obstacles; {omitted} labels in the top right "
            "find no room."),
        Fig("01-software-metrics/wmc-loc-30-raster", "A chart that is only a picture",
            "The whole scatterplot is a PNG. The engine finds axes, points and text in the pixels "
            "(raster ink mode) and keeps the 30 labels off them."),
    )),
    Section("images", "Photos and illustrations", "area anchors, leaders, margin labels", "", (
        Fig("08-illustration/astronaut-boundary", "Annotated portrait",
            "Twelve regions of a NASA portrait are area anchors (one is a ring with a hole). The preset "
            "<code>illustration</code> charges a label over the photo per em² like a leader, so most labels "
            "stand in the margins or beside the photo; those of regions in its middle stay close to them. "
            "Elbow leaders end inside each region."),
        Fig("08-illustration/retina-boundary", "Fundus photograph",
            "Ten anatomical structures of a retina image (raster at scale 2), with elbow leaders: labels "
            "in the margins where a leader to them costs less than covering the image, the others close "
            "to their structures."),
        Fig("08-illustration/rocket-distant", "Falcon 9 on the launch pad",
            "Twelve parts labeled with straight leaders to positions off the rocket; duplicate label "
            "texts are allowed."),
    )),
    Section("graphs", "Embeddings and networks", "", "", (
        Fig("07-node-link/lesmis-force", "Les Misérables, as the force layout leaves it",
            "77 characters in the d3-force layout of the benchmark's moving-node sequences, at rest: circles by "
            "the number of co-occurring characters, colored by community, edges as wide as the "
            "co-occurrences. Every character is named ({placed} of {total}), the most connected larger; edges "
            "are soft obstacles."),
        Fig("04-embedding/k40-ink", "40 cluster names over 50,000 points",
            "Long topic names wrap; the point cloud is a raster the engine reads in ink mode."),
        Fig("07-node-link/flare-imports", "Flare's classes and their imports",
            "220 classes of the Flare visualization toolkit in a force layout, colored by top-level package. "
            "The 100 most connected are labeled with their class names, the other 120 are nodes labels must "
            "not cover. The core of <code>flare.vis</code> and <code>flare.util</code> is a knot: {omitted} "
            "labels find no room there, some others shrink.", wide=True),
        Fig("04-embedding/k120-areas", "120 topics of WordNet",
            "50,000 noun glosses embedded with t-SNE; 120 clusters are area anchors (hulls of their "
            "cores), labeled inside or next to them over a raster of the points.", wide=True),
    )),
    Section("priority", "Priority decides what is left out", "",
            "Europe's 250 busiest airports compete for room at 9 px; every other airport is a dot. Priority is "
            "the number of routes. With <code>strict</code> omission, a label is left out only if more "
            "important labels leave no room for it, so smaller airports fill every gap. With "
            "<code>prefix</code>, the labels shown are exactly the top of the ranking: everything after the "
            "first airport that does not fit is left out.", (
                Fig("12-priority/europe-attr-strict", "strict: {placed} labels",
                    "Every omitted airport is blocked by a more important label.", wide=True),
                Fig("12-priority/europe-attr-prefix", "prefix: the {placed} busiest airports",
                    "{first_cut}, number {first_cut_rank}, has no free position, so no airport ranked below it "
                    "is shown: a reader can trust that every airport busier than a labeled one is labeled too.",
                    wide=True),
            )),
    Section("weak", "Where it falls short", "", "What the current defaults and models still do badly.", (
        Fig("05-airports/world-iata-1000-vector", "Every airport an item: the hubs lose",
            "The 1,000 busiest airports, all of them items. An item's mark is a hard obstacle for every other "
            "label, whatever the item's priority, so where airports crowd the busiest find no free position: "
            "{top_omitted} — {n_top_omitted} of the ten busiest airports — stay unlabeled while small airports "
            "elsewhere are labeled ({placed:,} of {total:,}). That is the default; "
            "<code>avoid.label.lower_items</code> lets a label cover the marks of less important items, as in "
            "the hub maps above.", wide=True, limit=True),
    )),
)

# (scenario, config, title, caption) of the baseline comparisons, if the run has them
COMPARISONS = (
    ("03-gapminder", "y2005-vector", "Gapminder 2005, labeled by {n} tools",
     "The same 46 bubbles, the same obstacles, scored by the same evaluator. Hard violations count "
     "labels on top of each other, of bubbles or of axes. adjustText never omits a label, so it "
     "overlaps instead; ggrepel's repulsion does not always separate everything."),
    ("05-airports", "world-iata-300-none", "300 busiest airports, labeled by {n} tools",
     "IATA codes, other airports as soft points."),
    ("02-volcano", "top20-vector", "Volcano plot, top 20 genes",
     "A sparse case: every tool places almost everything, and the differences are in overlaps."),
)
COMPARE_SOLVERS = ("rust", "ggrepel", "adjusttext", "textalloc", "vega-label", "echarts", "d3fc", "d3-labeler",
                   "greedy")
NAMES = {"rust": "Label Anything", "ggrepel": "ggrepel (R)", "adjusttext": "adjustText", "textalloc": "textalloc",
         "vega-label": "vega-label", "echarts": "ECharts (hideOverlap)", "d3fc": "d3fc label layout",
         "d3-labeler": "D3-Labeler", "greedy": "Greedy baseline", "naive": "Naive (no collision test)"}
NUMBERS = {2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten"}
REASONS = {"omitted_by_priority": "behind more important labels", "no_feasible_candidate": "no free position",
           "budget_exhausted": "out of time", "keep_with": "with their set", "grouped": "in a group label"}


# ---------------------------------------------------------------------------
# figures
# ---------------------------------------------------------------------------
def problem_files(problems: Path, key: str) -> dict | None:
    """Problem, truth and backgrounds of ``scenario/config`` from its scenario manifest (None if not built)."""
    scenario, _, config = key.partition("/")
    man_path = problems / scenario / "scenario.json"
    if not man_path.exists():
        return None
    c = next((c for c in read_json(man_path).get("configs", []) if c.get("name") == config), None)
    if c is None:
        return None
    files = {k: man_path.parent / v for k, v in c["files"].items()}
    return {"problem": files["problem"], "truth": files.get("truth"),
            "background_svg": files.get("background_svg"),
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


ZOOM = 6.0  # the viewer zooms into a figure up to this many times its canvas size (it is a vector image)


def save_webp(img: Image.Image, path: Path, quality: int = 90) -> list[int]:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(path, "WEBP", quality=quality, method=6)
    return list(img.size)


def write_svg(problem: dict, result: dict, files: dict, out: Path, rel: str, title: str | None = None) -> dict:
    """The figure as one self-contained SVG at ``out / rel``; the page shows it at the canvas size, the viewer
    zooms into it (``full`` is the same file, ``full_size`` the largest size the viewer zooms to)."""
    svg = render.standalone_svg(problem, result, files.get("background_svg"), files.get("background"), title=title)
    path = out / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(svg, encoding="utf-8")
    c = problem.get("canvas") or {}
    w, h = round(float(c.get("width", 800))), round(float(c.get("height", 600)))
    return {"img": rel, "size": [w, h], "full": rel, "full_size": [round(w * ZOOM), round(h * ZOOM)]}


def settings(problem: dict) -> dict:
    """What a problem sets beyond the engine's defaults, for the figure's "Settings" box: the preset, the
    font size, the obstacles' kinds and the option groups it gives (priority, placement, leaders, avoid,
    degradation)."""
    obs = problem.get("obstacles") or {}
    kinds = []
    if obs.get("svg"):
        kinds.append("SVG")
    for r in ([obs["raster"]] if isinstance(obs.get("raster"), dict) else obs.get("raster") or []):
        kinds.append(f"raster ({r.get('mode', 'ink')})")
    vec = sorted({lay.get("class", "?") for lay in obs.get("vector") or []})
    if vec:
        kinds.append("vector: " + ", ".join(vec))
    out = {"items": len(problem.get("items", [])), "preset": problem.get("preset", "auto"),
           "font": ((problem.get("defaults") or {}).get("font") or {}).get("size", 12),
           "obstacles": kinds}
    for k in ("priority", "placement", "leaders", "avoid", "degrade", "degrade_options"):
        if problem.get(k):
            out[k] = problem[k]
    return out


def _cjk(ch: str) -> bool:
    o = ord(ch)
    return 0x2E80 <= o <= 0x9FFF or 0xAC00 <= o <= 0xD7AF or 0xF900 <= o <= 0xFAFF or 0xFF00 <= o <= 0xFFEF or \
        0x20000 <= o <= 0x2FFFF


def split_word(text: dict | None, original: str) -> bool:
    """Whether a placed label's lines end where the text has no break opportunity (spec §5.3: white space,
    punctuation, camelCase, acronym, CJK), i.e. inside a word: an emergency break."""
    lines = (text or {}).get("lines") or []
    for a, b in zip(lines, lines[1:]):
        if not a or not b or a + b not in original:
            continue  # broken at white space (or not a line pair of this text)
        x, y, z = a[-1], b[0], b[1:2]
        if x in "/\\._-,;:|" or (x.islower() and y.isupper()) or (x.isupper() and y.isupper() and z.islower()) \
                or (_cjk(x) and _cjk(y)):
            continue
        return True
    return False


def solve_figure(fig: Fig, files: dict, solve: Solve, out: Path, tmp: Path) -> dict:
    """Solve, evaluate and render one figure; the numbers of its chips and caption, and its image."""
    name = fig.key.replace("/", "__")
    problem = read_json(files["problem"])
    result = solve(files["problem"], tmp / f"{name}.json")
    truth = read_json(files["truth"]) if files.get("truth") else None
    s = evaluate(problem, result, truth, removal_test=False)["summary"]
    images = write_svg(problem, result, files, out, f"img/{name}.svg", fig.title.split(":")[0])
    pl = result.get("placements", [])
    by_id = {p["id"]: p for p in pl}
    leaders = sum(1 for p in pl if p.get("placed") and p.get("leader"))
    fans = sum(1 for p in pl if p.get("placed") and p.get("model") == "fan")
    reasons: dict[str, int] = {}
    for p in pl:
        if not p.get("placed"):
            reasons[p.get("reason") or "omitted"] = reasons.get(p.get("reason") or "omitted", 0) + 1
    texts = {it.get("id", str(k)): (it.get("label") or {}).get("text", "") for k, it in enumerate(problem["items"])}
    rank = {p["id"]: (p.get("priority") or {}).get("rank", 0) for p in pl}
    tier = {p["id"]: (p.get("priority") or {}).get("tier", 0) for p in pl}
    omitted = sorted((p["id"] for p in pl if not p.get("placed")), key=lambda i: rank.get(i, 0))
    top_omitted = [i for i in omitted if rank.get(i, 0) < 10]
    tiered = [i for i in by_id if tier[i] > 0]
    rest = [i for i in by_id if tier[i] <= 0]
    context = sum(len(lay.get("points") or []) + len(lay.get("circles") or [])
                  for lay in (problem.get("obstacles") or {}).get("vector") or [] if lay.get("class") == "points")
    if (problem.get("obstacles") or {}).get("svg"):
        src = problem["obstacles"]["svg"].get("source") or ""
        context += src.count('class="airport"')
    first = omitted[0] if omitted else None
    split = [" / ".join(p["text"]["lines"]) for p in pl
             if p.get("placed") and split_word(p.get("text"), texts.get(p["id"], ""))]
    return {"key": fig.key, **images, "placed": s["placed"], "total": s["total"], "omitted": s["total"] - s["placed"],
            "leaders": leaders, "fans": fans, "reasons": reasons,
            "tier_placed": sum(1 for i in tiered if by_id[i].get("placed")), "tier_total": len(tiered),
            "rest_placed": sum(1 for i in rest if by_id[i].get("placed")), "rest_total": len(rest),
            "context": context, "omitted_ids": ", ".join(omitted[:12]) or "none",
            "top_omitted": ", ".join(top_omitted) or "none", "n_top_omitted": len(top_omitted),
            "top_placed": sum(1 for p in pl if p.get("placed") and rank.get(p["id"], 0) < 10),
            "first_cut": texts.get(first, "") if first else "", "first_cut_rank": rank.get(first, -1) + 1,
            "split_words": split,
            "settings": settings(problem),
            "hard_violations": s["hard_violations"], "leader_len_max_em": s.get("leader_len_max_em"),
            "leader_near_crossings": s.get("leader_near_crossings"),
            "leader_mark_touches": s.get("leader_mark_touches"),
            "runtime_ms": (result.get("stats") or {}).get("runtime_ms")}


# ---------------------------------------------------------------------------
# the run's baselines and stability frames
# ---------------------------------------------------------------------------
def comparisons(run: Path, report: dict, out: Path, problems: Path = paths.PROBLEMS) -> list[dict]:
    """The run's results for COMPARISONS, by every solver of COMPARE_SOLVERS it has, drawn like the
    figures (the run's own raster rendering when its result or problem file is gone)."""
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
                rel = f"img/cmp/{s}/{scenario}__{config}"
                res = run / r["result"] if r.get("result") else None
                prob = paths.REPO / r["problem"] if r.get("problem") else None
                if res is not None and res.exists() and prob is not None and prob.exists():
                    files = problem_files(problems, f"{scenario}/{config}") or {
                        "background": render.default_background_png(prob)}
                    cell.update(write_svg(read_json(prob), read_json(res), files, out, rel + ".svg",
                                          f"{title}, {NAMES.get(s, s)}"))
                else:
                    with Image.open(src) as im:
                        size = save_webp(im, out / (rel + ".webp"))
                    cell.update(img=rel + ".webp", size=size, full=rel + ".webp", full_size=size)
                sm = r["summary"]
                cell.update(placed=sm["placed"], total=sm["total"], hard_violations=sm.get("hard_violations") or 0)
            else:
                cell["why"] = r.get("skipped") or r.get("error") or "no rendering"
            cells.append(cell)
        if any(c["solver"] == "rust" and "img" in c for c in cells) and len(cells) > 1:
            figs.append({"scenario": scenario, "config": config, "title": title.format(n=NUMBERS.get(len(cells),
                                                                                               len(cells))),
                         "text": text, "cells": cells})
    return figs


SEQUENCES = ("zoom-pan-1000", "force-lesmis")
"""The stability sequences the page shows (when the run has them): a map zoomed and panned, a force layout
running (the moving nodes)."""


def stability(run: Path, report: dict, out: Path, problems: Path = paths.PROBLEMS,
              sequence: str | None = None) -> dict | None:
    """The first and middle and last frame of the run's rendered Label Anything sequence ``sequence`` (default:
    the first), drawn like the figures from the run's results (the run's own raster rendering when a result or
    frame is gone)."""
    seq = next((q for q in report.get("sequences", []) if q.get("solver") == "rust" and q.get("images")
                and sequence in (None, q.get("sequence"))), None)
    if seq is None:
        return None
    files = [f.get("file") for f in seq.get("frames") or []]
    frames = []
    for rel in seq["images"]:
        src = run / rel
        if not src.exists():
            return None
        stem = Path(rel).stem
        k = int(stem.removeprefix("frame"))
        dst = f"img/seq/{seq['sequence']}/{stem}"
        name = files[k] if k < len(files) else None
        res = run / "results" / "rust" / seq["scenario"] / seq["sequence"] / name if name else None
        prob = problems / seq["scenario"] / seq["sequence"] / name if name else None
        if res is not None and res.exists() and prob is not None and prob.exists():
            m = write_svg(read_json(prob), read_json(res), {}, out, dst + ".svg", f"Frame {k + 1}")
        else:
            with Image.open(src) as im:
                size = save_webp(im, out / (dst + ".webp"))
            m = {"img": dst + ".webp", "size": size, "full": dst + ".webp", "full_size": size}
        frames.append({**m, "frame": k + 1})
    m = seq.get("metrics") or {}
    steps = m.get("steps") or []

    def median_flips(kind: str) -> float | None:
        v = [x["flip_rate"] for x in steps if x.get("step") == kind and x.get("flip_rate") is not None]
        return statistics.median(v) if v else None

    return {"scenario": seq["scenario"], "sequence": seq["sequence"], "frames": frames,
            "n_frames": len(seq.get("frames") or []),
            "zoom_steps": sum(1 for x in steps if str(x.get("step", "")).startswith("zoom")),
            "pan_steps": sum(1 for x in steps if x.get("step") == "pan"),
            "tick_steps": sum(1 for x in steps if x.get("step") == "tick"),
            "drag_steps": sum(1 for x in steps if x.get("step") == "drag"),
            "flips_tick": median_flips("tick"), "flips_drag": median_flips("drag"),
            "displacement_median_px": m.get("displacement_median_px"),
            "displacement_mean_px": m.get("displacement_mean_px"),
            "nesting": m.get("nesting_fraction_mean"),
            "flips_pan": median_flips("pan"), "flips_zoom": median_flips("zoom_in")}


# ---------------------------------------------------------------------------
# the page
# ---------------------------------------------------------------------------
CSS = r"""
@font-face { font-family: "Noto Sans"; src: url("fonts/NotoSans-Regular.ttf") format("truetype"); font-weight: 400; font-display: swap; }
/* A contact sheet of figure cards on a cool grey ground; chips drawn like the label boxes of the images:
   black text on white in both themes. One weight throughout, as in the images: hierarchy by size and color. */
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
body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--body); font-size: 15px; line-height: 1.55;
  font-weight: 400; font-synthesis: none; }
h1, h2, h3, b, strong, th, button { font-weight: 400; }
a { color: var(--label); }
.wrap { max-width: 1280px; margin: 0 auto; padding-block: 44px 72px;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px));
  display: grid; gap: 56px; }
header { display: grid; gap: 14px; max-width: 72ch; }
.eyebrow { font-family: var(--mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--label); }
.eyebrow a { color: inherit; text-decoration: none; }
.eyebrow a:hover { text-decoration: underline; }
h1 { font-size: clamp(2.2rem, 5.2vw, 3.6rem); line-height: 1.08; margin: 0; letter-spacing: -0.025em; text-wrap: balance; }
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
section > h2 { font-size: 1.75rem; line-height: 1.2; margin: 0; display: flex; flex-wrap: wrap; align-items: baseline;
  gap: 4px 12px; text-wrap: balance; letter-spacing: -0.015em; }
section > h2 small { font-size: 14px; color: var(--muted); letter-spacing: 0; }
section > p.lede { margin: -10px 0 0; color: var(--muted); max-width: 72ch; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 520px), 1fr)); gap: 26px;
  align-items: start; }
.fig, .cmp { margin: 0; background: var(--card); border: 1px solid var(--rule); border-radius: 4px;
  display: grid; align-content: start; min-width: 0; overflow: hidden; scroll-margin-top: 16px; }
.fig.wide { grid-column: 1 / -1; }
.fig.limit { border-left: 3px solid var(--omit); }
.shot { display: block; background: #fff; border-bottom: 1px solid var(--rule); line-height: 0; cursor: zoom-in; }
.shot img { width: 100%; height: auto; display: block; }
.shot:focus-visible { outline: 3px solid var(--label); outline-offset: -3px; }
figcaption { padding: 14px 16px 16px; display: grid; gap: 6px; min-width: 0; }
.src { font-family: var(--mono); font-size: 11.5px; color: var(--muted); letter-spacing: 0.02em; overflow-wrap: anywhere; }
figcaption h3 { margin: 0; font-size: 1.2rem; line-height: 1.3; text-wrap: balance; letter-spacing: -0.005em; }
.srcrow { display: flex; flex-wrap: wrap; gap: 2px 12px; align-items: baseline; justify-content: space-between; }
.srcrow a { font-family: var(--mono); font-size: 11.5px; color: var(--muted); }
.srcrow a:hover, .srcrow a:focus-visible { color: var(--label); }
details.set { margin-top: 2px; font-size: 13px; color: var(--muted); }
details.set summary { cursor: pointer; width: fit-content; }
details.set summary:hover { color: var(--label); }
details.set pre { margin: 6px 0 0; padding: 10px 12px; background: var(--label-soft); border-radius: 2px; overflow-x: auto;
  font-family: var(--mono); font-size: 11.5px; line-height: 1.45; color: var(--ink); max-height: 22em; }
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
.cell.mine .cellhead { color: var(--label); }
.cell.mine { box-shadow: inset 0 0 0 2px var(--label); }
.naw { margin: 0; padding: 12px 14px; color: var(--muted); font-size: 13px; }
.notes { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 26px; }
.note { margin: 0; background: var(--card); border: 1px solid var(--rule); border-left: 3px solid var(--omit);
  border-radius: 4px; padding: 14px 16px 16px; display: grid; align-content: start; gap: 6px; min-width: 0; }
.note h3 { margin: 0; font-size: 1.2rem; line-height: 1.3; }
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
  user-select: none; -webkit-user-select: none; -webkit-user-drag: none; -webkit-touch-callout: none; }
.vbar { position: absolute; left: 0; right: 0; display: flex; align-items: center; gap: 8px; pointer-events: none;
  padding-left: max(12px, env(safe-area-inset-left, 0px)); padding-right: max(12px, env(safe-area-inset-right, 0px)); }
.vbar > * { pointer-events: auto; }
.vbar.top { top: 0; padding-top: max(10px, env(safe-area-inset-top, 0px)); padding-bottom: 18px;
  background: linear-gradient(var(--scrim) 45%, transparent); }
.vbar.bottom { bottom: 0; justify-content: center; padding-top: 18px; padding-bottom: max(12px, env(safe-area-inset-bottom, 0px));
  background: linear-gradient(transparent, var(--scrim) 55%); }
.vtitle { flex: 1; min-width: 0; display: grid; gap: 2px; pointer-events: none; }
.vcap { margin: 0; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vhint { margin: 0; font-size: 12px; color: var(--scrim-muted); }
@media (pointer: coarse) { .vhint .fine { display: none; } }
@media (pointer: fine) { .vhint .touch { display: none; } }
.vbtn { flex: none; min-width: 44px; height: 44px; padding: 0 10px; border-radius: 22px; border: 1px solid var(--scrim-line);
  background: var(--scrim-btn); color: var(--scrim-ink); font: 400 15px/1 var(--body); display: inline-grid;
  place-items: center; cursor: pointer; }
.vbtn svg { width: 20px; height: 20px; }
.vbtn:disabled { opacity: 0.35; cursor: default; }
.vbtn:focus-visible { outline: 2px solid var(--scrim-ink); outline-offset: 2px; }
.vpct { min-width: 4.5em; text-align: center; font-family: var(--mono); font-size: 12px; color: var(--scrim-muted);
  font-variant-numeric: tabular-nums; }
"""


def _img(m: dict, alt: str, caption: str, lazy: bool) -> str:
    """The page image, linked to the image the viewer zooms into (``data-w``/``data-h``: the largest size it
    zooms to, ``data-bw``: the width that is 100 %, ``data-vector``: an SVG, drawn again at every zoom)."""
    load = ' loading="lazy" decoding="async"' if lazy else ""
    full, fs = m.get("full", m["img"]), m.get("full_size", m["size"])
    vec = ' data-vector="1"' if str(full).endswith(".svg") else ""
    return (f'<a class="shot" href="{E(full)}" target="_blank" rel="noopener" data-w="{fs[0]}" data-h="{fs[1]}" '
            f'data-bw="{m["size"][0]}"{vec} data-caption="{E(caption)}"><img src="{E(m["img"])}" alt="{E(alt)}" '
            f'width="{m["size"][0]}" height="{m["size"][1]}"{load}></a>')


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
    for reason, n in sorted((m.get("reasons") or {}).items(), key=lambda kv: (-kv[1], kv[0])):
        chips.append((f"{n:,} omitted: {REASONS.get(reason, reason.replace('_', ' '))}", "bad"))
    return _chips(chips)


def _settings_json(st: dict) -> str:
    """The settings as JSON, one line per short list or object."""
    def fmt(v, ind: int) -> str:
        one = json.dumps(v, ensure_ascii=False)
        if len(one) + ind <= 84 or not isinstance(v, (dict, list)) or not v:
            return one
        pad = " " * (ind + 2)
        if isinstance(v, list):
            return "[\n" + ",\n".join(pad + fmt(x, ind + 2) for x in v) + "\n" + " " * ind + "]"
        return ("{\n" + ",\n".join(f"{pad}{json.dumps(k)}: {fmt(x, ind + 2 + len(json.dumps(k)) + 2)}"
                                    for k, x in v.items()) + "\n" + " " * ind + "}")
    return fmt(st, 0)


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
# by several labelers). Without <dialog> support the links open the images. A zoom scales the image with
# a transform while it runs; once it settles, the scale becomes the image's layout size, so that the
# browser draws the vector image again at that size instead of magnifying a bitmap (up to MAXPX pixels).
VIEWER_JS = r"""(() => {
  const dlg = document.getElementById("viewer");
  if (!dlg || typeof dlg.showModal !== "function") return;
  const $ = (id) => document.getElementById(id);
  const stage = $("v-stage"), img = $("v-img"), cap = $("v-cap"), pct = $("v-pct");
  const prev = $("v-prev"), next = $("v-next");
  const shots = Array.from(document.querySelectorAll("a.shot"));
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  const ptrs = new Map();
  const MAXPX = 40e6;
  let cur = -1, natW = 1, natH = 1, baseW = 1, vector = false, fw = 1, fh = 1, s = 1, cs = 1, X = 0, Y = 0;
  let nudge = 0, g = null, tap = null, timer = 0;

  const rect = () => stage.getBoundingClientRect();
  const at = (e) => { const r = rect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  // vector images: up to their zoom size (data-w); raster images: up to 4 screen px per image px
  const maxScale = () => Math.max(4, ((vector ? 1 : 4) * natW) / fw);

  function fit() {
    const r = rect();
    const k = Math.min(r.width / natW, r.height / natH);
    fw = natW * k;
    fh = natH * k;
  }
  function commit() {
    timer = 0;
    const target = Math.min(s, Math.max(1, Math.sqrt(MAXPX / (fw * fh))));
    if (!vector || Math.abs(target - cs) < 1e-3) return;
    cs = target;
    apply(false);
  }
  function apply(animate) {
    const r = rect();
    s = Math.min(Math.max(s, 1), maxScale());
    const w = fw * s, h = fh * s;
    X = w <= r.width ? (r.width - w) / 2 : Math.min(0, Math.max(r.width - w, X));
    Y = h <= r.height ? (r.height - h) / 2 : Math.min(0, Math.max(r.height - h, Y));
    img.style.transition = animate && !still.matches ? "transform 0.2s ease-out" : "none";
    img.style.width = fw * cs + "px";
    img.style.height = fh * cs + "px";
    img.style.transform = "translate(" + (X + nudge) + "px, " + Y + "px) scale(" + s / cs + ")";
    pct.textContent = Math.round((100 * w) / baseW) + " %";
    stage.classList.toggle("zoomed", s > 1.001);
    if (vector && Math.abs(s - cs) > 1e-3) {
      clearTimeout(timer);
      timer = setTimeout(commit, animate ? 260 : 180);
    }
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
    baseW = Number(a.dataset.bw) || w;
    vector = a.dataset.vector === "1";
    cs = 1;
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
    cls = "fig" + (" wide" if fig.wide else "") + (" limit" if fig.limit else "")
    kind = "SVG" if m["img"].endswith(".svg") else "image"
    st = (f'<details class="set"><summary>Settings of this problem</summary><pre>{E(_settings_json(m["settings"]))}'
          "</pre></details>") if m.get("settings") else ""
    return f"""<figure class="{cls}" id="{E(fig.key.replace('/', '--'))}">
  {_img(m, title, f"{title} · {scenario} · {config}", lazy)}
  <figcaption>
    <div class="srcrow"><span class="src">{E(scenario)} · {E(config)}</span>
      <a href="{E(m['img'])}" download>{kind}</a></div>
    <h3>{E(title)}</h3>
    <p>{fig.text.format(**m)}</p>
    {_fig_chips(m)}
    {st}
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
    moving = not st.get("zoom_steps") and not st.get("pan_steps")
    kind = "Force layout" if moving else "Zoom sequence"
    cells = []
    for f in st["frames"]:
        label = f"Frame {f['frame']} of {n}"
        cells.append(f'<div class="cell"><div class="cellhead">{label}</div>'
                     f'{_img(f, kind + ", " + label.lower(), label, True)}</div>')
    cells = "".join(cells)
    chips = []
    if st.get("displacement_mean_px") is not None:
        chips.append((f"labels move {st['displacement_mean_px']:.1f} px per frame on average", ""))
    if st["displacement_median_px"] is not None:
        chips.append((f"median movement {st['displacement_median_px']:.0f} px", ""))
    if st["nesting"] is not None and not moving:
        chips.append((f"{st['nesting'] * 100:.0f} % of labels stay when zooming in", ""))
    for key, step in (("flips_pan", "pan"), ("flips_zoom", "zoom"), ("flips_tick", "layout"),
                      ("flips_drag", "drag")):
        if st.get(key) is not None:
            chips.append((f"{st[key] * 100:.0f} % change side per {step} step", "bad" if st[key] > 0.1 else ""))
    flips = ""
    if st["flips_zoom"] is not None and st["flips_zoom"] > 0.1:
        flips = (f" Zooming in still makes {st['flips_zoom'] * 100:.0f} % of the labels change sides at each step, "
                 "which a reader notices.")
    if moving:
        title = "A force layout running: the labels follow their nodes"
        text = (f"{n} frames of the Les Misérables graph while its d3-force layout runs, every 4th tick from the "
                "start (the moving nodes of the tutorial's demo). Each frame is solved with the previous result as a "
                "warm start: a label moves with its node and takes a new place only when its old one is taken.")
    else:
        title = "Zooming into a map of airports, then panning"
        text = (f"{n} frames of an interactive map: {st['zoom_steps']} zoom steps, then {st['pan_steps']} pan "
                "steps. Each frame is solved with the previous result as a warm start, so most labels keep their "
                f"place.{flips}")
    return f"""<figure class="cmp">
  <figcaption class="pairhead"><span class="src">{E(st['scenario'])} · {E(st['sequence'])}</span>
  <h3>{E(title)}</h3>
  <p>{text}</p>{_chips(chips)}</figcaption>
  <div class="cmpgrid three">{cells}</div>
</figure>"""


def key_html() -> str:
    mark, lead, omit = render.MARK_STROKE, render.LEADER, render.UNPLACED
    return f"""<div class="key" aria-label="How to read the images">
  <span><svg width="44" height="18" viewBox="0 0 44 18" aria-hidden="true"><rect width="44" height="18" fill="{render.OBST}"/><rect x="3" y="2" width="38" height="14" fill="#fff" fill-opacity="{render.LABEL_FILL_OPACITY}"/><text x="22" y="13" font-size="10" text-anchor="middle" fill="{render.LABEL_TEXT}" font-family="Noto Sans, sans-serif">Label</text></svg>label box as reported by the engine</span>
  <span><svg width="56" height="18" viewBox="0 0 56 18" aria-hidden="true"><circle cx="6" cy="12" r="4" fill="{render.MARK_FILL}" stroke="{mark}"/><circle cx="17" cy="12" r="4" fill="#e15759" fill-opacity="0.75" stroke="{render._darker('#e15759')}"/><polyline points="21,10 40,4 54,4" fill="none" stroke="{lead}" stroke-width="1.5"/></svg>item mark (in the data's color where the chart has one) and leader</span>
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
                                 ("07-node-link/flare-imports", "Flare")) if n(k)]
    if crowd:
        notes.append(("Crowds keep few labels",
                      "Where marks overlap, a label that would need a leader across other marks or close to "
                      f"another leader is left out rather than drawn ambiguously ({', '.join(ref(k, t) for k, t in crowd)} "
                      "placed). Omitted items are reported with the reason; showing more of them takes a larger "
                      "canvas, smaller text or fewer items."))
    ends = [(k, t) for k, t in (("09-line-end-labels/unemployment-14-vector", "unemployment"),) if n(k)]
    margin = [(k, t) for k, t in (("09-line-end-labels/life-62-boundary", "life expectancy"),) if n(k)]
    if ends or margin:
        text = ("Where line ends crowd, their labels stand in a column beside them with fanning leaders"
                + (f" ({', '.join(ref(k, t) for k, t in ends)} placed)" if ends else "") + ". A column grows "
                "only as far as its leaders stay within <code>leaders.max_length</code> (10 em) and clear of "
                "the other marks; ends beyond that stay without a label. With the <code>boundary</code> model "
                "the column stands in the margin, where leaders may be longer"
                + (f" ({', '.join(ref(k, t) for k, t in margin)} placed)" if margin else "") + ".")
        notes.append(("Crowded line ends", text))
    split = [(k, m["split_words"]) for k, m in figs.items() if m.get("split_words")]
    if split:
        k, ex = split[0]
        notes.append(("Wrapped names can break inside a word",
                      f"A label with wrap settings takes balanced line breaks within <code>wrap.max_width</code>, "
                      f"at break opportunities; a word wider than <code>wrap.max_width</code> still has to end "
                      f"a line inside it (an emergency break, spec §5.3): "
                      f"<a href=\"#{k.replace('/', '--')}\">“{E(ex[0])}”</a>"
                      + (f" and {len(ex) - 1} more" if len(ex) > 1 else "") + ". A larger "
                      "<code>wrap.max_width</code> or a shorter text avoids it."))
    shrunk = [(k, t) for k, t in (("02-volcano/top50-svg", "volcano"), ("09-line-end-labels/life-62-boundary",
                                                                         "life expectancy"),
                                  ("07-node-link/flare-imports", "Flare")) if n(k)]
    if shrunk:
        notes.append(("Shrunk labels look less important",
                      "Before a label is left out, the degradation ladder tries it a step (<code>shrink:0.85</code>) "
                      "or more smaller, down to 70 % (" + ", ".join(f'<a href="#{k.replace("/", "--")}">{E(t)}</a>'
                                                               for k, t in shrunk)
                      + "). Where type size also shows importance (<code>priority.font_classes</code>), a shrunk "
                      "label reads as a less important one. Leave <code>shrink</code> out of <code>degrade</code> "
                      "when sizes must stay true; more labels are then omitted."))
    return "".join(f'<div class="note"><h3>{E(h)}</h3><p>{p}</p></div>' for h, p in notes)


def page(meta: dict, figs: dict[str, dict], sections=SECTIONS, cmps=(), stab=None, notes: str = "") -> str:
    """The page. The section ``weak`` ("Where it falls short") comes last, after the run's comparisons and
    frames, with ``notes`` below its figures."""
    body, toc, first, weak = [], [], True, None
    for sec in sections:
        items = []
        for f in sec.figs:
            if f.key in figs:
                items.append(figure_html(f, figs[f.key], lazy=not first))
                first = False
        if sec.id == "weak":
            weak = (sec, items)
            continue
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
                    "label placers on the same problems: ggrepel (R), adjustText and textalloc (Python), vega-label, the "
                    "label layouts of ECharts and d3fc and D3-Labeler (JavaScript), and a plain greedy baseline. Label Anything's cell has the blue frame.</p>"
                    + "".join(comparison_html(c) for c in cmps) + "</section>")
    stabs = [stab] if isinstance(stab, dict) else list(stab or [])
    if stabs:
        toc.append(("stability", "Interactive use"))
        body.append('<section id="stability"><h2>Interactive use</h2>'
                    + "".join(stability_html(st) for st in stabs) + "</section>")
    items = weak[1] if weak else []
    if notes or items:
        lede = weak[0].lede if weak and weak[0].lede else "What the current defaults and models still do badly."
        grid = '<div class="grid">' + "\n".join(items) + "</div>" if items else ""
        toc.append(("weak", "Limits"))
        body.append(f'<section id="weak"><h2>Where it falls short</h2><p class="lede">{lede}</p>{grid}'
                    + (f'<div class="notes">{notes}</div>' if notes else "") + "</section>")
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
  independently of the engine.{report} Every image is a vector graphic: select one to inspect it, and zoom as far
  as you like (pinch or double-tap on a phone, scroll or double-click with a mouse); “Settings of this problem”
  under it lists what the problem configures.</p>
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
    if (out / "img").is_dir():
        shutil.rmtree(out / "img")  # images of an earlier build
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
    stab = []
    if report is not None:
        stab = [st for st in (stability(run, report, out, problems, q) for q in SEQUENCES) if st]
        if not stab:
            stab = [st for st in (stability(run, report, out, problems),) if st]
    for name in ("NotoSans-Regular.ttf", "OFL.txt"):
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
