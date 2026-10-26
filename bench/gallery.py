"""Gallery: the figures of the benchmark report, benchmark problems solved by Label Anything, and the run's
problems drawn as vector images by every solver.

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
directory of a ``bench/run.py`` run that rendered its results, every problem of the run is drawn the
same way for every solver that ran it (the report shows them side by side), with frames of its
stability sequences.

Output (default ``<run>/gallery``, else ``bench-report/gallery``): ``gallery.json`` (the sections, the
captions and numbers of the figures, the drawings of the run's problems, the frames, the notes on known
limitations) and ``img/*.svg``. Written into a run directory, the gallery rebuilds that
run's report (``index.html``), whose chapters show it; ``gallery/index.html`` leads there. CI's
``baselines`` job does that, so the Pages workflow publishes it with the report at
``<site>/benchmark-report/``.
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
Solve = Callable[[Path, Path], dict]


@dataclass(frozen=True)
class Fig:
    """A benchmark problem (``scenario/config``) and its caption. ``text`` is HTML; it may use the
    figure's numbers (``{placed}``, ``{total}``, ``{leaders}``, ``{omitted}``, ``{fans}``,
    ``{tier_placed}``, ``{tier_total}``, ``{omitted_ids}``, ``{top_omitted}``, ``{top_placed}``, ``{first_cut}``,
    ``{first_cut_rank}``, …; see ``solve_figure``) as in str.format. ``limit``: the figure shows a
    shortcoming (drawn with the notes of the "Limitations" section)."""
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
    Section("maps", "Maps", "airports and points of interest",
            "On airport maps, the busiest airports must be labeled next to their marks; smaller airports are "
            "labeled only where space remains. The maps below distinguish three classes. The busiest airports "
            "form a priority tier, placed first and set in larger type (<code>priority.tiers</code>, "
            "<code>priority.font_classes</code>). Further airports are labeled where space remains; hub labels may "
            "cover their marks (<code>avoid.label.lower_items</code>), in which case they remain unlabeled. All "
            "other airports are unlabeled points that labels may cover at a small cost "
            "(<code>avoid.label.points: 0.3</code>). Methods differ most in dense regions such as London, the "
            "Rhine area, northern Italy, the US East Coast and eastern China.", (
                Fig("05-airports/europe-hubs-svg", "Europe's busiest airports",
                    "Europe at 30 px per degree. Labeled: {tier_placed} of the {tier_total} busiest airports, in "
                    "larger type, and {rest_placed} of the next {rest_total}; the remaining {context:,} airports are "
                    "unlabeled points. In the densest area (London, Paris, Brussels, Amsterdam, Düsseldorf, "
                    "Cologne), labels remain adjacent to their marks. Names of cities with several airports include "
                    "the airport code.", wide=True),
                Fig("05-airports/world-hubs-100-svg", "The world's 100 busiest airports",
                    "World map at 6 px per degree with IATA codes at 8 px; the 30 busiest airports one size larger. "
                    "The remaining {context:,} airports with scheduled service are unlabeled points. Labeled: "
                    "{tier_placed} of {tier_total} hubs and {rest_placed} of the next {rest_total}; omitted: "
                    "{omitted_ids}. In western Europe, eight hubs lie within an area smaller than two labels; the "
                    "vector image can be enlarged without loss.", wide=True),
                Fig("05-airports/world-iata-1000-lower-vector", "All 1,000 airports as items, hubs first",
                    "The 1,000 busiest airports, all as items (cf. the figure under Limitations). Labels may cover "
                    "the marks of less important airports (<code>avoid.label.lower_items: 10</code>); such airports "
                    "remain unlabeled, so no label covers the mark of another labeled item. Labeled: {top_placed} "
                    "of the 10 busiest airports (omitted: {top_omitted}) and {placed:,} of {total:,} in total.",
                    wide=True),
                Fig("06-city-pois/monaco-pins-ink", "375 points of interest in Monaco",
                    "Icon-and-name labels over an OpenStreetMap raster; main sights one size larger. The engine "
                    "detects streets and buildings in the raster (ink mode) and keeps labels off the busiest areas. "
                    "Where pins overlap, {omitted} labels are omitted."),
                Fig("06-city-pois/monaco-ink", "Monaco with dot marks",
                    "Composite labels (icon and name) over the same raster, with dots instead of pins."),
            )),
    Section("charts", "Charts", "scatterplots, bubble charts, line charts", "", (
        Fig("03-gapminder/y2005-svg", "Gapminder 2005",
            "Life expectancy versus fertility for 62 countries; bubble area encodes population, colour encodes "
            "region (legend). Labeled: the 40 most populous countries and the 6 countries farthest from the trend; "
            "the most populous in larger type, large bubbles internally. {omitted} labels in the dense region of "
            "high-income countries are omitted. The year watermark is a soft obstacle, the legend a hard one."),
        Fig("02-volcano/top50-svg", "Volcano plot: the 50 most significant genes",
            "16,406 genes from a differential expression table. Red and blue mark genes beyond both dashed "
            "thresholds (p &lt; 0.05 and a fold change of at least 2). The 50 most significant genes are labeled in "
            "these colours; grey labeled genes are significant with a fold change below 2. The top three are set "
            "larger."),
        Fig("09-line-end-labels/unemployment-14-vector", "Unemployment by industry",
            "End labels for 14 series in the colour of their line; only positions to the right of the line ends "
            "are permitted. Where ends are dense, labels are stacked in a column in the order of the ends, with "
            "fanned leaders ({fans} labels)."),
        Fig("09-line-end-labels/life-62-boundary", "Life expectancy of 62 countries",
            "Colour by region, as in the bubble chart. Labels form a single column in the right margin (models "
            "<code>adjacent</code> and <code>boundary</code>), stacked near the heights of the line ends; leaders "
            "are assigned to slots without crossings. The densest band (75–80 years) does not fit: {omitted} line "
            "ends remain unlabeled ({placed:,} of {total:,} placed)."),
        Fig("01-software-metrics/cbo-rfc-100-svg", "React Native: the 100 most atypical Java classes",
            "Coupling versus response for 1,206 classes (log scales). The 100 classes farthest from their five "
            "nearest neighbours are labeled with their names relative to <code>com.facebook.react</code>, wrapped "
            "at package separators; the five most atypical in larger type, the others smaller. The plot is an SVG "
            "whose points, axes and tick labels the engine treats as obstacles. {omitted} labels in the upper right "
            "are omitted for lack of space."),
        Fig("01-software-metrics/wmc-loc-30-raster", "Scatterplot as a raster image",
            "The entire scatterplot is a PNG. The engine detects axes, points and text in the pixels (raster ink "
            "mode) and places the 30 labels clear of them."),
    )),
    Section("images", "Photographs and illustrations", "area anchors, leaders, margin labels", "", (
        Fig("08-illustration/astronaut-boundary", "Annotated portrait",
            "Twelve regions of a NASA portrait as area anchors (one is a ring with a hole). The preset "
            "<code>illustration</code> assigns label area over the photograph a cost per em² comparable to that of "
            "a leader, so most labels are placed in the margins or beside the photograph; labels of central regions "
            "remain close to them. Elbow leaders end inside each region."),
        Fig("08-illustration/retina-boundary", "Fundus photograph",
            "Ten anatomical structures in a retinal image (raster at scale 2), with elbow leaders. Labels are placed "
            "in the margins where a leader costs less than covering the image, otherwise close to their "
            "structures."),
        Fig("08-illustration/rocket-distant", "Falcon 9 on the launch pad",
            "Twelve parts labeled with straight leaders to positions off the rocket; duplicate label texts are "
            "permitted."),
    )),
    Section("graphs", "Embeddings and networks", "", "", (
        Fig("07-node-link/lesmis-force", "Les Misérables, force layout at rest",
            "77 characters in the d3-force layout of the moving-node sequences, at rest. Circle size encodes the "
            "number of co-occurring characters, colour the community, edge width the number of co-occurrences. "
            "Labeled: {placed} of {total} characters, the most connected in larger type; edges are soft "
            "obstacles."),
        Fig("04-embedding/k40-ink", "40 cluster names over 50,000 points",
            "Long topic names are wrapped; the point cloud is a raster that the engine reads in ink mode."),
        Fig("07-node-link/flare-imports", "Flare: classes and imports",
            "220 classes of the Flare visualization toolkit in a force layout, coloured by top-level package. The "
            "100 most connected classes are labeled; the other 120 nodes must not be covered. In the dense core of "
            "<code>flare.vis</code> and <code>flare.util</code>, {omitted} labels are omitted and some are reduced "
            "in size.", wide=True),
        Fig("04-embedding/k120-areas", "120 topics of WordNet",
            "50,000 noun glosses embedded with t-SNE; 120 clusters as area anchors (hulls of their cores), labeled "
            "inside or adjacent, over a raster of the points.", wide=True),
    )),
    Section("priority", "Priority and omission", "",
            "Europe's 250 busiest airports compete for space at 9 px; all other airports are unlabeled points. "
            "Priority is the number of routes. Under <code>strict</code> omission, a label is omitted only if more "
            "important labels leave no space for it, so smaller airports fill the remaining gaps. Under "
            "<code>prefix</code> omission, the placed labels are exactly the top of the ranking: all items after "
            "the first one that does not fit are omitted.", (
                Fig("12-priority/europe-attr-strict", "Strict omission: {placed} labels",
                    "Every omitted airport is blocked by a more important label.", wide=True),
                Fig("12-priority/europe-attr-prefix", "Prefix omission: the {placed} busiest airports",
                    "{first_cut} (rank {first_cut_rank}) has no free position, so no lower-ranked airport is "
                    "labeled. Hence every airport busier than a labeled one is itself labeled.", wide=True),
            )),
    Section("weak", "Limitations", "", "Known weaknesses of the current defaults and models.", (
        Fig("05-airports/world-iata-1000-vector", "All 1,000 airports as items: hubs may remain unlabeled",
            "The 1,000 busiest airports, all as items. Labels may cover the marks of less important airports "
            "(preset <code>map</code>) but never those of more important ones; the busiest 5 % are set in larger "
            "type. In dense hub regions, the label of one hub may cover the mark of the next, which then remains "
            "unlabeled. Unlabeled among the 10 busiest airports: {top_omitted}; in total, {placed:,} of {total:,} "
            "airports are labeled. Moving the busier label would displace two other labels here; the priority "
            "repair does so only if at most one label is displaced (ADR priority/repair). A uniform type size "
            "(<code>priority.font_classes</code>) or fewer items would free space.", wide=True, limit=True),
    )),
)

# (scenario, config, caption) of the problems the report shows with a caption next to the other methods
COMPARISONS = (
    ("03-gapminder", "y2005-vector",
     "Identical bubbles and obstacles for all methods. Hard violations count labels that overlap other labels, "
     "bubbles or axes. adjustText never omits labels and therefore produces overlaps; ggrepel's repulsion does not "
     "resolve all overlaps."),
    ("02-volcano", "top20-vector",
     "A sparse problem: most methods place all or nearly all labels; they differ mainly in overlaps."),
)
NAMES = {"rust": "Label Anything", "ggrepel": "ggrepel (R)", "adjusttext": "adjustText", "textalloc": "textalloc",
         "vega-label": "vega-label", "echarts": "ECharts (hideOverlap)", "d3fc": "d3fc label layout",
         "d3-labeler": "D3-Labeler", "mumtaz2019": "Mumtaz et al. (2019)", "greedy": "Greedy baseline",
         "naive": "Naive (no collision test)"}
REASONS = {"omitted_by_priority": "blocked by more important labels", "no_feasible_candidate": "no free position",
           "budget_exhausted": "time budget exhausted", "keep_with": "with linked items",
           "grouped": "merged into a group label"}


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


def write_svg(problem: dict, result: dict, files: dict, out: Path, rel: str, title: str | None = None,
              marks: dict | None = None) -> dict:
    """The figure as one self-contained SVG at ``out / rel``, with the violations of ``marks`` drawn over it; the
    page shows it at the canvas size, the viewer zooms into it (``full`` is the same file, ``full_size`` the
    largest size the viewer zooms to)."""
    svg = render.standalone_svg(problem, result, files.get("background_svg"), files.get("background"), title=title,
                                marks=marks)
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
    ev = evaluate(problem, result, truth, removal_test=False, marks=True)
    s, clarity, points = ev["summary"], ev["association"]["clarity"], ev["association"]["points"]
    images = write_svg(problem, result, files, out, f"img/{name}.svg", fig.title.split(":")[0], ev["marks"])
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
            "misattributed": clarity["misattributed"], "unclear": clarity["unclear"] + clarity["leadered_unclear"],
            "points_covered": points["covered"], "labels_close": ev["association"]["spacing"]["labels_close"],
            "leader_near_crossings": s.get("leader_near_crossings"),
            "leader_mark_touches": s.get("leader_mark_touches"),
            "runtime_ms": (result.get("stats") or {}).get("runtime_ms")}


# ---------------------------------------------------------------------------
# the run's baselines and stability frames
# ---------------------------------------------------------------------------
def comparisons(run: Path, report: dict, out: Path, problems: Path = paths.PROBLEMS) -> list[dict]:
    """Every problem of the run drawn for every solver that rendered it, like the figures (the run's own raster
    rendering when its result or problem file is gone); the captions of COMPARISONS where they apply. The report
    shows them side by side."""
    rows = {(r["solver"], r["scenario"], r["config"]): r for r in report.get("results", [])}
    texts = {(sc, cfg): text for sc, cfg, text in COMPARISONS}
    keys = sorted({(r["scenario"], r["config"]) for r in report.get("results", [])})
    figs = []
    for scenario, config in keys:
        cells = []
        for s in report.get("solvers", []):
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
                    problem, result = read_json(prob), read_json(res)
                    truth = read_json(files["truth"]) if files.get("truth") else None
                    marks = evaluate(problem, result, truth, removal_test=False, marks=True)["marks"]
                    cell.update(write_svg(problem, result, files, out, rel + ".svg",
                                          f"{scenario} · {config} · {NAMES.get(s, s)}", marks))
                else:
                    with Image.open(src) as im:
                        size = save_webp(im, out / (rel + ".webp"))
                    cell.update(img=rel + ".webp", size=size, full=rel + ".webp", full_size=size)
                sm = r["summary"]
                cell.update(placed=sm["placed"], total=sm["total"], hard_violations=sm.get("hard_violations") or 0)
            else:
                cell["why"] = r.get("skipped") or r.get("error") or "no rendering"
            cells.append(cell)
        if any("img" in c for c in cells):
            figs.append({"scenario": scenario, "config": config, "text": texts.get((scenario, config), ""),
                         "cells": cells})
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
            problem, result = read_json(prob), read_json(res)
            marks = evaluate(problem, result, removal_test=False, marks=True)["marks"]
            m = write_svg(problem, result, {}, out, dst + ".svg", f"Frame {k + 1}", marks)
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
# captions, chips and notes: the report (bench/report_html.py) draws them
# ---------------------------------------------------------------------------
def fig_chips(m: dict) -> list[list[str]]:
    """The numbers under a figure: [text, kind], kind "" (neutral), "ok", "warn" or "bad"."""
    chips = [[f"{m['placed']:,} of {m['total']:,} placed", ""]]
    if m["leaders"]:
        chips.append([f"{m['leaders']:,} leader{'s' if m['leaders'] != 1 else ''}", ""])
        if m.get("leader_len_max_em") is not None:
            chips.append([f"longest leader {m['leader_len_max_em']:.1f} em", ""])
    hv = m["hard_violations"]
    chips.append(["no hard violations", "ok"] if hv == 0 else [f"{hv:,} hard violations", "bad"])
    for key, one, many in (("unclear", "unclear label", "unclear labels"),
                           ("points_covered", "point covered", "points covered"),
                           ("labels_close", "label too close", "labels too close")):
        if m.get(key):
            chips.append([f"{m[key]:,} {one if m[key] == 1 else many}", "warn"])
    if m.get("runtime_ms") is not None:
        chips.append([f"{m['runtime_ms']:,.0f} ms", ""])
    for reason, n in sorted((m.get("reasons") or {}).items(), key=lambda kv: (-kv[1], kv[0])):
        chips.append([f"{n:,} omitted: {REASONS.get(reason, reason.replace('_', ' '))}", "bad"])
    return chips


def settings_json(st: dict) -> str:
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


def stability_text(st: dict) -> dict:
    """Title, caption (HTML) and chips of a stability sequence's frames."""
    n = st["n_frames"] or len(st["frames"])
    moving = not st.get("zoom_steps") and not st.get("pan_steps")
    chips = []
    if st.get("displacement_mean_px") is not None:
        chips.append([f"mean displacement {st['displacement_mean_px']:.1f} px per frame", ""])
    if st["displacement_median_px"] is not None:
        chips.append([f"median displacement {st['displacement_median_px']:.0f} px", ""])
    if st["nesting"] is not None and not moving:
        chips.append([f"{st['nesting'] * 100:.0f}% of labels retained per zoom-in step", ""])
    for key, step in (("flips_pan", "pan"), ("flips_zoom", "zoom"), ("flips_tick", "layout"),
                      ("flips_drag", "drag")):
        if st.get(key) is not None:
            chips.append([f"side changes per {step} step: {st[key] * 100:.0f}%", "bad" if st[key] > 0.1 else ""])
    flips = ""
    if st["flips_zoom"] is not None and st["flips_zoom"] > 0.1:
        flips = f" At each zoom step, {st['flips_zoom'] * 100:.0f}% of the labels still change sides."
    if moving:
        title = "Force layout in motion"
        text = (f"{n} frames of the Les Misérables graph during its d3-force simulation (every fourth tick from the "
                "start, as in the tutorial's moving-node demo). Each frame is solved with the previous result as "
                "warm start: labels move with their nodes and change position only when the previous position is "
                "occupied.")
    else:
        title = "Zooming and panning an airport map"
        text = (f"{n} frames of an interactive map: {st['zoom_steps']} zoom steps followed by {st['pan_steps']} pan "
                "steps. Each frame is solved with the previous result as warm start, so most labels keep their "
                f"position.{flips}")
    return {"title": title, "text": text, "chips": chips, "kind": "Force layout" if moving else "Zoom sequence"}


def notes(figs: dict[str, dict]) -> list[dict]:
    """Known limitations of the defaults, with the numbers of this build: [{"title", "html"}], linking to the
    figures (``#scenario--config``)."""
    def n(key: str) -> dict | None:
        return figs.get(key)

    def ref(key: str, name: str) -> str:
        m = n(key)
        return f'<a href="#{key.replace("/", "--")}">{E(name)}</a> {m["placed"]:,} of {m["total"]:,}'

    out = []
    crowd = [(k, t) for k, t in (("06-city-pois/monaco-pins-ink", "Monaco"),
                                 ("07-node-link/flare-imports", "Flare")) if n(k)]
    if crowd:
        out.append(("Dense clusters",
                    "Where marks overlap, labels that would require a leader across other marks or near another "
                    "leader are omitted rather than placed ambiguously (placed: "
                    f"{', '.join(ref(k, t) for k, t in crowd)}). Omitted items are reported with a reason. Placing "
                    "more of them requires a larger canvas, smaller text or fewer items."))
    ends = [(k, t) for k, t in (("09-line-end-labels/unemployment-14-vector", "unemployment"),) if n(k)]
    margin = [(k, t) for k, t in (("09-line-end-labels/life-62-boundary", "life expectancy"),) if n(k)]
    if ends or margin:
        text = ("Labels of dense line ends are stacked in a column beside them, with fanned leaders"
                + (f" (placed: {', '.join(ref(k, t) for k, t in ends)})" if ends else "") + ". A column extends "
                "only as far as its leaders stay within <code>leaders.max_length</code> (10 em) and clear of other "
                "marks; further ends remain unlabeled. With the <code>boundary</code> model, the column is placed in "
                "the margin, where longer leaders are permitted"
                + (f" (placed: {', '.join(ref(k, t) for k, t in margin)})" if margin else "") + ".")
        out.append(("Dense line ends", text))
    split = [(k, m["split_words"]) for k, m in figs.items() if m.get("split_words")]
    if split:
        k, ex = split[0]
        out.append(("Line breaks inside words",
                    "Labels with wrap settings receive balanced line breaks within <code>wrap.max_width</code> at "
                    "break opportunities. A word wider than <code>wrap.max_width</code> must be broken inside "
                    f"(emergency break, spec §5.3): <a href=\"#{k.replace('/', '--')}\">“{E(ex[0])}”</a>"
                    + (f" and {len(ex) - 1} more" if len(ex) > 1 else "") + ". A larger "
                    "<code>wrap.max_width</code> or a shorter text avoids this."))
    shrunk = [(k, t) for k, t in (("02-volcano/top50-svg", "volcano"), ("09-line-end-labels/life-62-boundary",
                                                                         "life expectancy"),
                                  ("07-node-link/flare-imports", "Flare")) if n(k)]
    if shrunk:
        out.append(("Reduced labels appear less important",
                    "Before a label is omitted, the degradation ladder reduces its size by one step "
                    "(<code>shrink:0.85</code>) or more, down to 70 % ("
                    + ", ".join(f'<a href="#{k.replace("/", "--")}">{E(t)}</a>' for k, t in shrunk)
                    + "). Where type size also encodes importance (<code>priority.font_classes</code>), a reduced "
                    "label appears less important. Removing <code>shrink</code> from <code>degrade</code> preserves "
                    "sizes at the cost of more omitted labels."))
    return [{"title": t, "html": h} for t, h in out]


REDIRECT = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Label Anything benchmark report</title>
<meta http-equiv="refresh" content="0; url=../#maps">
<link rel="canonical" href="../">
</head>
<body>
<p>The gallery is now part of the <a href="../#maps">benchmark report</a>.</p>
</body>
</html>
"""
"""``gallery/index.html``: the gallery's address of earlier versions leads to the report."""


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
    """Solve and draw the figures into ``out`` (``gallery.json``, ``img/``), with ``run`` also the run's problems by
    every solver and its stability frames; then rebuild the report of the run directory ``out`` lies in, which shows
    them (``index.html`` here leads there). 1 if a figure failed (it is left out), else 0."""
    out.mkdir(parents=True, exist_ok=True)
    for old in ("img", "fonts"):
        if (out / old).is_dir():
            shutil.rmtree(out / old)  # images of an earlier build, fonts of the earlier gallery page
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
    for m in figs.values():
        m["chips"] = fig_chips(m)
        m["settings_json"] = settings_json(m["settings"])
    secs = [{"id": sec.id, "title": sec.title, "sub": sec.sub, "lede": sec.lede,
             "figures": [{"key": f.key, "title": f.title.format(**figs[f.key]), "text": f.text.format(**figs[f.key]),
                          "wide": f.wide, "limit": f.limit} for f in sec.figs if f.key in figs]}
            for sec in sections]
    cmps = comparisons(run, report, out, problems) if report is not None else []
    stab = []
    if report is not None:
        stab = [st for st in (stability(run, report, out, problems, q) for q in SEQUENCES) if st]
        if not stab:
            stab = [st for st in (stability(run, report, out, problems),) if st]
    for st in stab:
        st.update(stability_text(st))
    meta = {"commit": commit(), "date": time.strftime("%Y-%m-%d"),
            "machine": machine_text((report or {}).get("machine") if report else None) or machine_text(_machine())}
    write_json(out / "gallery.json", {"meta": meta, "sections": secs, "figures": figs, "comparisons": cmps,
                                      "stability": stab, "notes": notes(figs)}, nd=3, indent=1)
    host = out.resolve().parent
    if (host / "results.json").exists():
        from bench import report as rep

        data = report if run is not None and host == run.resolve() and report is not None else \
            read_json(host / "results.json")
        (out / "index.html").write_text(REDIRECT, encoding="utf-8")
        page = rep.write_html(host, data, data.get("plots"))
        log(f"wrote {out / 'gallery.json'} and the report {page}: {len(figs)} figures, {len(cmps)} problems by "
            f"every solver" + (", stability frames" if stab else ""))
    else:
        log(f"wrote {out / 'gallery.json'}: {len(figs)} figures; the report of a run shows them "
            "(--run DIR, written into DIR/gallery)")
    return 1 if failed or not figs else 0


def _machine() -> dict:
    from bench.perf.runner import machine

    return machine()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m bench.gallery", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--engine", required=True, help="the label-anything CLI binary (or a command) that solves the figures")
    ap.add_argument("--run", help="output directory of a bench/run.py run with renderings (results.json): adds "
                                  "its problems drawn for every solver and its stability frames")
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
