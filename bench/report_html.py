"""The benchmark report page, ``bench-report/index.html``: one interactive page for readers.

It shows a run (``results.json``) and, once ``python -m bench.gallery`` has added it, the gallery
(``gallery/gallery.json``: figures of Label Anything with captions, the run's problems drawn as vector images
by every solver, frames of the stability sequences, what the defaults still do badly).

* **Header**: what was run, and Label Anything's headline numbers next to the range of the others.
* **A bar** that stays at the top: the contents, the labelers compared with Label Anything (three by
  default, the others on demand: ``?vs=a,b`` in the address, remembered in the browser) and whether the tables
  show every metric or the main ones.
* **At a glance**: where each labeler stands on six measures (a dot on a strip per measure, further right is
  better, the others as grey dots), then, folded, the summary table coloured against the median, how to read
  the images and what the measures mean.
* **Chapters by kind of data** (maps, charts, photos and illustrations, embeddings and networks, priority,
  scale): the gallery's figures, then every problem of the run with the labelers side by side and their
  numbers (each value coloured against the median of all solvers on that problem). Selecting an image opens a
  viewer that zooms and flips between the labelers at the same spot.
* **Interactive use** (stability sequences), **where it falls short** (the gallery's notes and the problems
  where another labeler does better without more violations), and, folded, the **engineering details**:
  performance targets, release gates, runtime against size, implementation parity, changes against the
  previous release, the baselines' methods.

The page loads nothing from other servers (Noto Sans is copied next to it); without JavaScript it shows the
default labelers and every metric.
"""
from __future__ import annotations

import functools
import math
import shutil
import statistics
from pathlib import Path

from . import render
from .common import paths
from .common.jsonio import read_json
from .common.model import load_problem
from .perf import implementation
from .report import (EPS, HEAT_CLASS, HEAT_TEXT, META, METRICS, SCALING_SCENARIO, SEQ_METRICS, TABLE_COLS, _compact,
                     _mean, _numbers, esc, fmt, heat_attrs, kind, others_better, runtime_panels, runtime_points,
                     runtime_svg, scaling_exponent)

ASSETS = Path(__file__).resolve().parent / "report_assets"
SITE = "https://fabian-beck.github.io/label-anything/"
REPO_URL = "https://github.com/fabian-beck/label-anything"

# ---------------------------------------------------------------------------
# labelers
# ---------------------------------------------------------------------------
NAMES = {"rust": "Label Anything", "ts": "Label Anything (TypeScript)", "wasm": "Label Anything (WebAssembly)",
         "ggrepel": "ggrepel", "adjusttext": "adjustText", "textalloc": "textalloc", "vega-label": "vega-label",
         "echarts": "ECharts", "d3fc": "d3fc", "d3-labeler": "D3-Labeler", "greedy": "greedy", "naive": "naive"}
ABOUT = {"ggrepel": "ggrepel for R (ggplot2): repulsion", "adjusttext": "adjustText for Python (matplotlib): "
         "repulsion, never omits a label", "textalloc": "textalloc for Python (matplotlib): candidate positions",
         "vega-label": "Vega's label transform (vega-label)", "echarts": "ECharts' label layout with hideOverlap",
         "d3fc": "d3fc label layout: greedy with overlap removal", "d3-labeler": "D3-Labeler: simulated annealing, "
         "never omits a label", "greedy": "the benchmark's greedy baseline: 8 positions, first free one wins",
         "naive": "the benchmark's naive baseline: every label top-right, no collision test"}
ORDER = ("ggrepel", "adjusttext", "textalloc", "vega-label", "echarts", "d3fc", "d3-labeler", "greedy", "naive")
DEFAULT_VS = ("ggrepel", "adjusttext", "textalloc")
"""Compared with Label Anything by default: the most used of the tools (R and Python); the others on demand."""


def name(s: str) -> str:
    if s in NAMES:
        return NAMES[s]
    return f"Label Anything ({s})" if implementation(s) else s


def reference(solvers: list[str]) -> str | None:
    """The Label Anything solver every comparison shows: the Rust engine where it ran, else the first
    implementation."""
    la = [s for s in solvers if implementation(s)]
    return next((s for s in la if implementation(s) == "rust"), la[0] if la else None)


def selectable(solvers: list[str], ref: str | None) -> list[str]:
    """The other solvers in the order of the bar: Label Anything's other implementations, the tools, the rest."""
    others = [s for s in solvers if s != ref]
    la = [s for s in others if implementation(s)]
    tools = sorted((s for s in others if s in ORDER), key=ORDER.index)
    return la + tools + [s for s in others if s not in la and s not in tools]


def default_shown(sel: list[str]) -> list[str]:
    d = [s for s in sel if s in DEFAULT_VS]
    return d or [s for s in sel if not implementation(s)][:3]


class Pick:
    """Which solvers a page element belongs to: ``attrs(s)`` marks it for the bar (``data-solver``) and hides
    those not shown by default."""

    def __init__(self, solvers: list[str]):
        self.ref = reference(solvers)
        self.sel = selectable(solvers, self.ref)
        self.on = set(default_shown(self.sel))
        self.order = ([self.ref] if self.ref else []) + self.sel

    def attrs(self, s: str) -> str:
        hidden = s != self.ref and s in self.sel and s not in self.on
        return f' data-solver="{esc(s)}"' + (" hidden" if hidden else "")

    def rank(self, s: str) -> int:
        return self.order.index(s) if s in self.order else len(self.order)


# ---------------------------------------------------------------------------
# small pieces
# ---------------------------------------------------------------------------
def dur(ms: float | None) -> str:
    """A duration for reading: 0.42 ms, 8.5 ms, 85 ms, 1.2 s, 2.5 min."""
    if ms is None:
        return "–"
    if ms < 1:
        return f"{ms:.2f} ms"
    if ms < 10:
        return f"{ms:.1f} ms"
    if ms < 1000:
        return f"{ms:.0f} ms"
    if ms < 60_000:
        return f"{ms / 1000:.1f} s"
    return f"{ms / 60_000:.1f} min"


def chips(items) -> str:
    """``[text, kind]`` pairs as chips; kind "", "ok", "warn" or "bad"."""
    return '<ul class="chips">' + "".join(f'<li class="{esc(k)}">{esc(t)}</li>' if k else f"<li>{esc(t)}</li>"
                                          for t, k in items) + "</ul>"


def _icon(d: str) -> str:
    return (f'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="{d}" fill="none" stroke="currentColor" '
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>')


def shot(m: dict, alt: str, caption: str, prefix: str = "", lazy: bool = True, crop: list | None = None,
         canvas: list | None = None) -> str:
    """The image, linked to the image the viewer zooms into. ``m``: ``img``, ``size`` (shown at), ``full`` and
    ``full_size`` (the largest size the viewer zooms to; an SVG is drawn again at every zoom), paths relative to
    ``prefix``. With ``crop`` ([x, y, w, h] of the ``canvas`` [width, height]) only that detail is shown, at the
    image's width, and the viewer opens on it."""
    full, fs, size = m.get("full", m["img"]), m.get("full_size") or m.get("size"), m.get("size")
    vec = ' data-vector="1"' if str(full).endswith(".svg") else ""
    dims = f' width="{size[0]}" height="{size[1]}"' if size else ""
    data = f' data-w="{fs[0]}" data-h="{fs[1]}" data-bw="{size[0]}"' if fs and size else ""
    load = ' loading="lazy" decoding="async"' if lazy else ""
    cls, style, istyle, badge = "shot", "", "", ""
    if crop and canvas and canvas[0] and canvas[1]:
        (x, y, w, h), (cw, ch) = crop, canvas
        cls += " crop"
        data += f' data-crop="{x / cw:.4f},{y / ch:.4f},{w / cw:.4f},{h / ch:.4f}"'
        style = f' style="aspect-ratio:{w:g}/{h:g}"'
        istyle = f' style="width:{cw / w * 100:.2f}%;left:{-x / w * 100:.2f}%;top:{-y / h * 100:.2f}%"'
        badge = "<span class='badge'>the densest part · select for all of it</span>"
    return (f'<a class="{cls}" href="{esc(prefix + full)}" target="_blank" rel="noopener"{data}{vec}{style} '
            f'data-caption="{esc(caption)}"><img src="{esc(prefix + m["img"])}" alt="{esc(alt)}"{dims}{load}'
            f'{istyle}>{badge}</a>')


def _image_size(path: Path) -> list[int] | None:
    try:
        from PIL import Image

        with Image.open(path) as im:
            return list(im.size)
    except (OSError, ValueError):
        return None


def _status_cell(passed: bool | None, text_ok="pass", text_bad="FAIL") -> str:
    if passed is None:
        return "<td class='l'>–</td>"
    return f"<td class='l good'>✓ {text_ok}</td>" if passed else f"<td class='l bad'>✗ {text_bad}</td>"


def _baseline_note(r: dict) -> str:
    b = r.get("baseline") or {}
    items = b.get("emulations", []) + [f"not supported: {u}" for u in b.get("unsupported", [])]
    if not items:
        return ""
    tip = "\n".join(items)
    return f"<span class='em' title='{esc(tip)}'>≈ {len(items)}</span>"


# ---------------------------------------------------------------------------
# what the measures mean
# ---------------------------------------------------------------------------
GLOSSARY = {
    "placed_rate": ("placed", "items with a label on the canvas, of all items."),
    "usable_rate": ("usable", "the labels a reader can use: the placed ones left after dropping every label in a "
                              "conflict, of two overlapping labels the more important one staying. A labeler that "
                              "never leaves a label out but overlaps instead keeps few."),
    "hard_violations": ("hard violations", "everything the problem forbids: labels over labels or over the marks "
                                           "and obstacles they must avoid, labels off the canvas, crossing leaders, "
                                           "leaders through labels or marks, and Label Anything's spacing rules "
                                           "for leaders."),
    "hard_conflicts": ("conflicts", "the hard violations every labeler must avoid: the overlaps and crossings, "
                                    "without Label Anything's spacing rules."),
    "clarity_unclear_rate": ("unclear", "labels without a leader whose own mark is not clearly the nearest data "
                                        "point: another point is less than 0.2 em farther away, or nearer; of the "
                                        "placed labels."),
    "ambiguity_rate": ("ambiguous", "placed labels nearer to another item than to their own (a coarser measure "
                                    "than unclear)."),
    "points_covered_rate": ("points covered", "data points, the marks and the unlabeled points of the chart, "
                                              "under the label of another item; of all data points."),
    "labels_close_rate": ("labels too close", "labels less than 0.4 em from the nearest other label, which read "
                                              "as one; of the placed labels."),
    "priority_inversions": ("inversions", "items left out although a position was free of every more important "
                                          "label: a less important label took their room."),
    "ndcg_at_k": ("NDCG@k", "how closely the placed labels follow the priority order: 1 when they are exactly the "
                            "most important ones."),
    "leader_crossings": ("crossings", "pairs of crossing leaders."),
    "leader_near_crossings": ("near crossings", "leaders closer than 4 px to another without crossing it: they "
                                                "read as crossing."),
    "leader_mark_touches": ("leader–mark", "leaders passing within 1.5 px of another item's mark."),
    "adjacent_gap_abs_mean": ("gap px", "how far a label beside its mark stands from the intended offset, mean in "
                                        "px; 0 is best."),
    "position_rank_mean": ("pos. rank", "mean preference rank of the side a label takes (0 top, 1 right, 2 "
                                        "bottom, 3 left, 4–7 the corners)."),
    "region_coverage": ("regions labeled", "populated regions (cells 8 em wide) with at least one label: whether "
                                           "the labels spread over the data."),
    "soft_coverage_mean": ("soft cov.", "mean share of a label's area over soft obstacles, such as lines it may "
                                        "cover at a cost."),
    "engine_ms": ("engine ms", "the labeler's own timing of the solve, median over the runs."),
    "wall_ms": ("wall ms", "a whole run as the benchmark sees it, process start and files included; median and "
                           "95th percentile."),
    "peak_mb": ("peak MB", "the peak memory of the solver's process."),
    "displacement_mean_px": ("displacement", "how far a label moves between frames, relative to its anchor."),
    "flip_rate": ("flip rate", "labels changing sides between frames."),
    "nesting_rate": ("nesting rate", "zoom-in steps after which every label still in view stays."),
    "nesting_fraction_mean": ("nesting fraction", "the share of the labels that stay when zooming in."),
}


def tip(key: str) -> str:
    g = GLOSSARY.get(key)
    return f' title="{esc(g[1])}"' if g else ""


def glossary_html() -> str:
    rows = "".join(f"<dt>{esc(t)}</dt><dd>{esc(d)}</dd>" for t, d in GLOSSARY.values())
    return (f"<dl class='gloss'>{rows}</dl><p class='small note'>Every measure counts what a reader sees, with the "
            "engine's defaults as thresholds for every labeler; precise definitions: "
            f"<a href='{REPO_URL}/blob/main/bench/README.md#evaluator-metrics'>bench/README.md</a>.</p>")


def heat_key(where: str, detail: bool = False) -> str:
    """The legend of the table colours: each value against the median of ``where``."""
    more = ("; counts, times and memory compare by ratio, small differences stay grey, uncoloured columns are not "
            "ranked" if detail else "")
    return (f"<div class='key heat'><span class='lead'><b>Colours</b>&nbsp;each value against the median of "
            f"{esc(where)}{more}:</span>"
            + "".join(f"<span><i class='sw {HEAT_CLASS[c]}'></i>{HEAT_TEXT[c]}</span>" for c in HEAT_CLASS)
            + "<span><b>bold</b>&nbsp;the best value</span></div>")


def marks_key() -> str:
    """How to read the images: label boxes, marks, leaders, omitted items and the violations drawn over them."""
    mark, lead, omit = render.MARK_STROKE, render.LEADER, render.UNPLACED
    base = [
        f'<svg width="44" height="18" viewBox="0 0 44 18" aria-hidden="true"><rect width="44" height="18" '
        f'fill="{render.OBST}"/><rect x="3" y="2" width="38" height="14" fill="#fff" '
        f'fill-opacity="{render.LABEL_FILL_OPACITY}"/><text x="22" y="13" font-size="10" text-anchor="middle" '
        f'fill="{render.LABEL_TEXT}" font-family="Noto Sans, sans-serif">Label</text></svg>label box as the '
        "labeler reported it",
        f'<svg width="56" height="18" viewBox="0 0 56 18" aria-hidden="true"><circle cx="6" cy="12" r="4" '
        f'fill="{render.MARK_FILL}" stroke="{mark}"/><circle cx="17" cy="12" r="4" fill="#e15759" '
        f'fill-opacity="0.75" stroke="{render._darker("#e15759")}"/><polyline points="21,10 40,4 54,4" '
        f'fill="none" stroke="{lead}" stroke-width="1.5"/></svg>item mark (in the data\'s colour where the chart '
        "has one) and leader",
        f'<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M4 4 L14 14 M14 4 L4 14" '
        f'stroke="{omit}" stroke-width="2.2"/></svg>item whose label was left out',
    ]
    return ("<div class='key' id='marks'>" + "".join(f"<span>{b}</span>" for b in base)
            + "".join(f"<span>{render.violation_icon(k)}{esc(text)}</span>" for k, _c, text in render.VIOLATIONS)
            + "</div>")


# ---------------------------------------------------------------------------
# aggregates per solver
# ---------------------------------------------------------------------------
def engine_ms(r: dict) -> float | None:
    """The solver's own runtime (median), else the wall time."""
    v = (r.get("runtime_reported") or {}).get("median")
    if not isinstance(v, (int, float)):
        v = (r.get("runtime") or {}).get("median")
    return v if isinstance(v, (int, float)) else None


def aggregates(report: dict, solver: str) -> dict:
    """One solver over the problems it ran: means of the rates, sums of the counts and times, the median time per
    problem, the peak memory and the scaling exponent."""
    rs = [r for r in report["results"] if r["solver"] == solver]
    ok = [r for r in rs if "summary" in r]
    engs = [v for v in ((r.get("runtime_reported") or {}).get("median") for r in ok) if isinstance(v, (int, float))]
    mem = [v for v in ((r.get("peak_rss_mb") or {}).get("max") for r in ok) if isinstance(v, (int, float))]
    times = [t for t in (engine_ms(r) for r in ok) if t is not None]
    row = {"problems": len(ok), "n/a": sum(1 for r in rs if "skipped" in r),
           "errors": sum(1 for r in rs if "error" in r),
           "violating": sum(1 for r in ok if r["summary"].get("hard_violations")),
           "engine_ms": sum(engs) if engs else None, "wall_ms": sum(r["runtime"]["median"] for r in ok) if ok else None,
           "peak_mb": max(mem) if mem else None, "scaling": scaling_exponent(report["results"], solver),
           "time_ms": statistics.median(times) if times else None}
    for k in ("placed_rate", "usable_rate", "ambiguity_rate", "clarity_unclear_rate", "points_covered_rate",
              "labels_close_rate"):
        row[k] = _mean(_numbers(ok, k))
    for k in ("hard_violations", "hard_conflicts", "priority_inversions"):
        v = _numbers(ok, k)
        row[k] = sum(v) if v else None
    return row


# ---------------------------------------------------------------------------
# header
# ---------------------------------------------------------------------------
def _range(vals: list[float], f) -> str:
    if not vals:
        return ""
    lo, hi = min(vals), max(vals)
    return f(lo) if f(lo) == f(hi) else f"{f(lo)} to {f(hi)}"


def kpis_html(stats: dict[str, dict], pick: Pick) -> str:
    """Label Anything's headline numbers, each next to the range of the other labelers."""
    ref = pick.ref
    if ref is None or not stats[ref]["problems"]:
        return ""
    me = stats[ref]
    others = [s for s in pick.sel if not implementation(s) and stats[s]["problems"]]

    def vals(k):
        return [stats[s][k] for s in others if stats[s].get(k) is not None]

    pct = "{:.1%}".format

    def num(v):
        return f"{v:,.0f}"

    tiles = []
    if me.get("hard_violations") is not None:
        rng = _range(vals("hard_violations"), num)
        tiles.append(("Hard violations", num(me["hard_violations"]),
                      f"in {me['problems']} problems" + (f" · the others {rng}" if rng else "")))
    if me.get("usable_rate") is not None:
        rng = _range(vals("usable_rate"), pct)
        tiles.append(("Usable labels", pct(me["usable_rate"]),
                      "of all items, mean per problem" + (f" · the others {rng}" if rng else "")))
    if me.get("clarity_unclear_rate") is not None:
        rng = _range(vals("clarity_unclear_rate"), pct)
        tiles.append(("Unclear labels", pct(me["clarity_unclear_rate"]),
                      "of the placed labels, mean" + (f" · the others {rng}" if rng else "")))
    if me.get("time_ms") is not None:
        rng = _range(vals("time_ms"), dur)
        tiles.append(("Time per problem", dur(me["time_ms"]), "median" + (f" · the others {rng}" if rng else "")))
    return ("<div class='kpis' aria-label=\"Label Anything's headline numbers\">"
            + "".join(f"<div class='kpi'><span class='k'>{esc(k)}</span><span class='v'>{esc(v)}</span>"
                      f"<span class='s'>{esc(s)}</span></div>" for k, v, s in tiles) + "</div>")


def header_html(report: dict, gallery: dict | None, stats: dict, pick: Pick) -> str:
    probs = {(r["scenario"], r["config"]) for r in report["results"]}
    scen = {sc for sc, _ in probs}
    tools = [s for s in report["solvers"] if not implementation(s)]
    m = report.get("machine") or {}
    machine = ", ".join(x for x in (m.get("cpu"), f"{m['cores']} cores" if m.get("cores") else "") if x)
    commit = (gallery or {}).get("meta", {}).get("commit")
    lede = (f"{len(probs)} problems of {len(scen)} scenarios, maps, charts, photos, embeddings and networks of real "
            f"data, labeled by Label Anything and {len(tools)} other labelers. Every labeler gets the same label "
            "boxes, marks and obstacles; one evaluator scores every result and one renderer draws it, so the numbers "
            "and the pictures compare like with like.")
    meta = (f"Suite <b>{esc(report['suite'])}</b>, generated {esc(report['generated_at'])}"
            + (f", engine at commit <code>{esc(commit)}</code>" if commit else "")
            + (f", on {esc(machine)}" if machine else "") + ".")
    return (f"<header class='top wrap'><p class='eyebrow'><a href='{SITE}'>Label Anything</a> · benchmark report</p>"
            "<h1>Labels on real data, side by side</h1>"
            f"<p class='lede'>{esc(lede)}</p><p class='small note' style='margin:0'>{meta}</p>"
            f"{kpis_html(stats, pick)}</header>")


# ---------------------------------------------------------------------------
# the bar
# ---------------------------------------------------------------------------
def bar_html(toc: list[tuple[str, str, int]], pick: Pick) -> str:
    links = "".join(f"<a href='#{esc(i)}'{' class=sub' if lvl else ''}>{esc(t)}</a>" for i, t, lvl in toc)
    me = f"<span class='me'>{esc(name(pick.ref))}</span>" if pick.ref else ""
    vs = "".join(f"<button type='button' class='chip' data-solver='{esc(s)}' data-default='"
                 f"{'1' if s in pick.on else '0'}' aria-pressed='{'true' if s in pick.on else 'false'}' "
                 f"title='{esc(ABOUT.get(s, name(s)))}'>{esc(name(s))}</button>" for s in pick.sel)
    more = ("<button type='button' class='lnk' id='vs-all'>all</button>"
            "<button type='button' class='lnk' id='vs-reset'>reset</button>") if pick.sel else ""
    return (f"<div class='bar'><div class='wrap'><details class='toc'><summary>Contents</summary><nav>{links}</nav>"
            f"</details><div class='vs' role='group' aria-label='Labelers compared'>{me}"
            f"<span class='lbl'>{'vs' if pick.ref else 'labelers'}</span>{vs}{more}</div>"
            "<label class='allm'><input type='checkbox' id='allm'> all metrics</label></div></div>")


# ---------------------------------------------------------------------------
# at a glance
# ---------------------------------------------------------------------------
STAND = (  # key of ``aggregates``, title, how it aggregates, format, direction (+1: more is better), log scale
    ("usable_rate", "Usable labels", "mean per problem", "{:.1%}", +1, False),
    ("hard_violations", "Hard violations", "sum", "{:,d}", -1, True),
    ("clarity_unclear_rate", "Unclear labels", "mean", "{:.1%}", -1, False),
    ("points_covered_rate", "Points covered", "mean", "{:.1%}", -1, False),
    ("labels_close_rate", "Labels too close", "mean", "{:.1%}", -1, False),
    ("time_ms", "Time per problem", "median", None, -1, True),
)
STRIP_W, STRIP_A, STRIP_B = 104, 6, 98


def _domain(vals: list[float], f: str | None, log: bool) -> tuple[float, float, callable]:
    """The strip's range: (lo, hi, transform); rates in steps of 5 points, log scales in decades."""
    if log:
        if f is None:  # times: log10(ms)
            t = lambda v: math.log10(max(v, 1e-3))  # noqa: E731
        else:  # counts: log10(1 + v), 0 at the left end
            t = lambda v: math.log10(1 + max(v, 0))  # noqa: E731
        ts = [t(v) for v in vals]
        lo, hi = math.floor(min(ts)), math.ceil(max(ts))
    else:
        t = lambda v: v  # noqa: E731
        lo, hi = math.floor(min(vals) * 20) / 20, math.ceil(max(vals) * 20) / 20
    if hi - lo < 1e-9:
        lo, hi = lo - (1 if log else 0.05), hi + (1 if log else 0.05)
    return lo, hi, t


def _end(v: float, f: str | None, log: bool) -> str:
    """A strip's end value for its axis label."""
    if not log:
        return f"{v:.0%}"
    if f is None:  # a decade of ms
        ms = 10 ** v
        return f"{ms:g} ms" if ms < 1000 else f"{ms / 1000:g} s"
    return _compact(10 ** v) if v > 0 else "0"


def _strip(field: list[float], x: float) -> str:
    def px(f: float) -> float:
        return STRIP_A + f * (STRIP_B - STRIP_A)
    return (f'<svg class="strip" width="{STRIP_W}" height="18" viewBox="0 0 {STRIP_W} 18" aria-hidden="true">'
            f'<line class="track" x1="{STRIP_A}" y1="9" x2="{STRIP_B}" y2="9"/>'
            + "".join(f'<circle class="ghost" cx="{px(f):.1f}" cy="9" r="2.5"/>' for f in field)
            + f'<circle class="me" cx="{px(x):.1f}" cy="9" r="5"/></svg>')


def standings_html(stats: dict[str, dict], pick: Pick, n_problems: int) -> str:
    """Where each labeler stands: per measure a strip with every labeler (grey) and the row's one (dark; Label
    Anything blue), further right is better, the value beside it."""
    rows = [s for s in pick.order if stats[s]["problems"]]
    cols = []
    for key, title, how, f, d, log in STAND:
        vals = [stats[s][key] for s in rows if stats[s].get(key) is not None]
        if not vals:
            continue
        lo, hi, t = _domain(vals, f, log)

        def pos(v, lo=lo, hi=hi, t=t, d=d):
            x = (t(v) - lo) / (hi - lo)
            return x if d > 0 else 1 - x
        cols.append((key, title, how, f, d, log, lo, hi, pos, [pos(v) for v in vals]))
    if not cols:
        return ""
    o = ["<div class='scroll'><table class='stand'><thead><tr><th>labeler</th>"
         + "".join(f"<th{tip(k)}>{esc(title)}<span class='dir'>{esc(how)} · better →</span></th>"
                   for k, title, how, *_ in cols) + "</tr>"
         "<tr class='axis'><td></td>" + "".join(
             f"<td><span class='pad'></span><span class='ends'><span>{esc(_end(lo if d > 0 else hi, f, lg))}</span>"
             f"<span>{esc(_end(hi if d > 0 else lo, f, lg))}</span></span></td>"
             for _k, _t, _h, f, d, lg, lo, hi, _p, _fl in cols) + "</tr></thead><tbody>"]
    for s in rows:
        st = stats[s]
        n = st["problems"]
        note = f"{n} problems" if n == n_problems else f"{n} of {n_problems} problems"
        cells = []
        for key, _t, _h, f, _d, _l, _lo, _hi, pos, field in cols:
            v = st.get(key)
            if v is None:
                cells.append("<td class='v'>–</td>")
                continue
            text = dur(v) if f is None else fmt(v, f)
            cells.append(f"<td class='v'><span>{esc(text)}</span>{_strip(field, pos(v))}</td>")
        cls = " class='la'" if s == pick.ref or implementation(s) else ""
        o.append(f"<tr{cls}{pick.attrs(s)}><td class='solver' title='{esc(ABOUT.get(s, name(s)))}'>{esc(name(s))}"
                 f"<small>{esc(note)}</small></td>" + "".join(cells) + "</tr>")
    o.append("</tbody></table></div>")
    return "".join(o)


SUMMARY_COLS = [  # (key, heading, format, direction, log scale)
    ("problems", "problems", "{:d}", 0, False),
    ("n/a", "n/a", "{:d}", 0, False),
    ("errors", "errors", "{:d}", -1, True),
    ("placed_rate", "placed (mean)", "{:.1%}", +1, False),
    ("usable_rate", "usable (mean)", "{:.1%}", +1, False),
    ("hard_violations", "hard viol. (sum)", "{:d}", -1, True),
    ("hard_conflicts", "conflicts (sum)", "{:d}", -1, True),
    ("violating", "problems with hard viol.", "{:d}", -1, True),
    ("ambiguity_rate", "ambig. (mean)", "{:.1%}", -1, False),
    ("clarity_unclear_rate", "unclear (mean)", "{:.1%}", -1, False),
    ("points_covered_rate", "points covered (mean)", "{:.1%}", -1, False),
    ("labels_close_rate", "labels close (mean)", "{:.1%}", -1, False),
    ("priority_inversions", "inversions (sum)", "{:d}", -1, True),
    ("engine_ms", "engine ms (sum of medians)", "{:,.1f}", -1, True),
    ("wall_ms", "wall ms (sum of medians)", "{:,.1f}", -1, True),
    ("peak_mb", "peak MB (max)", "{:,.0f}", -1, True),
    ("scaling", "runtime ∝ n^k", "{:.2f}", -1, False),
]


def summary_table(report: dict, stats: dict[str, dict], pick: Pick) -> str:
    """One row per solver, every column coloured against the median of all solvers."""
    tips = {"scaling": f"slope of log runtime over log items on {SCALING_SCENARIO}"}
    solvers = sorted(report["solvers"], key=pick.rank)
    o = ["<div class='scroll'><table><tr><th class='l'>solver</th><th class='l'>kind</th>"
         + "".join(f"<th title='{esc(tips[k])}'>{esc(h)}</th>" if k in tips else f"<th{tip(k)}>{esc(h)}</th>"
                   for k, h, _f, _d, _l in SUMMARY_COLS) + "</tr>"]
    rows = [stats[s] for s in solvers]
    attrs = heat_attrs(rows, [(k, f, d, lg) for k, _h, f, d, lg in SUMMARY_COLS])
    for s, row, a in zip(solvers, rows, attrs):
        k = kind(s)
        o.append(f"<tr class='{'la' if k == 'label-anything' else ''}'{pick.attrs(s)}><td class='l solver' "
                 f"title='{esc(s)}'>{esc(name(s))}</td><td class='l'>{esc(k)}</td>"
                 + "".join(f"<td{a[c]}>{fmt(row[c], f)}</td>" for c, _h, f, _d, _l in SUMMARY_COLS) + "</tr>")
    o.append("</table></div>")
    return "".join(o)


def overview_html(report: dict, stats: dict[str, dict], pick: Pick) -> str:
    n = len({(r["scenario"], r["config"]) for r in report["results"]})
    guide = ("Each row is a labeler, each strip one measure over the problems it ran: its dot among the others' "
             "(grey), further right is better. The labelers in the bar above are shown here and in every chapter; "
             "add the others there. Hover a heading for what it measures.")
    return (f"<section class='chapter wrap' id='summary'><h2>At a glance <small>{n} problems</small></h2>"
            f"<p class='guide'>{esc(guide)}</p>{standings_html(stats, pick, n)}"
            "<details class='more'><summary><b>Every summary number</b><span>the columns coloured against the "
            "median of all solvers</span></summary><div class='in'>"
            + heat_key("its column", detail=True) + summary_table(report, stats, pick) + "</div></details>"
            "<details class='more'><summary><b>How to read the images</b><span>what the marks over them "
            "show</span></summary><div class='in'><p class='small note' style='margin:0'>Every labeler's result is "
            "drawn by the same renderer; what the measures count is marked where it happens.</p>"
            + marks_key() + "</div></details>"
            "<details class='more'><summary><b>What the measures mean</b><span>in a sentence each</span></summary>"
            f"<div class='in'>{glossary_html()}</div></details></section>")


# ---------------------------------------------------------------------------
# chapters
# ---------------------------------------------------------------------------
CHAPTERS = (  # id, title, subtitle, lede, scenarios; the gallery's section of the same id gives title and lede
    ("maps", "Maps", "airports and points of interest",
     "Dense, uneven point sets where the busy places matter most: the busiest airports of the world and of "
     "Europe, the sights of a city over a street map.", ("05-airports", "06-city-pois")),
    ("charts", "Charts", "scatterplots, bubbles, line ends",
     "Labels next to their marks and clear of axes, legends and each other: outliers of a scatterplot, the bubbles "
     "of a Gapminder chart, the genes of a volcano plot, the ends of line charts.",
     ("03-gapminder", "02-volcano", "09-line-end-labels", "01-software-metrics")),
    ("images", "Photos and illustrations", "area anchors, leaders, margin labels",
     "Regions of photos and drawings, labeled inside, beside or in the margin, with leaders.", ("08-illustration",)),
    ("graphs", "Embeddings and networks", "clusters and nodes",
     "Topic clusters of a text embedding over 50,000 points, the nodes of graphs.", ("04-embedding", "07-node-link")),
    ("priority", "Priority", "what is left out",
     "With more labels than room, the order decides which ones are shown.", ("12-priority",)),
    ("scale", "Scale", "from hundreds to thousands of labels",
     "The airports at ten times their density (synthetic: jittered copies of the real ones), at growing sizes; "
     "how the time grows with the number of labels.", ("10-stress",)),
)


def fig_html(f: dict, m: dict, prefix: str) -> str:
    """A figure of the gallery: the image, its problem, title, caption, numbers and settings."""
    scenario, _, config = f["key"].partition("/")
    cls = "fig" + (" wide" if f.get("wide") else "") + (" limit" if f.get("limit") else "")
    kind_ = "SVG" if m["img"].endswith(".svg") else "image"
    st = (f"<details class='set'><summary>Settings of this problem</summary><pre>{esc(m['settings_json'])}</pre>"
          "</details>") if m.get("settings_json") else ""
    return (f"<figure class='{cls}' id='{esc(f['key'].replace('/', '--'))}'>"
            + shot(m, f["title"], f"{f['title']} · {scenario} · {config}", prefix)
            + f"<figcaption><div class='srcrow'><span class='src'>{esc(scenario)} · {esc(config)}</span>"
              f"<a href='{esc(prefix + m['img'])}' download>{kind_}</a></div><h3>{esc(f['title'])}</h3>"
              f"<p>{f['text']}</p>{chips(m.get('chips') or [])}{st}</figcaption></figure>")


def _card_chips(r: dict) -> list[tuple[str, str]]:
    s = r["summary"]
    out = [(f"{s['placed']:,} of {s['total']:,} placed", "")]
    u = s.get("usable")
    if isinstance(u, (int, float)) and u < s["placed"]:
        out.append((f"{int(u):,} usable", "warn"))
    hv = s.get("hard_violations") or 0
    out.append(("no hard violations", "ok") if hv == 0 else (f"{hv:,} hard violation{'s' if hv != 1 else ''}", "bad"))
    ur = s.get("clarity_unclear_rate")
    if ur:
        out.append((f"{ur:.0%} unclear", "warn"))
    t = engine_ms(r)
    if t is not None:
        out.append((dur(t), ""))
    return out


def card_html(r: dict, cell: dict | None, out: Path, pick: Pick, caption: str, crop: list | None = None,
              canvas: list | None = None) -> str:
    """One labeler's result for a problem: its name, the image (the gallery's vector drawing, else the run's), the
    main numbers; or why it did not run."""
    s = r["solver"]
    la = " la" if s == pick.ref or implementation(s) else ""
    note = _baseline_note(r)
    head = (f"<figcaption class='ch'><span title='{esc(ABOUT.get(s, name(s)))}'>{esc(name(s))}</span>"
            f"{note}</figcaption>")
    if "summary" not in r:
        why = r.get("skipped") or r.get("error") or "no result"
        return (f"<figure class='card{la}'{pick.attrs(s)}>{head}<p class='naw'>"
                f"{'Could not run this problem' if 'skipped' in r else 'Failed'}: {esc(why)}</p></figure>")
    if cell and cell.get("img"):
        img = shot(cell, f"{name(s)}: {caption}", f"{name(s)} · {caption}", "gallery/", crop=crop, canvas=canvas)
    elif r.get("image"):
        size = _image_size(out / r["image"])
        m = {"img": r["image"], "size": size, "full": r["image"], "full_size": size}
        img = shot(m, f"{name(s)}: {caption}", f"{name(s)} · {caption}", crop=crop, canvas=canvas)
    else:
        img = "<p class='naw'>Not drawn in this run.</p>"
    return f"<figure class='card{la}'{pick.attrs(s)}>{head}{img}{chips(_card_chips(r))}</figure>"


CROP = (600.0, 400.0)
"""Canvas px of the detail a card shows of a large problem, at about its own size."""


def crop_window(problem: dict, size: tuple[float, float] = CROP) -> list[float] | None:
    """The window of ``size`` holding the most items' reference points (the densest part, where labelers differ
    most), as [x, y, w, h] in canvas px; None when the whole canvas stays legible at the window's size (an area
    less than 3.2 times the window's)."""
    c = problem.get("canvas") or {}
    W, H = float(c.get("width", 0) or 0), float(c.get("height", 0) or 0)
    w, h = size
    if not W or not H or W * H <= 3.2 * w * h:
        return None
    w, h = min(w, W), min(h, H)
    pts = [it.ref for it in load_problem(problem).items]
    if not pts:
        return None
    mx, my = sum(x for x, _ in pts) / len(pts), sum(y for _, y in pts) / len(pts)

    def starts(total: float, span: float) -> list[float]:
        n = max(1, math.ceil((total - span) / (span / 12)))
        return [(total - span) * k / n for k in range(n + 1)]
    best = None
    for x0 in starts(W, w):
        for y0 in starts(H, h):
            n = sum(1 for x, y in pts if x0 <= x < x0 + w and y0 <= y < y0 + h)
            d = (x0 + w / 2 - mx) ** 2 + (y0 + h / 2 - my) ** 2
            if best is None or (n, -d) > (best[0], -best[1]):
                best = (n, d, x0, y0)
    return [round(best[2], 1), round(best[3], 1), w, h]


def problem_crop(path: str) -> tuple[list[float] | None, list[float] | None]:
    """(crop_window, [canvas width, height]) of the problem file ``path`` (relative to the repository); (None, None)
    when it is not there, e.g. a report rebuilt away from the run."""
    f = paths.REPO / path
    if not path or not f.exists():
        return None, None
    return _crop_of(str(f), f.stat().st_mtime_ns)


@functools.lru_cache(maxsize=256)
def _crop_of(path: str, _mtime: int) -> tuple[list[float] | None, list[float] | None]:
    problem = read_json(Path(path))
    c = problem.get("canvas") or {}
    return crop_window(problem), [c.get("width"), c.get("height")]


KEY_COLS = ["placed_rate", "usable_rate", "hard_violations", "clarity_unclear_rate", "points_covered_rate",
            "labels_close_rate", "priority_inversions"]
SCENARIO_HEAT = ([(k, META[k][1], META[k][2], "d" in META[k][1]) for k in TABLE_COLS]
                 + [("engine_ms", "{:,.1f}", -1, True), ("wall_ms", "{:,.1f}", -1, True),
                    ("peak_mb", "{:,.0f}", -1, True)])


def _scenario_values(r: dict) -> dict:
    """The values a scenario table colours: the metrics of ``TABLE_COLS``, the runtimes and the memory."""
    return {**{k: r["summary"].get(k) for k in TABLE_COLS},
            "engine_ms": (r.get("runtime_reported") or {}).get("median"), "wall_ms": r["runtime"]["median"],
            "peak_mb": (r.get("peak_rss_mb") or {}).get("max")}


def _heat_by_group(items: list[dict], group: str, values, cols: list) -> dict[int, dict[str, str]]:
    """``heat_attrs`` per item (by id) for the columns ``cols`` of ``values(item)``, compared among the items with
    the same ``group`` value (one problem, one sequence)."""
    out = {}
    for g in {it[group] for it in items}:
        same = [it for it in items if it[group] == g]
        out.update(zip(map(id, same), heat_attrs([values(it) for it in same], cols)))
    return out


def metrics_table(rows: list[dict], pick: Pick, configs: list[str]) -> str:
    """The numbers of one scenario: per config the solvers, every value coloured against the median of all solvers
    on that problem; the main columns, the others (class ``x``) with "all metrics"."""
    extra = [k for k in TABLE_COLS if k not in KEY_COLS]
    attrs = _heat_by_group([r for r in rows if "summary" in r], "config", _scenario_values, SCENARIO_HEAT)
    many = len(configs) > 1
    head = (("<th class='l'>config</th>" if many else "") + "<th class='l'>solver</th><th class='x'>items</th>"
            + "".join(f"<th{tip(k)}>{esc(META[k][0])}</th>" for k in KEY_COLS)
            + f"<th{tip('engine_ms')}>time</th>"
            + "".join(f"<th class='x'{tip(k)}>{esc(META[k][0])}</th>" for k in extra)
            + f"<th class='x'{tip('wall_ms')}>wall ms (median / p95)</th><th class='x'{tip('peak_mb')}>peak MB</th>"
              "<th class='x' title='the same result in every run'>det.</th><th class='x l'>notes</th>")
    o = [f"<div class='scroll'><table class='metrics'><tr>{head}</tr>"]
    ncols = len(KEY_COLS) + 1 + len(extra) + 4
    for r in sorted(rows, key=lambda r: (configs.index(r["config"]) if r["config"] in configs else 0,
                                         pick.rank(r["solver"]))):
        s = r["solver"]
        la = "la" if kind(s) == "label-anything" else ""
        cfg = f"<td class='l'>{esc(r['config'])}</td>" if many else ""
        head = f"{cfg}<td class='l solver'>{esc(name(s))}</td><td class='x'>{r.get('n_items') or ''}</td>"
        if "summary" not in r:
            what = f"n/a: {r['skipped']}" if "skipped" in r else str(r.get("error"))
            o.append(f"<tr class='{'na' if 'skipped' in r else la}'{pick.attrs(s)}>{head}<td colspan='{ncols}' "
                     f"class='l{' err' if 'error' in r else ''}'>{esc(what)}</td></tr>")
            continue
        sm, rt, v, a = r["summary"], r["runtime"], _scenario_values(r), attrs[id(r)]
        hv = sm.get("hard_violations") or 0

        def td(k: str, text: str, extra_col: bool = False) -> str:
            c = " class='bad'" if k == "hard_violations" and hv and la else a.get(k, "")
            return (_x(c) if extra_col else f"<td{c}>") + text + "</td>"

        det = "–" if len(rt.get("runs", [])) < 2 else ("yes" if r.get("deterministic") else "<b>NO</b>")
        o.append(f"<tr class='{la}'{pick.attrs(s)}>{head}"
                 + "".join(td(k, fmt(sm.get(k), META[k][1])) for k in KEY_COLS)
                 + td("engine_ms", esc(dur(v["engine_ms"])))
                 + "".join(td(k, fmt(sm.get(k), META[k][1]), True) for k in extra)
                 + td("wall_ms", f"{rt['median']:,.1f} / {rt['p95']:,.1f}", True)
                 + td("peak_mb", fmt(v["peak_mb"], "{:,.0f}"), True)
                 + f"<td class='x'>{det}</td><td class='x l'>{_baseline_note(r)}</td></tr>")
    o.append("</table></div>")
    return "".join(o)


def _x(attrs: str) -> str:
    """A cell of an extra column with the heat attributes ``attrs``: the opening tag."""
    if "class='" in attrs:
        return "<td" + attrs.replace("class='", "class='x ", 1) + ">"
    return f"<td class='x'{attrs}>"


def scenario_html(report: dict, sc: str, rows: list[dict], cmps: dict, out: Path, pick: Pick) -> str:
    """One scenario of the run: per config the labelers side by side (one config at a time, tabs), then the
    numbers of all configs."""
    probs = [p for p in report.get("problems", []) if p.get("scenario") == sc]
    title = next((p["title"] for p in probs if p.get("title")), sc)
    order = [p["config"] for p in probs]
    configs = sorted({r["config"] for r in rows}, key=lambda c: (order.index(c) if c in order else len(order), c))
    desc = {p["config"]: p for p in probs}
    panes, tabs, crops = [], [], {}
    for k, cfg in enumerate(configs):
        pid = f"cfg-{sc}-{cfg}"
        rs = sorted((r for r in rows if r["config"] == cfg), key=lambda r: pick.rank(r["solver"]))
        cmp = cmps.get((sc, cfg)) or {}
        cells = {c["solver"]: c for c in cmp.get("cells", [])}
        p = desc.get(cfg) or {}
        n = p.get("n_items") or next((r.get("n_items") for r in rs if r.get("n_items")), None)
        text = " · ".join(x for x in (p.get("description"), f"{n:,} items" if n else "") if x)
        caption = f"{sc} · {cfg}"
        crop, canvas = problem_crop(next((r["problem"] for r in rs if r.get("problem")), ""))
        crops[cfg] = crop
        cards = "".join(card_html(r, cells.get(r["solver"]), out, pick, caption, crop, canvas) for r in rs)
        lede = f"<p class='desc'>{cmp['text']}</p>" if cmp.get("text") else ""
        panes.append(f"<div class='cfg' id='{esc(pid)}' role='tabpanel'><p class='desc'><span class='src'>"
                     f"{esc(cfg)}</span> {esc(text)}</p>{lede}<div class='cards' data-group='{esc(pid)}'>{cards}</div>"
                     "</div>")
        tabs.append(f"<button type='button' class='tab' role='tab' aria-controls='{esc(pid)}' "
                    f"aria-selected='{'true' if k == 0 else 'false'}'>{esc(cfg)}</button>")
    bar = f"<div class='tabs' role='tablist' aria-label='Problems of {esc(title)}'>{''.join(tabs)}</div>" \
        if len(configs) > 1 else ""
    whole = ("<button type='button' class='lnk whole' aria-pressed='false'>show the whole images</button>"
             if any(crops.values()) else "")
    return (f"<article class='scenario' id='sc-{esc(sc)}'><header><h3>{esc(title)}</h3><span class='src'>{esc(sc)}"
            f"</span>{whole}</header>{bar}{''.join(panes)}{metrics_table(rows, pick, configs)}</article>")


def chapter_html(cid: str, title: str, sub: str, lede: str, figs: list[str], blocks: list[str], extra: str = "",
                 group: str = "") -> str:
    o = [f"<section class='chapter wrap' id='{esc(cid)}'><h2>{esc(title)}"
         + (f" <small>{esc(sub)}</small>" if sub else "") + "</h2>"]
    if lede:
        o.append(f"<p class='lede'>{lede}</p>")
    if figs:
        o.append(f"<div class='figs' data-group='{esc(group or 'figs-' + cid)}'>" + "".join(figs) + "</div>")
    if blocks:
        o.append("<h3 class='subhead'>Side by side <small>the same problems for every labeler, scored by one "
                 "evaluator and drawn by one renderer; select an image to zoom and flip between the labelers</small>"
                 "</h3>" + heat_key("all solvers on the same problem") + "".join(blocks))
    o.append(extra)
    o.append("</section>")
    return "".join(o)


# ---------------------------------------------------------------------------
# interactive use
# ---------------------------------------------------------------------------
SEQ_HEAT = [(k, f, d, "d" in f) for k, _l, f, d in SEQ_METRICS] + [("frame_ms", "{:,.1f}", -1, True)]


def _frame_ms(s: dict) -> float | None:
    """The median engine runtime of a sequence's frames."""
    rts = sorted(f["runtime_ms"] for f in s.get("frames", []) if isinstance(f.get("runtime_ms"), (int, float)))
    return rts[len(rts) // 2] if rts else None


def sequence_table(report: dict, pick: Pick) -> str:
    seqs = sorted(report.get("sequences") or [], key=lambda s: (s["sequence"], pick.rank(s["solver"])))
    if not seqs:
        return ""
    attrs = _heat_by_group([s for s in seqs if "metrics" in s], "sequence",
                           lambda s: {**s["metrics"], "frame_ms": _frame_ms(s)}, SEQ_HEAT)
    o = ["<div class='scroll'><table id='sequences'><tr><th class='l'>sequence</th><th class='l'>solver</th>"
         f"<th>frames</th><th{tip('displacement_mean_px')}>displacement px (mean / median)</th>"
         f"<th{tip('flip_rate')}>flip rate</th><th{tip('nesting_rate')}>nesting rate</th>"
         f"<th{tip('nesting_fraction_mean')}>nesting fraction</th><th>added</th><th>removed</th>"
         "<th>time (median frame)</th></tr>"]
    for s in seqs:
        opt = s.get("options") or {}
        tp = (f"{opt['iter_lim']} iterations per frame (the comparison budget of the sequence), "
              f"lines sampled every {opt['step']:g} px" if "iter_lim" in opt and "step" in opt else "")
        note = f" <span class='em' title='{esc(tp)}'>≈</span>" if tp else ""
        la = "la" if kind(s["solver"]) == "label-anything" else ""
        head = f"<td class='l'>{esc(s['sequence'])}</td><td class='l solver'>{esc(name(s['solver']))}{note}</td>"
        if "skipped" in s:
            o.append(f"<tr class='na'{pick.attrs(s['solver'])}>{head}<td colspan='8' class='l'>n/a: "
                     f"{esc(s['skipped'])}</td></tr>")
            continue
        if "error" in s:
            o.append(f"<tr{pick.attrs(s['solver'])}>{head}<td colspan='8' class='l err'>{esc(s['error'])}</td></tr>")
            continue
        m, a = s["metrics"], attrs[id(s)]
        o.append(f"<tr class='{la}'{pick.attrs(s['solver'])}>{head}<td>{m['frames']}</td>"
                 f"<td{a['displacement_mean_px']}>{fmt(m['displacement_mean_px'], '{:.2f}')} / "
                 f"{fmt(m['displacement_median_px'], '{:.2f}')}</td>"
                 f"<td{a['flip_rate']}>{fmt(m['flip_rate'], '{:.1%}')}</td>"
                 f"<td{a['nesting_rate']}>{fmt(m['nesting_rate'], '{:.1%}')}</td>"
                 f"<td{a['nesting_fraction_mean']}>{fmt(m['nesting_fraction_mean'], '{:.3f}')}</td>"
                 f"<td>{m['added_total']}</td><td>{m['removed_total']}</td>"
                 f"<td{a['frame_ms']}>{esc(dur(_frame_ms(s)))}</td></tr>")
    o.append("</table></div>")
    return "".join(o)


def stability_fig(st: dict, prefix: str) -> str:
    n = st.get("n_frames") or len(st["frames"])
    frames = "".join(shot(f, f"{st.get('kind', 'Sequence')}, frame {f['frame']} of {n}",
                          f"{st.get('title', st['sequence'])} · frame {f['frame']} of {n}", prefix)
                     for f in st["frames"])
    return (f"<figure class='fig wide' id='seq-{esc(st['sequence'])}'><div class='frames' "
            f"data-group='seq-{esc(st['sequence'])}'>{frames}</div><figcaption><div class='srcrow'><span class='src'>"
            f"{esc(st['scenario'])} · {esc(st['sequence'])} · frames "
            + ", ".join(str(f["frame"]) for f in st["frames"]) + f" of {n}</span></div>"
            f"<h3>{esc(st.get('title', st['sequence']))}</h3><p>{st.get('text', '')}</p>"
            f"{chips(st.get('chips') or [])}</figcaption></figure>")


def frames_by_labeler(report: dict, out: Path, pick: Pick) -> str:
    """Per sequence, the first, middle and last frame of every solver the run drew."""
    seqs = [s for s in report.get("sequences") or [] if s.get("images")]
    if not seqs:
        return ""
    o = []
    for name_ in sorted({s["sequence"] for s in seqs}):
        cards = []
        for s in sorted((q for q in seqs if q["sequence"] == name_), key=lambda q: pick.rank(q["solver"])):
            ims = []
            for im in s["images"]:
                size = _image_size(out / im)
                k = Path(im).stem.removeprefix("frame")
                cap = f"{name(s['solver'])} · {name_} · frame {int(k) + 1 if k.isdigit() else k}"
                ims.append(shot({"img": im, "size": size, "full": im, "full_size": size}, cap, cap))
            la = " la" if implementation(s["solver"]) else ""
            cards.append(f"<figure class='card{la}'{pick.attrs(s['solver'])}><figcaption class='ch'><span>"
                         f"{esc(name(s['solver']))}</span></figcaption><div class='frames'>{''.join(ims)}</div>"
                         "</figure>")
        o.append(f"<h3 class='subhead'>{esc(name_)} <small>first, middle and last frame</small></h3>"
                 f"<div class='cards' data-group='frames-{esc(name_)}'>{''.join(cards)}</div>")
    return ("<details class='more'><summary><b>The frames of every labeler</b><span>first, middle and last frame "
            "of each sequence</span></summary><div class='in'>" + "".join(o) + "</div></details>")


def stability_chapter(report: dict, gallery: dict | None, out: Path, pick: Pick) -> str:
    if not report.get("sequences"):
        return ""
    figs = [stability_fig(st, "gallery/") for st in (gallery or {}).get("stability", [])]
    lede = ("Maps that zoom and pan, graphs whose layout moves: every frame is labeled again, and labels that jump "
            "or change sides are hard to follow. Label Anything solves each frame with the previous result as a warm "
            "start.")
    extra = (heat_key("all solvers on the same sequence") + sequence_table(report, pick)
             + frames_by_labeler(report, out, pick))
    return chapter_html("stability", "Interactive use", "zooming, panning, moving layouts", esc(lede), figs, [],
                        extra)


# ---------------------------------------------------------------------------
# where it falls short
# ---------------------------------------------------------------------------
def better_table(report: dict, pick: Pick) -> str:
    rows = others_better(report, pick.ref) if pick.ref else []
    if not pick.ref:
        return ""
    head = ("<h3 class='subhead'>Where another labeler does better <small>with as many usable labels and no more hard "
            "violations, by more than one point</small></h3>")
    if not rows:
        return head + ("<p class='guide'>On no problem does another labeler with as many usable labels and no more "
                       "hard violations do better on these measures.</p>")
    o = [head, "<div class='scroll'><table><tr><th class='l'>problem</th><th class='l'>measure</th>"
               f"<th>{esc(name(pick.ref))}</th><th class='l'>better</th></tr>"]
    for r in rows:
        f = META[r["metric"]][1]
        measure = GLOSSARY.get(r["metric"], (META[r["metric"]][0],))[0]
        o.append(f"<tr><td class='l'><a href='#sc-{esc(r['scenario'])}'>{esc(r['scenario'])}</a> · "
                 f"{esc(r['config'])}</td><td class='l'{tip(r['metric'])}>{esc(measure)}</td>"
                 f"<td>{fmt(r['ref_value'], f)}</td><td class='l'>{esc(name(r['solver']))}: {fmt(r['value'], f)}</td>"
                 "</tr>")
    o.append("</table></div>")
    return "".join(o)


def weak_chapter(report: dict, gallery: dict | None, pick: Pick) -> str:
    sec = next((s for s in (gallery or {}).get("sections", []) if s["id"] == "weak"), None)
    figs = [fig_html(f, gallery["figures"][f["key"]], "gallery/") for f in (sec or {}).get("figures", [])
            if f["key"] in gallery["figures"]] if sec else []
    notes = (gallery or {}).get("notes") or []
    extra = ""
    if notes:
        extra += "<div class='notes'>" + "".join(f"<div class='notecard'><h3>{esc(n['title'])}</h3><p>{n['html']}</p>"
                                                 "</div>" for n in notes) + "</div>"
    extra += better_table(report, pick)
    lede = (sec or {}).get("lede") or "What the current defaults and models still do badly."
    return chapter_html("weak", "Where it falls short", "", lede, figs, [], extra)


# ---------------------------------------------------------------------------
# engineering details
# ---------------------------------------------------------------------------
def _more(id_: str, title: str, status: str, body: str) -> str:
    return (f"<details class='more' id='{esc(id_)}'><summary><b>{esc(title)}</b><span>{status}</span></summary>"
            f"<div class='in'>{body}</div></details>")


def perf_html(perf: dict | None) -> str:
    if not perf or not perf.get("rows"):
        return _more("perf", "Performance targets", "not measured in this run",
                     "<p class='note'>Use <code>--perf</code>; only solvers named rust, wasm or ts are measured.</p>")
    m = perf.get("machine", {})
    threads = perf.get("threads")
    thr = ("one thread, as the targets of brief §5.8" if threads == 1 else
           "all cores" if threads == 0 else f"{threads} threads" if threads else "the engine's default threads")
    o = [f"<p class='note'>Median of {perf['runs']} runs of the engine's own timing "
         f"(<code>stats.runtime_ms</code>; raster target: <code>stats.phases_ms.prepare</code>), not process "
         f"wall time; the native engine on {thr}. Machine: {esc(m.get('cpu', '?'))}, "
         f"{esc(m.get('cores', '?'))} cores, {esc(m.get('platform', ''))}. Problems: "
         "<code>python -m bench.perf generate</code> (deterministic).</p>",
         "<div class='scroll'><table><tr><th class='l'>problem</th><th class='l'>solver</th>"
         "<th class='l'>metric</th><th>median ms</th><th>target ms</th><th>ratio</th><th>runs (ms)</th>"
         "<th class='l'>result</th></tr>"]
    for r in perf["rows"]:
        if "median" in r:
            ratio = r["median"] / r["target"] if r["target"] else None
            vals = ", ".join(f"{v:.1f}" for v in r.get("values", []))
            o.append(f"<tr><td class='l'>{esc(r['problem'])}<br><span class='small note'>{esc(r['title'])}</span></td>"
                     f"<td class='l'>{esc(r['solver'])}</td><td class='l'><code>{esc(r['metric'])}</code></td>"
                     f"<td>{r['median']:.1f}</td><td>{r['target']:g}</td><td>{fmt(ratio, '{:.2f}×')}</td>"
                     f"<td class='small'>{vals}</td>" + _status_cell(r.get("passed"), "met", "missed") + "</tr>")
        else:
            o.append(f"<tr><td class='l'>{esc(r['problem'])}</td><td class='l'>{esc(r['solver'])}</td>"
                     f"<td class='l'><code>{esc(r['metric'])}</code></td><td>–</td><td>{r['target']:g}</td>"
                     f"<td>–</td><td class='l err' colspan='2'>{esc(r.get('error', 'not measured'))}</td></tr>")
    o.append("</table></div>")
    met = sum(1 for r in perf["rows"] if r.get("passed"))
    status = f"{met} of {len(perf['rows'])} met"
    return _more("perf", "Performance targets", status, "".join(o))


def gates_html(gate: dict | None) -> str:
    if not gate:
        return _more("gates", "Release gates", "not evaluated in this run",
                     "<p class='note'>Run with <code>--gate</code>, or <code>python -m bench.gates results.json "
                     "--previous previous/results.json</code>.</p>")
    o = ["<div class='scroll'><table><tr><th class='l'>gate</th><th class='l'>result</th>"
         "<th class='l'>details</th></tr>"]
    for c in gate["checks"]:
        res = "<td class='l warn'>– skipped</td>" if c.get("skipped") else _status_cell(c["passed"])
        det = "<br>".join(esc(d) for d in c.get("details", [])[:40])
        if len(c.get("details", [])) > 40:
            det += f"<br>… {len(c['details']) - 40} more"
        o.append(f"<tr><td class='l'>{esc(c['name'])}</td>{res}<td class='l wrap small'>{det}</td></tr>")
    o.append("</table></div>")
    status = ("<b class='good'>✓ all gates pass</b>" if gate["passed"] else "<b class='bad'>✗ gates failed</b>")
    return _more("gates", "Release gates", status, "".join(o))


def runtime_html(report: dict, plots: dict) -> str:
    if not plots:
        return _more("runtime", "Runtime against problem size", "no runtimes to plot", "")
    o = ["<p class='note'>One dot per problem (median over the runs), log–log axes shared by all panels; the line "
         "follows scenario 10 (stress sizes) when more than one size ran. Label Anything implementations keep their "
         "colour in every panel; each other panel shows one baseline (grey) against the reference implementation. "
         "Hover a dot for its problem.</p>"]
    for which, title in (("engine", "Engine-reported runtime (stats.runtime_ms: the solve or the tool call itself)"),
                         ("wall", "Wall-clock time per run (process start-up and I/O included)")):
        if which not in plots:
            continue
        o.append(f"<h3 class='subhead'>{esc(title)}</h3><div class='chart'>{runtime_svg(report, which)}</div>"
                 f"<p class='small note'>Static file: <a href='{esc(plots[which])}'>{esc(plots[which])}</a></p>")
    pts_e = runtime_points(report, "engine")
    pts_w = runtime_points(report, "wall")
    o.append("<details><summary class='small'>Table view</summary><div class='scroll'><table><tr><th class='l'>"
             "solver</th><th class='l'>problem</th><th>items</th><th>engine ms</th><th>wall ms</th></tr>")
    for s in report["solvers"]:
        wall = {(p["scenario"], p["config"]): p["ms"] for p in pts_w.get(s, [])}
        eng = {(p["scenario"], p["config"]): p["ms"] for p in pts_e.get(s, [])}
        for r in sorted((r for r in report["results"] if r["solver"] == s and "summary" in r),
                        key=lambda r: (r.get("n_items") or 0, r["scenario"])):
            key = (r["scenario"], r["config"])
            o.append(f"<tr><td class='l'>{esc(s)}</td><td class='l'>{esc(r['scenario'])}/{esc(r['config'])}</td>"
                     f"<td>{r.get('n_items') or '–'}</td><td>{fmt(eng.get(key), '{:,.1f}')}</td>"
                     f"<td>{fmt(wall.get(key), '{:,.1f}')}</td></tr>")
    o.append("</table></div></details>")
    return _more("runtime", "Runtime against problem size", "every solver, engine and wall time", "".join(o))


def parity_html(par: dict | None) -> str:
    if not par or not par.get("pairs"):
        return _more("parity", "Implementation parity", "needs Rust and TypeScript or WebAssembly in one run",
                     "<p class='note'>Run the Rust implementation and at least one other (solver names rust and ts "
                     "or wasm) together.</p>")
    o = []
    for pair in par["pairs"]:
        o.append(f"<h3 class='subhead'>{esc(pair['solver'])} − {esc(par['reference'])}</h3><p class='note'>"
                 f"{pair['identical']} of {pair['compared']} problems with identical placements (ids, boxes, "
                 f"leaders). Cells show {esc(pair['solver'])} minus {esc(par['reference'])}; non-zero deltas are "
                 "highlighted.</p>")
        keys = [k for k, _l, _f, _d in METRICS if k in pair["max_abs_delta"]]
        o.append("<div class='scroll'><table><tr><th class='l'>problem</th><th>identical</th>"
                 + "".join(f"<th>Δ {esc(META[k][0])}</th>" for k in keys) + "</tr>")
        for row in pair["rows"]:
            cells = []
            for k in keys:
                v = row["deltas"].get(k)
                if k not in row["deltas"]:
                    cells.append("<td>–</td>")
                elif v is None:
                    cells.append("<td class='warn'>differs</td>")
                else:
                    cells.append(f"<td class='warn'>{v:+.4g}</td>" if abs(v) > EPS else "<td>0</td>")
            o.append(f"<tr><td class='l'>{esc(row['scenario'])}/{esc(row['config'])}</td>"
                     f"<td>{'yes' if row['identical'] else '<b>no</b>'}</td>" + "".join(cells) + "</tr>")
        o.append("<tr><th class='l'>max |Δ|</th><th></th>" + "".join(
            f"<th>{pair['max_abs_delta'][k]:.4g}</th>" for k in keys) + "</tr></table></div>")
    status = "; ".join(f"{p['solver']}: {p['identical']} of {p['compared']} identical" for p in par["pairs"])
    return _more("parity", "Implementation parity", esc(status), "".join(o))


def diff_html(diff: dict | None) -> str:
    if not diff:
        return _more("diff", "Changes against the previous release", "no previous results given",
                     "<p class='note'>Give them with <code>--previous path/to/results.json</code>.</p>")
    pv = diff["previous"]
    o = [f"<p class='note'>Previous: {esc(pv.get('generated_at'))}, suite {esc(pv.get('suite'))}, solvers "
         f"{esc(', '.join(pv.get('solvers') or []))}. Threshold {diff['threshold']:.0%} relative (any change from 0 "
         f"counts). <span class='bad'>{diff['regressions']} regressions</span>, <span class='good'>"
         f"{diff['improvements']} improvements</span>; runtimes are not compared here (the performance targets cover "
         "them).</p>"]
    rows = sorted(diff["rows"], key=lambda r: ({"regression": 0, "improvement": 1}.get(r["status"], 2), r["solver"],
                                              r["scenario"], r["config"], r["metric"]))
    if rows:
        o.append("<div class='scroll'><table><tr><th class='l'>solver</th><th class='l'>problem</th>"
                 "<th class='l'>metric</th><th>previous</th><th>now</th><th>change</th><th class='l'>status</th></tr>")
        for r in rows:
            label, f, _d = META[r["metric"]]
            rel = "new ≠ 0" if r["relative"] is None else f"{r['relative']:+.1%}".replace("+", "")
            status = {"regression": "<td class='l bad'>▲ regression</td>",
                      "improvement": "<td class='l good'>▼ improvement</td>"}.get(r["status"],
                                                                                 "<td class='l'>changed</td>")
            o.append(f"<tr><td class='l'>{esc(r['solver'])}</td><td class='l'>{esc(r['scenario'])}/"
                     f"{esc(r['config'])}</td><td class='l'>{esc(label)}</td><td>{fmt(r['old'], f)}</td>"
                     f"<td>{fmt(r['new'], f)}</td><td>{r['delta']:+.4g} ({rel})</td>{status}</tr>")
        o.append("</table></div>")
    else:
        o.append("<p>No metric changed.</p>")
    if diff.get("missing"):
        o.append("<p class='note small'>In the previous run only: " + esc(", ".join(diff["missing"][:50])) + "</p>")
    status = (f"<span class='bad'>{diff['regressions']} regressions</span>, <span class='good'>"
              f"{diff['improvements']} improvements</span>")
    return _more("diff", "Changes against the previous release", status, "".join(o))


BASELINE_METHODS = {
    "naive": "every label top-right of its true shape, no collision handling (bench/solvers/naive.py).",
    "greedy": "reference priority order × the 8 fixed adjacent positions, first free one wins "
              "(bench/solvers/greedy.py).",
    "textalloc": "textalloc.allocate in matplotlib display space: anchors in priority order, marks and points as "
                 "x_scatter/y_scatter with sizes, polylines and outlines as x_lines/y_lines, connector lines on, "
                 "draw_all=False.",
    "adjusttext": "adjust_text with every label at its anchor, mark/obstacle boxes as objects, lines as sampled "
                  "points, arrows on, a fixed iteration budget; never omits labels.",
    "vega-label": "Vega's label transform, headless: base mark = the labeled marks, avoidMarks = obstacle layers "
                  "(raster masks as pixel-run paths), anchors in the problem's position order, sort = priority; no "
                  "leaders.",
    "ggrepel": "geom_text_repel on a png(type='cairo') device of canvas size at 288 dpi; positions read from the "
               "text grobs after grid.force(); obstacles as empty-label points; default max.overlaps.",
    "d3fc": "d3fc-label-layout layoutRemoveOverlaps(layoutGreedy()) in Node: labels in priority order, grown by mark "
            "radius + offset, 8 positions at the anchor, bounds = label area; labels only (no obstacles), no leaders.",
    "echarts": "ECharts scatter series rendered server-side, every label at one position at the offset, "
               "labelLayout.hideOverlap (larger symbols first, then priority order); labels only, no leaders.",
    "d3-labeler": "D3-Labeler's simulated annealing (labeler.js, vendored), 1,000 sweeps, seeded: labels start at "
                  "their anchors; labels and labeled anchors only; never omits labels; leaders to the anchor.",
}


def baselines_html(report: dict) -> str:
    present = [s for s in report["solvers"] if s in BASELINE_METHODS]
    if not present:
        return ""
    o = ["<p class='note'>Every tool is handed the problem's own label boxes (spec §5 measurement, padding "
         "included), canvas pixel coordinates and the items in the problem's priority order (input order; vega-label: "
         "<code>sort</code>); results are scored by the same evaluator and drawn by the same renderer. Details, "
         "parameters and every emulation: <code>bench/baselines/README.md</code>.</p><div class='scroll'><table><tr>"
         "<th class='l'>solver</th><th class='l'>version</th><th class='l'>method</th></tr>"]
    vers = report.get("baseline_versions", {})
    for s in present:
        o.append(f"<tr><td class='l'>{esc(s)}</td><td class='l small'>{esc(vers.get(s, ''))}</td>"
                 f"<td class='l wrap'>{esc(BASELINE_METHODS[s])}</td></tr>")
    o.append("</table></div>")
    skipped = report.get("skipped_solvers") or {}
    if skipped:
        o.append("<p class='note'>Not run (toolchain missing): " + "; ".join(
            f"<b>{esc(k)}</b>: {esc(v)}" for k, v in skipped.items()) + "</p>")
    return _more("baselines", "The other labelers' methods", f"{len(present)} tools and their versions", "".join(o))


def details_chapter(report: dict, plots: dict) -> str:
    lede = ("For the engine's developers: the performance targets and release gates, the runtime of every problem, "
            "whether the implementations agree, what changed against the previous release, and how each other "
            "labeler was run.")
    return (f"<section class='chapter wrap' id='details'><h2>Engineering details</h2><p class='lede'>{esc(lede)}</p>"
            + perf_html(report.get("perf")) + gates_html(report.get("gate")) + runtime_html(report, plots)
            + parity_html(report.get("parity")) + diff_html(report.get("diff")) + baselines_html(report)
            + "</section>")


# ---------------------------------------------------------------------------
# the page
# ---------------------------------------------------------------------------
VIEWER_HTML = f"""<dialog class="viewer" id="viewer" aria-label="Image viewer">
  <div class="stage" id="v-stage"><img id="v-img" alt="" draggable="false"></div>
  <div class="vbar top">
    <div class="vtitle"><p class="vcap" id="v-cap"></p>
      <p class="vhint"><span class="touch">Pinch or double-tap to zoom, swipe for the next labeler or image</span><span
        class="fine">Scroll or double-click to zoom, drag to pan, arrow keys for the next labeler or image: the view
        stays where it is</span></p></div>
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


def load_gallery(out: Path) -> dict | None:
    """The gallery of this run directory (``gallery/gallery.json``), if ``python -m bench.gallery`` wrote one."""
    p = out / "gallery" / "gallery.json"
    if not p.exists():
        return None
    g = read_json(p)
    return g if "sections" in g else None  # a gallery of an earlier version, with its own page


def page(out: Path, report: dict, plots: dict, gallery: dict | None = None) -> str:
    pick = Pick(report["solvers"])
    stats = {s: aggregates(report, s) for s in report["solvers"]}
    by_sc: dict[str, list] = {}
    for r in report["results"]:
        by_sc.setdefault(r["scenario"], []).append(r)
    cmps = {(c["scenario"], c["config"]): c for c in (gallery or {}).get("comparisons", [])}
    gsecs = {s["id"]: s for s in (gallery or {}).get("sections", [])}
    gfigs = (gallery or {}).get("figures", {})
    toc = [("summary", "At a glance", 0)]
    body = [overview_html(report, stats, pick)]
    chapters = list(CHAPTERS)
    known = {sc for *_x, scs in chapters for sc in scs}
    # the gallery's sections no chapter names, then the scenarios no chapter names
    ids = {c[0] for c in chapters} | {"weak"}
    chapters += [(g["id"], g["title"], g.get("sub", ""), "", ()) for g in (gallery or {}).get("sections", [])
                 if g["id"] not in ids]
    rest = tuple(sorted(sc for sc in by_sc if sc not in known))
    if rest:
        chapters.append(("more", "More problems", "", "", rest))
    for cid, title, sub, lede, scs in chapters:
        g = gsecs.get(cid)
        figs = [fig_html(f, gfigs[f["key"]], "gallery/") for f in (g or {}).get("figures", []) if f["key"] in gfigs]
        blocks = []
        for sc in scs:
            if sc in by_sc:
                blocks.append(scenario_html(report, sc, by_sc[sc], cmps, out, pick))
        if not figs and not blocks:
            continue
        extra = ""
        if cid == "scale":
            extra = scale_extra(report, pick)
        toc.append((cid, (g or {}).get("title") or title, 0))
        toc += [(f"sc-{sc}", next((p["title"] for p in report.get("problems", []) if p.get("scenario") == sc
                                   and p.get("title")), sc), 1) for sc in scs if sc in by_sc]
        body.append(chapter_html(cid, (g or {}).get("title") or title, (g or {}).get("sub") or sub,
                                 (g or {}).get("lede") or esc(lede), figs, blocks, extra))
    st = stability_chapter(report, gallery, out, pick)
    if st:
        toc.append(("stability", "Interactive use", 0))
        body.append(st)
    toc.append(("weak", "Where it falls short", 0))
    body.append(weak_chapter(report, gallery, pick))
    toc.append(("details", "Engineering details", 0))
    body.append(details_chapter(report, plots))
    css = (ASSETS / "report.css").read_text(encoding="utf-8")
    js = (ASSETS / "report.js").read_text(encoding="utf-8")
    shown = f" Figures of the gallery: engine at commit <code>{esc(gallery['meta']['commit'])}</code>, " \
            f"{esc(gallery['meta']['date'])}." if gallery else ""
    footer = (f"<footer class='wrap'><p>Times are each labeler's own (median over the runs) unless marked wall; the "
              f"figures' times are the engine's after three warm-up solves.{shown} Hard violations are counted by the "
              "benchmark's evaluator, independent of the labelers.</p><p>Reproduce: <code>python bench/run.py "
              "--suite quick --engine rust/target/release/label-anything --baselines</code>, then <code>python -m "
              "bench.gallery --engine rust/target/release/label-anything --run bench-report</code> "
              f"(<a href='{REPO_URL}/blob/main/bench/README.md'>bench/README.md</a>). Source: <a href='{REPO_URL}'>"
              f"{esc(REPO_URL.removeprefix('https://'))}</a>.</p></footer>")
    return ("<!doctype html>\n<html lang='en'>\n<head>\n<meta charset='utf-8'>\n"
            "<meta name='viewport' content='width=device-width, initial-scale=1'>\n"
            "<title>Label Anything benchmark</title>\n<meta name='description' content='Label Anything and other "
            "labelers on real data: maps, charts, photos, embeddings and networks, side by side and measured.'>\n"
            f"<style>{css}</style>\n</head>\n<body>\n" + header_html(report, gallery, stats, pick)
            + bar_html(toc, pick) + "<main>" + "\n".join(body) + "</main>" + footer + VIEWER_HTML
            + f"\n<script>\n{js}</script>\n</body>\n</html>\n")


def scale_extra(report: dict, pick: Pick) -> str:
    """How the time grows: the runtime panels on shared axes, Label Anything's and those of the labelers shown."""
    panels = sorted(runtime_panels(report, "engine", name), key=lambda p: -1 if p[0] is None else pick.rank(p[0]))
    if not panels:
        return ""
    figs = "".join(f"<div class='chart'{pick.attrs(s) if s else ''}>{svg}</div>" for s, svg in panels)
    return ("<h3 class='subhead'>Time against the number of labels <small>every problem of the run, each labeler's "
            "own timing, log–log; the line follows the sizes of this scenario</small></h3>"
            f"<div class='panels'>{figs}</div>")


def write_page(out: Path, report: dict, plots: dict | None) -> Path:
    """``out/index.html`` with the fonts next to it."""
    (out / "fonts").mkdir(parents=True, exist_ok=True)
    for f in ("NotoSans-Regular.ttf", "NotoSans-Bold.ttf", "OFL.txt"):
        if not (out / "fonts" / f).exists():
            shutil.copy2(paths.FONTS / f, out / "fonts" / f)
    p = out / "index.html"
    p.write_text(page(out, report, plots or {}, load_gallery(out)), encoding="utf-8")
    return p


