"""The benchmark report page, ``bench-report/index.html``: one interactive page for readers.

It shows a run (``results.json``) and, once ``python -m bench.gallery`` has added it, the gallery
(``gallery/gallery.json``: figures of Label Anything with captions, the run's problems drawn as vector images
by every solver, frames of the stability sequences, notes on known limitations).

* **Header**: what was run, and Label Anything's headline numbers next to the range of the baselines.
* **A bar** that stays at the top: the contents, the methods compared with Label Anything (three by
  default, the others on demand: ``?vs=a,b`` in the address, remembered in the browser) and whether the tables
  show every metric or the main ones.
* **Summary**: where each method stands on six measures (a dot on a strip per measure, further right is
  better, the others as grey dots), then, folded, the summary table coloured against the median, the image
  legend and the definitions of the measures.
* **Chapters by kind of data** (maps, charts, photographs and illustrations, embeddings and networks, priority,
  scale): the gallery's figures, then every problem of the run with the methods side by side and their
  numbers (each value coloured against the median of all methods on that problem). Selecting an image opens a
  viewer that zooms and switches between the methods at the same view.
* **Temporal stability** (stability sequences), **limitations** (the gallery's notes and the problems where a
  baseline does better without more violations), and, folded, the **technical details**: performance targets,
  release gates, runtime versus size, implementation parity, changes since the previous release, the baseline
  configurations.

The texts are concise and academic: declarative sentences, one term per concept (method, baseline, item, mark,
placed, omitted), no idioms.

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
                     _mean, _numbers, esc, fmt, heat, heat_attrs, kind, others_better, runtime_panels, runtime_points,
                     runtime_svg, scaling_exponent)

ASSETS = Path(__file__).resolve().parent / "report_assets"
SITE = "https://fabian-beck.github.io/label-anything/"
REPO_URL = "https://github.com/fabian-beck/label-anything"

# ---------------------------------------------------------------------------
# labelers
# ---------------------------------------------------------------------------
NAMES = {"rust": "Label Anything", "ts": "Label Anything (TypeScript)", "wasm": "Label Anything (WebAssembly)",
         "ggrepel": "ggrepel", "adjusttext": "adjustText", "textalloc": "textalloc", "vega-label": "vega-label",
         "echarts": "ECharts", "d3fc": "d3fc", "d3-labeler": "D3-Labeler", "mumtaz2019": "Mumtaz et al.",
         "greedy": "greedy", "naive": "naive"}
APPROACH = {  # solver: (platform, approach) for the table of methods and the tooltips
    "ggrepel": ("R, ggplot2", "force-based repulsion"),
    "adjusttext": ("Python, matplotlib", "iterative repulsion; never omits labels"),
    "textalloc": ("Python, matplotlib", "candidate positions around each point"),
    "vega-label": ("JavaScript, Vega", "candidate positions with an occupancy bitmap"),
    "echarts": ("JavaScript, Apache ECharts", "one position per label; overlapping labels hidden"),
    "d3fc": ("JavaScript, d3fc", "greedy placement with overlap removal"),
    "d3-labeler": ("JavaScript, D3", "simulated annealing; never omits labels"),
    "mumtaz2019": ("Python, reimplementation", "cost-based outlier labeling with leaders (Mumtaz et al., EuroVis "
                                               "2019); never omits labels"),
    "greedy": ("Python, this benchmark", "the first free of 8 positions, in priority order"),
    "naive": ("Python, this benchmark", "every label at the top right; no collision test"),
}
LA_APPROACH = ("candidate positions with costs: greedy placement in priority order, local search and, for small "
               "problems, exact search; hard constraints verified exactly")


ORDER = ("ggrepel", "adjusttext", "textalloc", "vega-label", "echarts", "d3fc", "d3-labeler", "mumtaz2019", "greedy",
         "naive")
DEFAULT_VS = ("ggrepel", "adjusttext", "textalloc")
"""Compared with Label Anything by default: the most used of the tools (R and Python); the others on demand."""


def name(s: str) -> str:
    if s in NAMES:
        return NAMES[s]
    return f"Label Anything ({s})" if implementation(s) else s


def about(s: str) -> str:
    """One line on a method, its platform and approach (tooltips)."""
    if implementation(s):
        return f"{name(s)}: {LA_APPROACH}"
    plat, appr = APPROACH.get(s, ("", ""))
    return f"{name(s)} ({plat}): {appr}" if plat else name(s)


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


def _fnum(num: int | None) -> str:
    return f"<span class='fnum'>Figure {num}.</span> " if num else ""


def count(n: int, noun: str) -> str:
    """``n`` and the noun, plural unless ``n`` is 1: "1 problem", "12 problems"."""
    return f"{n:,} {noun}{'' if n == 1 else 's'}"


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
        badge = "<span class='badge'>densest region · select for the full image</span>"
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
    "placed_rate": ("placed", "Share of items with a placed label."),
    "usable_rate": ("usable", "Share of items whose label remains after conflicts are resolved in priority order: a "
                              "label over a mark, a hard obstacle or the canvas edge is removed; of two conflicting "
                              "labels, the more important one is kept. Methods that never omit labels but let them "
                              "overlap score low."),
    "hard_violations": ("hard violations", "Violations of hard constraints: labels overlapping labels, marks or hard "
                                           "obstacles; labels outside the canvas; crossing leaders; leaders through "
                                           "labels or marks; and Label Anything's clearance rules for leaders."),
    "hard_conflicts": ("conflicts", "Hard violations that apply to every method: overlaps and crossings, without "
                                    "Label Anything's clearance rules."),
    "clarity_unclear_rate": ("unclear", "Share of placed labels without a leader whose own mark is not unambiguously "
                                        "the nearest data point: another point is nearer, or less than 0.2 em "
                                        "farther away."),
    "ambiguity_rate": ("ambiguous", "Share of placed labels nearer to another item than to their own (a coarser "
                                    "criterion than unclear)."),
    "points_covered_rate": ("points covered", "Share of data points (marks and unlabeled points) covered by the "
                                              "label of another item."),
    "labels_close_rate": ("labels too close", "Share of placed labels less than 0.4 em from the nearest other "
                                              "label; such labels are read as one."),
    "priority_inversions": ("inversions", "Omitted items for which a position free of all more important labels "
                                          "existed; a less important label occupies it."),
    "ndcg_at_k": ("NDCG@k", "Normalized discounted cumulative gain of the placed labels with respect to priority; "
                            "1 if exactly the most important items are labeled."),
    "leader_crossings": ("crossings", "Pairs of crossing leaders."),
    "leader_near_crossings": ("near crossings", "Pairs of leaders closer than 4 px without crossing; they are "
                                                "perceived as crossing."),
    "leader_mark_touches": ("leader–mark", "Leaders passing within 1.5 px of the mark of another item."),
    "adjacent_gap_abs_mean": ("gap px", "Mean absolute deviation of adjacent labels from the intended distance to "
                                        "their mark, in px; 0 is best."),
    "position_rank_mean": ("pos. rank", "Mean preference rank of the chosen position (0 top, 1 right, 2 bottom, "
                                        "3 left, 4–7 corners)."),
    "region_coverage": ("regions labeled", "Share of populated regions (cells 8 em wide) with at least one label; "
                                           "a measure of spatial spread."),
    "soft_coverage_mean": ("soft cov.", "Mean share of label area over soft obstacles, e.g. lines that may be "
                                        "covered at a cost."),
    "engine_ms": ("engine ms", "Runtime reported by the method, median over runs."),
    "wall_ms": ("wall ms", "Wall-clock time of a complete run, including process start-up and I/O; median and "
                           "95th percentile."),
    "peak_mb": ("peak MB", "Peak memory of the method's process."),
    "displacement_mean_px": ("displacement", "Mean label displacement between consecutive frames, relative to the "
                                             "anchor, in px."),
    "flip_rate": ("flip rate", "Share of labels that change side between consecutive frames."),
    "nesting_rate": ("nesting rate", "Share of zoom-in steps after which all labels still in view remain placed."),
    "nesting_fraction_mean": ("nesting fraction", "Mean share of labels that remain placed after a zoom-in step."),
}


def tip(key: str) -> str:
    g = GLOSSARY.get(key)
    return f' title="{esc(g[1])}"' if g else ""





def heat_key(where: str, detail: bool = False) -> str:
    """The legend of the table colours: each value against the median of ``where``."""
    more = (" (counts, times and memory as ratios; small deviations grey; uncoloured columns unranked)"
            if detail else "")
    return (f"<div class='key heat'><span class='lead'><b>Colour scale</b>&nbsp;relative to the median of "
            f"{esc(where)}{more}:</span>"
            + "".join(f"<span><i class='sw {HEAT_CLASS[c]}'></i>{HEAT_TEXT[c]}</span>" for c in HEAT_CLASS)
            + "<span><b>bold</b>&nbsp;best value</span></div>")


def marks_key() -> str:
    """How to read the images: label boxes, marks, leaders, omitted items and the violations drawn over them."""
    mark, lead, omit = render.MARK_STROKE, render.LEADER, render.UNPLACED
    base = [
        f'<svg width="44" height="18" viewBox="0 0 44 18" aria-hidden="true"><rect width="44" height="18" '
        f'fill="{render.OBST}"/><rect x="3" y="2" width="38" height="14" fill="#fff" '
        f'fill-opacity="{render.LABEL_FILL_OPACITY}"/><text x="22" y="13" font-size="10" text-anchor="middle" '
        f'fill="{render.LABEL_TEXT}" font-family="Noto Sans, sans-serif">Label</text></svg>label box (as reported '
        "by the method)",
        f'<svg width="56" height="18" viewBox="0 0 56 18" aria-hidden="true"><circle cx="6" cy="12" r="4" '
        f'fill="{render.MARK_FILL}" stroke="{mark}"/><circle cx="17" cy="12" r="4" fill="#e15759" '
        f'fill-opacity="0.75" stroke="{render._darker("#e15759")}"/><polyline points="21,10 40,4 54,4" '
        f'fill="none" stroke="{lead}" stroke-width="1.5"/></svg>item mark (in its data colour, if any) and leader',
        f'<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M4 4 L14 14 M14 4 L4 14" '
        f'stroke="{omit}" stroke-width="2.2"/></svg>item with omitted label',
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
def contents_html(toc: list[tuple[str, str, str, int]]) -> str:
    """The contents: the chapters and their sections, numbered."""
    parts: list[tuple[tuple, list]] = []
    for e in toc:
        if e[3] == 0:
            parts.append((e, []))
        elif e[3] == 1 and parts:
            parts[-1][1].append(e)

    def link(e: tuple) -> str:
        return f"<a href='#{esc(e[0])}'><span class='num'>{e[1]}</span>{esc(e[2])}</a>"
    items = "".join(f"<li>{link(c)}" + (f"<ul>{''.join(f'<li>{link(s)}</li>' for s in subs)}</ul>" if subs else "")
                    + "</li>" for c, subs in parts)
    return f"<nav class='contents' aria-label='Contents'><p class='h'>Contents</p><ul>{items}</ul></nav>"


def header_html(report: dict, gallery: dict | None, abstract: str, toc: list[tuple[str, str, str, int]]) -> str:
    """The title, the run, the abstract and the contents."""
    m = report.get("machine") or {}
    machine = ", ".join(x for x in (m.get("cpu"), f"{m['cores']} cores" if m.get("cores") else "") if x)
    commit = (gallery or {}).get("meta", {}).get("commit")
    meta = (f"Suite: <b>{esc(report['suite'])}</b>. Generated {esc(report['generated_at'])}"
            + (f"; engine commit <code>{esc(commit)}</code>" if commit else "")
            + (f"; {esc(machine)}" if machine else "") + ".")
    return (f"<header class='top wrap'><p class='eyebrow'><a href='{SITE}'>Label Anything</a> · benchmark report</p>"
            "<h1>Comparison of label placement methods</h1>"
            f"<p class='small note' style='margin:0'>{meta}</p><p class='abstract'><b>Abstract.</b> {abstract}</p>"
            f"{contents_html(toc)}</header>")




# ---------------------------------------------------------------------------
# the bar
# ---------------------------------------------------------------------------
def bar_html(toc: list[tuple[str, str, str, int]], pick: Pick) -> str:
    links = "".join(f"<a href='#{esc(i)}'{' class=sub' if lvl else ''}><span class='num'>{num}</span>{esc(t)}</a>"
                    for i, num, t, lvl in toc if lvl < 2)
    me = f"<span class='me'>{esc(name(pick.ref))}</span>" if pick.ref else ""
    vs = "".join(f"<button type='button' class='chip' data-solver='{esc(s)}' data-default='"
                 f"{'1' if s in pick.on else '0'}' aria-pressed='{'true' if s in pick.on else 'false'}' "
                 f"title='{esc(about(s))}'>{esc(name(s))}</button>" for s in pick.sel)
    more = ("<button type='button' class='lnk' id='vs-all'>all</button>"
            "<button type='button' class='lnk' id='vs-reset'>reset</button>") if pick.sel else ""
    return (f"<div class='bar'><div class='wrap'><details class='toc'><summary>Contents</summary><nav>{links}</nav>"
            f"</details><div class='vs' role='group' aria-label='Methods compared'>{me}"
            f"<span class='lbl'>{'vs' if pick.ref else 'methods'}</span>{vs}{more}</div>"
            "<label class='allm'><input type='checkbox' id='allm'> all metrics</label></div></div>")


# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------
STAND = (  # key of ``aggregates``, title, how it aggregates, format, direction (+1: more is better), log scale
    ("usable_rate", "Usable labels", "mean", "{:.1%}", +1, False),
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
    o = ["<div class='scroll'><table class='stand'><thead><tr><th>method</th>"
         + "".join(f"<th{tip(k)}>{esc(title)}<span class='dir'>{esc(how)} · better →</span></th>"
                   for k, title, how, *_ in cols) + "</tr>"
         "<tr class='axis'><td></td>" + "".join(
             f"<td><span class='pad'></span><span class='ends'><span>{esc(_end(lo if d > 0 else hi, f, lg))}</span>"
             f"<span>{esc(_end(hi if d > 0 else lo, f, lg))}</span></span></td>"
             for _k, _t, _h, f, d, lg, lo, hi, _p, _fl in cols) + "</tr></thead><tbody>"]
    for s in rows:
        st = stats[s]
        n = st["problems"]
        note = count(n, "problem") if n == n_problems else f"{n} of {count(n_problems, 'problem')}"
        cells = []
        for key, _t, _h, f, _d, _l, _lo, _hi, pos, field in cols:
            v = st.get(key)
            if v is None:
                cells.append("<td class='v'>–</td>")
                continue
            text = dur(v) if f is None else fmt(v, f)
            cells.append(f"<td class='v'><span>{esc(text)}</span>{_strip(field, pos(v))}</td>")
        cls = " class='la'" if s == pick.ref or implementation(s) else ""
        o.append(f"<tr{cls}{pick.attrs(s)}><td class='solver' title='{esc(about(s))}'>{esc(name(s))}"
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
    tips = {"scaling": f"Exponent k: slope of log runtime over log number of items ({SCALING_SCENARIO})"}
    solvers = sorted(report["solvers"], key=pick.rank)
    o = ["<div class='scroll'><table><tr><th class='l'>method</th><th class='l'>type</th>"
         + "".join(f"<th title='{esc(tips[k])}'>{esc(h)}</th>" if k in tips else f"<th{tip(k)}>{esc(h)}</th>"
                   for k, h, _f, _d, _l in SUMMARY_COLS) + "</tr>"]
    rows = [stats[s] for s in solvers]
    attrs = heat_attrs(rows, [(k, f, d, lg) for k, _h, f, d, lg in SUMMARY_COLS])
    for s, row, a in zip(solvers, rows, attrs):
        k = kind(s)
        typ = NAMES["rust"] if k == "label-anything" else k
        o.append(f"<tr class='{'la' if k == 'label-anything' else ''}'{pick.attrs(s)}><td class='l solver' "
                 f"title='{esc(s)}'>{esc(name(s))}</td><td class='l'>{esc(typ)}</td>"
                 + "".join(f"<td{a[c]}>{fmt(row[c], f)}</td>" for c, _h, f, _d, _l in SUMMARY_COLS) + "</tr>")
    o.append("</table></div>")
    return "".join(o)





# ---------------------------------------------------------------------------
# chapters
# ---------------------------------------------------------------------------
CHAPTERS = (  # id, title, subtitle, lede, scenarios; the gallery's section of the same id gives title and lede
    ("maps", "Maps", "airports and points of interest",
     "Dense, unevenly distributed point sets in which major locations take precedence: the busiest airports "
     "worldwide and in Europe, and points of interest on a city map.", ("05-airports", "06-city-pois")),
    ("charts", "Charts", "scatterplots, bubble charts, line charts",
     "Labels adjacent to their marks and clear of axes, legends and other labels: scatterplot outliers, Gapminder "
     "bubbles, genes in a volcano plot and line ends.",
     ("03-gapminder", "02-volcano", "09-line-end-labels", "01-software-metrics", "13-outlier-paper")),
    ("images", "Photographs and illustrations", "area anchors, leaders, margin labels",
     "Regions of photographs and drawings, labeled inside, adjacent or in the margin with leaders.",
     ("08-illustration",)),
    ("graphs", "Embeddings and networks", "clusters and nodes",
     "Topic clusters of a text embedding with 50,000 points; nodes of graphs.", ("04-embedding", "07-node-link")),
    ("priority", "Priority", "selection under limited space",
     "When not all labels fit, priority determines which ones are placed.", ("12-priority",)),
    ("scale", "Scale", "hundreds to thousands of labels",
     "Airports at ten times their real density (jittered copies of real airports) at increasing problem sizes; "
     "runtime as a function of the number of labels.", ("10-stress",)),
)


def fig_html(f: dict, m: dict, prefix: str, num: int | None = None) -> str:
    """A figure of the gallery, numbered ``num``: the image, its problem, title, caption, numbers and settings."""
    scenario, _, config = f["key"].partition("/")
    cls = "fig" + (" wide" if f.get("wide") else "") + (" limit" if f.get("limit") else "")
    kind_ = "SVG" if m["img"].endswith(".svg") else "image"
    st = (f"<details class='set'><summary>Problem settings</summary><pre>{esc(m['settings_json'])}</pre>"
          "</details>") if m.get("settings_json") else ""
    return (f"<figure class='{cls}' id='{esc(f['key'].replace('/', '--'))}'>"
            + shot(m, f["title"], f"{f['title']} · {scenario} · {config}", prefix)
            + f"<figcaption><div class='srcrow'><span class='src'>{esc(scenario)} · {esc(config)}</span>"
              f"<a href='{esc(prefix + m['img'])}' download>{kind_}</a></div><h4>{_fnum(num)}{esc(f['title'])}</h4>"
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
    head = (f"<figcaption class='ch'><span title='{esc(about(s))}'>{esc(name(s))}</span>"
            f"{note}</figcaption>")
    if "summary" not in r:
        why = r.get("skipped") or r.get("error") or "no result"
        return (f"<figure class='card{la}'{pick.attrs(s)}>{head}<p class='naw'>"
                f"{'Not applicable' if 'skipped' in r else 'Failed'}: {esc(why)}</p></figure>")
    if cell and cell.get("img"):
        img = shot(cell, f"{name(s)}: {caption}", f"{name(s)} · {caption}", "gallery/", crop=crop, canvas=canvas)
    elif r.get("image"):
        size = _image_size(out / r["image"])
        m = {"img": r["image"], "size": size, "full": r["image"], "full_size": size}
        img = shot(m, f"{name(s)}: {caption}", f"{name(s)} · {caption}", crop=crop, canvas=canvas)
    else:
        img = "<p class='naw'>No image in this run.</p>"
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
    head = (("<th class='l'>problem</th>" if many else "") + "<th class='l'>method</th><th class='x'>items</th>"
            + "".join(f"<th{tip(k)}>{esc(META[k][0])}</th>" for k in KEY_COLS)
            + f"<th{tip('engine_ms')}>time</th>"
            + "".join(f"<th class='x'{tip(k)}>{esc(META[k][0])}</th>" for k in extra)
            + f"<th class='x'{tip('wall_ms')}>wall ms (median / p95)</th><th class='x'{tip('peak_mb')}>peak MB</th>"
              "<th class='x' title='Deterministic: identical result in every run'>det.</th>"
              "<th class='x l'>notes</th>")
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


def scenario_html(report: dict, sc: str, rows: list[dict], cmps: dict, out: Path, pick: Pick,
                  num: str = "") -> str:
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
    whole = ("<button type='button' class='lnk whole' aria-pressed='false'>show full images</button>"
             if any(crops.values()) else "")
    num_ = f"<span class='num'>{num}</span>" if num else ""
    return (f"<article class='scenario' id='sc-{esc(sc)}'><header><h4>{num_}{esc(title)}</h4>"
            f"<span class='src'>{esc(sc)}"
            f"</span>{whole}</header>{bar}{''.join(panes)}{metrics_table(rows, pick, configs)}</article>")





# ---------------------------------------------------------------------------
# temporal stability
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
    o = ["<div class='scroll'><table id='sequences'><tr><th class='l'>sequence</th><th class='l'>method</th>"
         f"<th>frames</th><th{tip('displacement_mean_px')}>displacement px (mean / median)</th>"
         f"<th{tip('flip_rate')}>flip rate</th><th{tip('nesting_rate')}>nesting rate</th>"
         f"<th{tip('nesting_fraction_mean')}>nesting fraction</th><th>added</th><th>removed</th>"
         "<th>time (median frame)</th></tr>"]
    for s in seqs:
        opt = s.get("options") or {}
        tp = (f"{opt['iter_lim']} iterations per frame (comparison budget of this sequence); "
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


def stability_fig(st: dict, prefix: str, num: int | None = None) -> str:
    n = st.get("n_frames") or len(st["frames"])
    frames = "".join(shot(f, f"{st.get('kind', 'Sequence')}, frame {f['frame']} of {n}",
                          f"{st.get('title', st['sequence'])} · frame {f['frame']} of {n}", prefix)
                     for f in st["frames"])
    return (f"<figure class='fig wide' id='seq-{esc(st['sequence'])}'><div class='frames' "
            f"data-group='seq-{esc(st['sequence'])}'>{frames}</div><figcaption><div class='srcrow'><span class='src'>"
            f"{esc(st['scenario'])} · {esc(st['sequence'])} · frames "
            + ", ".join(str(f["frame"]) for f in st["frames"]) + f" of {n}</span></div>"
            f"<h4>{_fnum(num)}{esc(st.get('title', st['sequence']))}</h4><p>{st.get('text', '')}</p>"
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
    return ("<details class='more'><summary><b>Frames of all methods</b><span>first, middle and last frame per "
            "sequence</span></summary><div class='in'>" + "".join(o) + "</div></details>")





# ---------------------------------------------------------------------------
# limitations
# ---------------------------------------------------------------------------
def better_table(report: dict, pick: Pick, rows: list[dict] | None = None) -> str:
    """The problems and measures on which a baseline does better than Label Anything (``others_better``)."""
    if not pick.ref:
        return ""
    rows = others_better(report, pick.ref) if rows is None else rows
    if not rows:
        return ""
    o = ["<div class='scroll'><table><tr><th class='l'>problem</th><th class='l'>measure</th>"
         f"<th>{esc(name(pick.ref))}</th><th class='l'>baseline</th></tr>"]
    for r in rows:
        f = META[r["metric"]][1]
        measure = GLOSSARY.get(r["metric"], (META[r["metric"]][0],))[0]
        o.append(f"<tr><td class='l'><a href='#sc-{esc(r['scenario'])}'>{esc(scenario_title(report, r['scenario']))}"
                 f"</a> <span class='src'>{esc(r['config'])}</span></td><td class='l'{tip(r['metric'])}>{esc(measure)}"
                 f"</td><td>{fmt(r['ref_value'], f)}</td><td class='l'>{esc(name(r['solver']))}: "
                 f"{fmt(r['value'], f)}</td></tr>")
    o.append("</table></div>")
    return "".join(o)




# ---------------------------------------------------------------------------
# technical details
# ---------------------------------------------------------------------------
def _more(id_: str, title: str, status: str, body: str) -> str:
    return (f"<details class='more' id='{esc(id_)}'><summary><b>{esc(title)}</b><span>{status}</span></summary>"
            f"<div class='in'>{body}</div></details>")


def perf_html(perf: dict | None) -> str:
    if not perf or not perf.get("rows"):
        return _more("perf", "Performance targets", "not measured in this run",
                     "<p class='note'>Requires <code>--perf</code>; measured for the solvers rust, wasm and ts "
                     "only.</p>")
    m = perf.get("machine", {})
    threads = perf.get("threads")
    thr = ("one thread (as for the targets, brief §5.8)" if threads == 1 else
           "all cores" if threads == 0 else f"{threads} threads" if threads else "the engine's default threads")
    o = [f"<p class='note'>Median of {perf['runs']} runs of the engine-reported time "
         f"(<code>stats.runtime_ms</code>; raster target: <code>stats.phases_ms.prepare</code>), excluding process "
         f"overhead; native engine on {thr}. Machine: {esc(m.get('cpu', '?'))}, "
         f"{esc(m.get('cores', '?'))} cores, {esc(m.get('platform', ''))}. Problems: "
         "<code>python -m bench.perf generate</code> (deterministic).</p>",
         "<div class='scroll'><table><tr><th class='l'>problem</th><th class='l'>implementation</th>"
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
                     "<p class='note'>Requires <code>--gate</code>, or <code>python -m bench.gates results.json "
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
    status = ("<b class='good'>✓ all gates passed</b>" if gate["passed"] else "<b class='bad'>✗ gates failed</b>")
    return _more("gates", "Release gates", status, "".join(o))


def runtime_html(report: dict, plots: dict) -> str:
    if not plots:
        return _more("runtime", "Runtime versus problem size", "no runtimes to plot", "")
    o = ["<p class='note'>One dot per problem (median over runs); log–log axes shared by all panels. Lines connect "
         "the sizes of scenario 10 (stress) when several sizes ran. Label Anything implementations keep their colour "
         "in all panels; each other panel shows one baseline (grey) with the reference implementation. Tooltips "
         "identify the problem.</p>"]
    for which, title in (("engine", "Engine-reported runtime (stats.runtime_ms: the solve or the tool call)"),
                         ("wall", "Wall-clock time per run (including process start-up and I/O)")):
        if which not in plots:
            continue
        o.append(f"<h3 class='subhead'>{esc(title)}</h3><div class='chart'>{runtime_svg(report, which)}</div>"
                 f"<p class='small note'>Static file: <a href='{esc(plots[which])}'>{esc(plots[which])}</a></p>")
    pts_e = runtime_points(report, "engine")
    pts_w = runtime_points(report, "wall")
    o.append("<details><summary class='small'>Table view</summary><div class='scroll'><table><tr><th class='l'>"
             "method</th><th class='l'>problem</th><th>items</th><th>engine ms</th><th>wall ms</th></tr>")
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
    return _more("runtime", "Runtime versus problem size", "all methods; engine-reported and wall-clock time",
                 "".join(o))


def parity_html(par: dict | None) -> str:
    if not par or not par.get("pairs"):
        return _more("parity", "Implementation parity", "requires Rust and TypeScript or WebAssembly in one run",
                     "<p class='note'>Requires the Rust implementation and at least one other (solvers rust and ts "
                     "or wasm) in the same run.</p>")
    o = []
    for pair in par["pairs"]:
        o.append(f"<h3 class='subhead'>{esc(pair['solver'])} − {esc(par['reference'])}</h3><p class='note'>"
                 f"{pair['identical']} of {pair['compared']} problems with identical placements (ids, boxes, "
                 f"leaders). Cells show {esc(pair['solver'])} minus {esc(par['reference'])}; non-zero differences "
                 "are highlighted.</p>")
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
        return _more("diff", "Changes since the previous release", "no previous results",
                     "<p class='note'>Requires <code>--previous path/to/results.json</code>.</p>")
    pv = diff["previous"]
    o = [f"<p class='note'>Previous run: {esc(pv.get('generated_at'))}; suite {esc(pv.get('suite'))}; methods "
         f"{esc(', '.join(pv.get('solvers') or []))}. Threshold: {diff['threshold']:.0%} relative change (any change "
         f"from 0 counts). <span class='bad'>{diff['regressions']} regressions</span>, <span class='good'>"
         f"{diff['improvements']} improvements</span>. Runtimes are excluded (covered by the performance "
         "targets).</p>"]
    rows = sorted(diff["rows"], key=lambda r: ({"regression": 0, "improvement": 1}.get(r["status"], 2), r["solver"],
                                              r["scenario"], r["config"], r["metric"]))
    if rows:
        o.append("<div class='scroll'><table><tr><th class='l'>method</th><th class='l'>problem</th>"
                 "<th class='l'>metric</th><th>previous</th><th>current</th><th>change</th><th class='l'>status</th>"
                 "</tr>")
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
        o.append("<p class='note small'>Previous run only: " + esc(", ".join(diff["missing"][:50])) + "</p>")
    status = (f"<span class='bad'>{diff['regressions']} regressions</span>, <span class='good'>"
              f"{diff['improvements']} improvements</span>")
    return _more("diff", "Changes since the previous release", status, "".join(o))


BASELINE_METHODS = {
    "naive": "Every label at the top right of its shape; no collision handling (bench/solvers/naive.py).",
    "greedy": "Items in priority order; each label at the first free one of 8 adjacent positions "
              "(bench/solvers/greedy.py).",
    "textalloc": "textalloc.allocate in matplotlib display space: anchors in priority order; marks and points as "
                 "x_scatter/y_scatter with sizes; polylines and outlines as x_lines/y_lines; connector lines on; "
                 "draw_all=False.",
    "adjusttext": "adjust_text with every label starting at its anchor; mark and obstacle boxes as objects; lines as "
                  "sampled points; arrows on; fixed iteration budget; never omits labels.",
    "vega-label": "Vega label transform, headless: base mark = the labeled marks; avoidMarks = obstacle layers "
                  "(raster masks as pixel-run paths); anchors in the problem's position order; sort = priority; no "
                  "leaders.",
    "ggrepel": "geom_text_repel on a png(type='cairo') device of canvas size at 288 dpi; positions read from the "
               "text grobs after grid.force(); obstacles as points with empty labels; default max.overlaps.",
    "d3fc": "d3fc-label-layout layoutRemoveOverlaps(layoutGreedy()) in Node: labels in priority order, enlarged by "
            "mark radius plus offset; 8 positions at the anchor; bounds = label area; avoids labels only (no "
            "obstacles); no leaders.",
    "echarts": "ECharts scatter series rendered server-side; every label at one position at the offset; "
               "labelLayout.hideOverlap (larger symbols first, then priority order); avoids labels only; no leaders.",
    "d3-labeler": "D3-Labeler simulated annealing (labeler.js, vendored), 1,000 sweeps, seeded; labels start at "
                  "their anchors; avoids labels and labeled anchors only; never omits labels; leaders to the anchor.",
    "mumtaz2019": "Mumtaz et al. (EuroVis 2019), reimplemented: labels in priority order, each at the lowest-cost "
                  "of 20 × 100 positions on rings around its point (radius + 30 % per ring); cost terms: covered "
                  "outliers, points and labels, label and leader buffers, leader length, outward position; "
                  "never omits labels; leaders to the box centre.",
}


def baselines_html(report: dict) -> str:
    present = [s for s in report["solvers"] if s in BASELINE_METHODS]
    if not present:
        return ""
    o = ["<p class='note'>Each baseline receives the problem's label boxes (measured per spec §5, padding "
         "included), canvas pixel coordinates and the items in priority order (as input order; vega-label: "
         "<code>sort</code>). All results are scored by the same evaluator and drawn by the same renderer. "
         "Parameters and emulations: <code>bench/baselines/README.md</code>.</p><div class='scroll'><table><tr>"
         "<th class='l'>baseline</th><th class='l'>version</th><th class='l'>configuration</th></tr>"]
    vers = report.get("baseline_versions", {})
    for s in present:
        o.append(f"<tr><td class='l'>{esc(s)}</td><td class='l small'>{esc(vers.get(s, ''))}</td>"
                 f"<td class='l wrap'>{esc(BASELINE_METHODS[s])}</td></tr>")
    o.append("</table></div>")
    skipped = report.get("skipped_solvers") or {}
    if skipped:
        o.append("<p class='note'>Not run (toolchain missing): " + "; ".join(
            f"<b>{esc(k)}</b>: {esc(v)}" for k, v in skipped.items()) + "</p>")
    return _more("baselines", "Configuration of each baseline", f"{count(len(present), 'baseline')}", "".join(o))


# ---------------------------------------------------------------------------
# the report: numbering, questions, per-problem tables, findings
# ---------------------------------------------------------------------------
class Doc:
    """The numbering of the report: chapters, sections and subsections (1, 1.1, 1.1.1; appendices A, A.1), tables and
    figures, in the order the page shows them. ``toc`` lists the sections for the contents."""

    def __init__(self):
        self.toc: list[tuple[str, str, str, int]] = []  # (id, number, title, level)
        self.at = [0, 0, 0]
        self.appendix = False
        self.tables = 0
        self.figures = 0

    def add(self, id_: str, title: str, level: int) -> str:
        """Numbers a chapter (level 0), section (1) or subsection (2), lists it and returns its number."""
        self.at[level] += 1
        self.at[level + 1:] = [0] * (2 - level)
        head = chr(ord("A") + self.at[0] - 1) if self.appendix else str(self.at[0])
        num = ".".join([head] + [str(n) for n in self.at[1:level + 1]])
        self.toc.append((id_, num, title, level))
        return num

    def start_appendix(self) -> None:
        self.appendix, self.at = True, [0, 0, 0]

    def number(self, id_: str) -> str:
        """The number of the listed section ``id_``, "" if there is none."""
        return next((num for i, num, _t, _l in self.toc if i == id_), "")

    def chapter(self, id_: str, title: str) -> str:
        """The opening tag of a chapter and its numbered heading."""
        num = self.add(id_, title, 0)
        return f"<section class='chapter wrap' id='{esc(id_)}'><h2><span class='num'>{num}</span>{esc(title)}</h2>"

    def section(self, id_: str, title: str, sub: str = "") -> str:
        """The numbered heading of a section."""
        num = self.add(id_, title, 1)
        small = f" <small>{esc(sub)}</small>" if sub else ""
        return f"<h3 class='subhead' id='{esc(id_)}'><span class='num'>{num}</span>{esc(title)}{small}</h3>"

    def table(self, text: str) -> str:
        """The caption of the next table, placed above it; ``text`` is HTML."""
        self.tables += 1
        return f"<p class='cap'><b>Table {self.tables}.</b> {text}</p>"

    def figure(self, text: str) -> str:
        """The caption of the next figure, placed below it; ``text`` is HTML."""
        self.figures += 1
        return f"<p class='cap'><b>Figure {self.figures}.</b> {text}</p>"

    def figure_number(self) -> int:
        """The number of the next figure, for a figure that sets its own caption."""
        self.figures += 1
        return self.figures

    def next_figures(self, k: int) -> str:
        """How the text names the next ``k`` figures: "Figure 4", "Figures 4 and 5", "Figures 4–7"."""
        a, b = self.figures + 1, self.figures + k
        return f"Figure {a}" if k == 1 else f"Figures {a} and {b}" if k == 2 else f"Figures {a}–{b}"


QUESTIONS = (  # id, aspect, question
    ("Q1", "Validity", "Do the methods avoid hard violations, such as overlapping labels and crossing leaders?"),
    ("Q2", "Completeness", "How many items receive a usable label, and are the most important items among them?"),
    ("Q3", "Clarity", "Is each label unambiguously associated with its item?"),
    ("Q4", "Efficiency", "How long does labeling take, and how does the runtime grow with the problem size?"),
    ("Q5", "Stability", "How far do labels move between the frames of an interactive view?"),
)
MEASURES = {  # the per-problem tables: key, label, format, direction (+1: higher is better), log scale
    "usable_rate": ("Usable labels", "{:.1%}", +1, False),
    "hard_violations": ("Hard violations", "{:d}", -1, True),
    "placed_rate": ("Placed labels", "{:.1%}", +1, False),
    "clarity_unclear_rate": ("Unclear labels", "{:.1%}", -1, False),
    "points_covered_rate": ("Points covered", "{:.1%}", -1, False),
    "labels_close_rate": ("Labels too close", "{:.1%}", -1, False),
    "priority_inversions": ("Inversions", "{:d}", -1, True),
    "ndcg_at_k": ("NDCG@k", "{:.3f}", +1, False),
    "time_ms": ("Runtime", "{:,.1f}", -1, True),
}
MAIN_MEASURES = ("usable_rate", "placed_rate", "hard_violations", "hard_conflicts", "clarity_unclear_rate",
                 "points_covered_rate", "labels_close_rate", "priority_inversions", "ndcg_at_k", "engine_ms")
FINDINGS = ("usable_rate", "hard_violations", "clarity_unclear_rate", "points_covered_rate", "labels_close_rate",
            "priority_inversions", "time_ms")


def _join(items: list[str]) -> str:
    """"a", "a and b", "a, b and c"."""
    if len(items) < 2:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


def _pct(v: float | None) -> str:
    return "–" if v is None else f"{v:.1%}"


def _between(r: tuple | None, f) -> str:
    """A range of values as ``f`` formats them, "12.2%–46.3%", or one value."""
    if not r:
        return "–"
    a, b = f(r[0]), f(r[1])
    return a if a == b else f"{a}–{b}"


def _any(n: int) -> str:
    """"any of the 11 problems"; "the one problem"."""
    return "the one problem" if n == 1 else f"any of the {n} problems"


def _on(w: int, n: int, what: str, negated: str) -> str:
    """The clause ``what`` (such as "it was the fastest method") for ``w`` of ``n`` problems; ``negated`` for none."""
    if w == 0:
        return f"{negated} on {_any(n)}"
    return f"{what} on " + ("the one problem" if n == 1 else f"all {n} problems" if w == n else f"{w} of {n} problems")


def per_problem(report: dict) -> dict[tuple[str, str], dict[str, dict]]:
    """Every result of the run by problem and solver: {(scenario, config): {solver: result}}."""
    by: dict[tuple[str, str], dict[str, dict]] = {}
    for r in report["results"]:
        by.setdefault((r["scenario"], r["config"]), {})[r["solver"]] = r
    return by


def chapters(report: dict) -> list[tuple[str, str, str, str, list[str]]]:
    """The data types of the run's problems: (id, title, subtitle, lede, the run's scenarios); the scenarios that no
    data type names under "Other problems"."""
    present = {r["scenario"] for r in report["results"]}
    known = {sc for *_x, scs in CHAPTERS for sc in scs}
    out = [(cid, title, sub, lede, [sc for sc in scs if sc in present]) for cid, title, sub, lede, scs in CHAPTERS]
    out.append(("more", "Other problems", "", "", sorted(sc for sc in present if sc not in known)))
    return [c for c in out if c[4]]


def scenario_title(report: dict, sc: str) -> str:
    return next((p["title"] for p in report.get("problems", []) if p.get("scenario") == sc and p.get("title")), sc)


def problems_of(report: dict) -> list[tuple[str, str, str, str, dict]]:
    """Every problem of the run in the order of the report: (data type, scenario, config, scenario title, the
    problem's entry in ``report["problems"]``)."""
    entries = {(p["scenario"], p["config"]): p for p in report.get("problems", [])}
    order = list(entries)
    out = []
    for _cid, chapter, _sub, _lede, scs in chapters(report):
        for sc in scs:
            cfgs = sorted({r["config"] for r in report["results"] if r["scenario"] == sc},
                          key=lambda c, sc=sc: (order.index((sc, c)) if (sc, c) in entries else len(order), c))
            out += [(chapter, sc, cfg, scenario_title(report, sc), entries.get((sc, cfg), {})) for cfg in cfgs]
    return out


def _value(r: dict, key: str) -> float | None:
    """A result's value of ``key``; ``time_ms`` is the runtime the solver reports."""
    return engine_ms(r) if key == "time_ms" else (r.get("summary") or {}).get(key)


def _best(values: dict[str, float], f: str, d: int, log: bool) -> set[str]:
    """The solvers whose value the tables mark as the best: the best of ``values`` (direction ``d``, compared as the
    format ``f`` shows them) when it is better than the median of all of them."""
    solvers = list(values)
    marks, _mid = heat([values[s] for s in solvers], f, d, log)
    return {s for s, m in zip(solvers, marks) if m and m[1]}


def matrix(report: dict, pick: Pick, keys: list[str], tid: str) -> str:
    """Per measure of ``keys`` a table with a row per problem, grouped by data type, and a column per method; every
    value is coloured against the median of all methods on that problem, and the last row counts the problems on
    which a method has the best value. Several measures are tabs."""
    probs, by, cols = problems_of(report), per_problem(report), pick.order
    panes, tabs = [], []
    for k, key in enumerate(keys):
        label, f, d, lg = MEASURES[key]
        head = "<tr><th class='l'>problem</th>" + "".join(
            f"<th{' class=la' if implementation(s) else ''}{pick.attrs(s)} title='{esc(about(s))}'>{esc(name(s))}</th>"
            for s in cols) + "</tr>"
        best, rows, group = dict.fromkeys(cols, 0), [], None
        for chapter, sc, cfg, title, _p in probs:
            if chapter != group:
                group = chapter
                rows.append(f"<tr class='grp'><th class='l'>{esc(chapter)}</th>"
                            + "".join(f"<td{pick.attrs(s)}></td>" for s in cols) + "</tr>")
            rs = by.get((sc, cfg), {})
            vals = [_value(rs[s], key) if s in rs and "summary" in rs[s] else None for s in cols]
            attrs = heat_attrs([{key: v} for v in vals], [(key, f, d, lg)])
            cells = []
            for s, v, a in zip(cols, vals, attrs):
                r, at = rs.get(s), a.get(key, "")
                best[s] += " best" in at
                if r is None:
                    cells.append(f"<td{pick.attrs(s)}></td>")
                elif "summary" not in r:
                    why = r.get("skipped") or r.get("error") or ""
                    cells.append(f"<td class='na' title='{esc(why)}'{pick.attrs(s)}>"
                                 f"{'n/a' if 'skipped' in r else 'error'}</td>")
                else:
                    cells.append(f"<td{at}{pick.attrs(s)}>{esc(dur(v) if key == 'time_ms' else fmt(v, f))}</td>")
            rows.append(f"<tr><td class='l'><a href='#sc-{esc(sc)}'>{esc(title)}</a> <span class='src'>{esc(cfg)}"
                        "</span></td>" + "".join(cells) + "</tr>")
        foot = ("<tr class='sum'><th class='l'>best value (problems)</th>"
                + "".join(f"<td{pick.attrs(s)}>{best[s]}</td>" for s in cols) + "</tr>")
        pid = f"{tid}-{key}"
        panes.append(f"<div class='cfg' id='{esc(pid)}' role='tabpanel'><div class='scroll'><table class='matrix'>"
                     f"{head}{''.join(rows)}{foot}</table></div></div>")
        tabs.append(f"<button type='button' class='tab' role='tab' aria-controls='{esc(pid)}' "
                    f"aria-selected='{'true' if k == 0 else 'false'}'>{esc(label)}</button>")
    bar = f"<div class='tabs' role='tablist' aria-label='Measures'>{''.join(tabs)}</div>" if len(keys) > 1 else ""
    return bar + "".join(panes)


def sequence_means(report: dict, ref: str, base: list[str]) -> dict | None:
    """Mean displacement and flip rate over the stability sequences: Label Anything's (``me``), the range of the
    baselines' means and the number of sequences; None without a sequence of Label Anything."""
    per: dict[str, dict[str, list[float]]] = {}
    for s in report.get("sequences") or []:
        m = s.get("metrics") or {}
        for k in ("displacement_mean_px", "flip_rate"):
            if isinstance(m.get(k), (int, float)):
                per.setdefault(s["solver"], {}).setdefault(k, []).append(m[k])
    if ref not in per:
        return None
    mean = {s: {k: sum(v) / len(v) for k, v in d.items()} for s, d in per.items()}
    out = {"me": mean[ref], "n": len({s["sequence"] for s in report["sequences"]
                                     if s.get("solver") == ref and s.get("metrics")})}
    for k in ("displacement_mean_px", "flip_rate"):
        v = [mean[s][k] for s in base if k in mean.get(s, {})]
        out[k] = (min(v), max(v)) if v else None
    return out


def findings(report: dict, stats: dict[str, dict], pick: Pick) -> dict | None:
    """The numbers that answer the questions: Label Anything's aggregates (``me``), the range of the baselines'
    aggregates (``range``), on how many problems Label Anything has the best value among itself and the baselines
    (``wins``: (wins, problems), ties included), how many baselines produced hard violations, and the stability
    sequences (``seq``). None without results of Label Anything."""
    ref = pick.ref
    if ref is None or not stats[ref]["problems"]:
        return None
    base = [s for s in report["solvers"] if not implementation(s) and stats[s]["problems"]]
    by = per_problem(report)
    wins, ranges = {}, {}
    for key in FINDINGS:  # the best value as the per-problem tables mark it: among all methods, above the median
        _label, f, d, lg = MEASURES[key]
        w = n = 0
        for rs in by.values():
            vals = {s: _value(r, key) for s, r in rs.items() if "summary" in r}
            vals = {s: v for s, v in vals.items() if isinstance(v, (int, float))}
            if ref in vals and len(vals) > 1:
                n += 1
                w += ref in _best(vals, f, d, lg)
        wins[key] = (w, n)
        v = [stats[s][key] for s in base if stats[s].get(key) is not None]
        ranges[key] = (min(v), max(v)) if v else None
    return {"me": stats[ref], "base": base, "wins": wins, "range": ranges,
            "violating": sum(1 for s in base if stats[s]["violating"]), "seq": sequence_means(report, ref, base)}


def answer(fd: dict | None, q: str) -> str:
    """The finding on question ``q`` (Q1–Q5; QP: priority) as HTML sentences; "" without the numbers."""
    if not fd:
        return ""
    me, rg, wins, nb = fd["me"], fd["range"], fd["wins"], len(fd["base"])
    if q == "Q1":
        hv, n = me["hard_violations"] or 0, me["problems"]
        s = (f"Label Anything produced no hard violations on {_any(n)}." if hv == 0 else
             f"Label Anything produced {hv:,} hard violations on {me['violating']} of {count(n, 'problem')}.")
        if nb:
            s += (f" {fd['violating']} of the {count(nb, 'baseline')} produced hard violations on at least one "
                  "problem." if fd["violating"] else f" None of the {count(nb, 'baseline')} produced hard violations.")
        return s
    if q == "Q2":
        w, n = wins["usable_rate"]
        s = (f"On average, {_pct(me['usable_rate'])} of the items received a usable label from Label Anything "
             f"(baselines: {_between(rg['usable_rate'], _pct)}, each over the problems it ran).")
        best = _on(w, n, "It had the highest share of usable labels",
                   "It did not have the highest share of usable labels")
        return s + (f" {best}." if n else "")
    if q == "QP":
        inv = me.get("priority_inversions")
        if inv is None:
            return ""
        what = "no priority inversions" if inv == 0 else f"{inv:,} priority inversions"
        return (f"It produced {what} (baselines: "
                f"{_between(rg['priority_inversions'], lambda v: f'{v:,}')} in total).")
    if q == "Q3":
        w, n = wins["clarity_unclear_rate"]
        s = (f"On average, {_pct(me['clarity_unclear_rate'])} of the labels placed by Label Anything were unclear "
             f"(baselines: {_between(rg['clarity_unclear_rate'], _pct)})")
        best = _on(w, n, "its share of unclear labels was the lowest", "its share of unclear labels was not the lowest")
        s += f"; {best}." if n else "."
        if me.get("points_covered_rate") is not None and me.get("labels_close_rate") is not None:
            s += (f" Its labels covered {_pct(me['points_covered_rate'])} of the data points (baselines: "
                  f"{_between(rg['points_covered_rate'], _pct)}), and {_pct(me['labels_close_rate'])} of them were "
                  f"too close to another label (baselines: {_between(rg['labels_close_rate'], _pct)}).")
        return s
    if q == "Q4":
        if me.get("time_ms") is None:
            return ""
        w, n = wins["time_ms"]
        s = (f"The median runtime of Label Anything per problem was {dur(me['time_ms'])} (baselines: "
             f"{_between(rg['time_ms'], dur)})")
        best = _on(w, n, "it was the fastest method", "it was not the fastest method")
        s += f"; {best}." if n else "."
        if me.get("scaling") is not None:
            s += (" On the problems of the stress scenario, its runtime grew approximately as "
                  f"n<sup>{me['scaling']:.2f}</sup> with the number of items n.")
        return s
    if q == "Q5":
        sq = fd.get("seq")
        if not sq:
            return ""
        d, fl = sq["me"].get("displacement_mean_px"), sq["me"].get("flip_rate")
        parts = []
        if d is not None:
            parts.append(f"labels placed by Label Anything moved {d:.1f} px per frame on average (baselines: "
                         f"{_between(sq['displacement_mean_px'], lambda v: f'{v:.1f} px')})")
        if fl is not None:
            parts.append(f"{_pct(fl)} of them changed sides between consecutive frames (baselines: "
                         f"{_between(sq['flip_rate'], _pct)})")
        return (f"Across {count(sq['n'], 'sequence')}, " + ", and ".join(parts) + ".") if parts else ""
    return ""


def abstract_text(report: dict, fd: dict | None, doc: Doc, n_better: int) -> str:
    """The abstract: what was compared, the main findings, and where the limitations are discussed."""
    probs = {(r["scenario"], r["config"]) for r in report["results"]}
    scen = {sc for sc, _ in probs}
    nb = len([s for s in report["solvers"] if not implementation(s)])
    where = count(len(probs), "problem") + (f" from {len(scen)} scenarios" if len(scen) != len(probs) else "")
    s = (f"This report compares Label Anything with {count(nb, 'baseline method')} on {where} built from open data: "
         "maps, charts, photographs, embeddings and networks. All methods receive identical inputs, and one evaluator "
         "scores all results.")
    if fd:
        me, rg = fd["me"], fd["range"]
        hv = me["hard_violations"] or 0
        s += " Label Anything produced " + ("no hard violations" if hv == 0 else f"{hv:,} hard violations")
        s += (f"; {fd['violating']} of the {count(len(fd['base']), 'baseline')} produced hard violations on at least "
              "one problem." if fd["base"] else ".")
        s += (f" On average, {_pct(me['usable_rate'])} of the items received a usable label (baselines: "
              f"{_between(rg['usable_rate'], _pct)}, each over the problems it ran), and "
              f"{_pct(me['clarity_unclear_rate'])} of the placed labels were unclear (baselines: "
              f"{_between(rg['clarity_unclear_rate'], _pct)}).")
        if me.get("time_ms") is not None:
            s += (f" The median runtime per problem was {dur(me['time_ms'])} (baselines: "
                  f"{_between(rg['time_ms'], dur)}).")
    lim = doc.number("limitations")
    if lim:
        which = ("the one problem–measure combination in which a baseline performs better" if n_better == 1 else
                 f"the {n_better} problem–measure combinations in which a baseline performs better")
        s += (f" Section {lim} lists {which}, together with known weaknesses and the limitations of the benchmark."
              if n_better else f" Section {lim} discusses known weaknesses and the limitations of the benchmark.")
    return s


# ---------------------------------------------------------------------------
# the chapters
# ---------------------------------------------------------------------------
def _cases(gallery: dict | None) -> list[dict]:
    """The gallery's sections that the case studies show (priority and the limitations have their own places)."""
    figs = (gallery or {}).get("figures", {})
    return [s for s in (gallery or {}).get("sections", []) if s["id"] not in ("priority", "weak")
            and any(f["key"] in figs for f in s.get("figures", []))]


def introduction(doc: Doc, report: dict, gallery: dict | None) -> str:
    qs = [q for q in QUESTIONS if q[0] != "Q5" or report.get("sequences")]
    items = "".join(f"<li><b>{q} {esc(a)}.</b> {esc(t)}</li>" for q, a, t in qs)
    cases = " presents case studies of Label Anything," if _cases(gallery) else ""
    return (doc.chapter("introduction", "Introduction")
            + "<div class='prose'><p>Label placement positions text labels next to graphical items such that the "
              "labels are legible, free of overlaps and unambiguously associated with their items. Label Anything is "
              "a label placement engine for maps, charts, photographs and diagrams. This report compares it with "
              f"established label placement methods on problems built from open data and addresses "
              f"{count(len(qs), 'question')}:</p>"
            + f"<ul class='qs'>{items}</ul><p>The report first describes the benchmark design. It then reports the "
              f"results per question and per problem,{cases} discusses the limitations and summarizes the findings. "
              "The appendices document release engineering, runtime measurements and the reproduction of the "
              "results.</p></div></section>")


def methods_table(report: dict, gallery: dict | None, pick: Pick) -> str:
    vers = report.get("baseline_versions") or {}
    commit = (gallery or {}).get("meta", {}).get("commit")
    rows = []
    for s in pick.order:
        impl = implementation(s)
        if impl:
            plat = {"rust": "Rust", "ts": "TypeScript", "wasm": "WebAssembly (from Rust)"}.get(impl, impl)
            appr = LA_APPROACH if s == pick.ref else "the same algorithm in another implementation"
            ver = f"commit {commit}" if commit else ""
        else:
            plat, appr = APPROACH.get(s, ("", ""))
            ver = vers.get(s, "")
        rows.append(f"<tr{' class=la' if impl else ''}><td class='l solver'>{esc(name(s))}</td>"
                    f"<td class='l'>{esc(plat)}</td><td class='l wrap'>{esc(appr)}</td>"
                    f"<td class='l'>{esc(ver) or '–'}</td></tr>")
    return ("<div class='scroll'><table><tr><th class='l'>method</th><th class='l'>platform</th>"
            "<th class='l'>approach</th><th class='l'>version</th></tr>" + "".join(rows) + "</table></div>")


def problems_table(report: dict) -> str:
    items = {(r["scenario"], r["config"]): r["n_items"] for r in report["results"] if r.get("n_items")}
    rows, group = [], None
    for chapter, sc, cfg, title, p in problems_of(report):
        if chapter != group:
            group = chapter
            rows.append(f"<tr class='grp'><th class='l' colspan='3'>{esc(chapter)}</th></tr>")
        n = p.get("n_items") or items.get((sc, cfg))
        rows.append(f"<tr><td class='l'><a href='#sc-{esc(sc)}'>{esc(title)}</a> <span class='src'>{esc(cfg)}"
                    f"</span></td><td>{f'{n:,}' if n else '–'}</td><td class='l wrap'>"
                    f"{esc(p.get('description') or '')}</td></tr>")
    return ("<div class='scroll'><table class='matrix'><tr><th class='l'>problem</th><th>items</th>"
            "<th class='l'>description</th></tr>" + "".join(rows) + "</table></div>")


def measures_table(keys) -> str:
    def better(k: str) -> str:
        d = META[k][2] if k in META else -1
        return "higher" if d > 0 else "lower" if d < 0 else "–"
    rows = "".join(f"<tr><td class='l'>{esc(GLOSSARY[k][0])}</td><td class='l wrap'>{esc(GLOSSARY[k][1])}</td>"
                   f"<td class='l'>{better(k)}</td></tr>" for k in keys if k in GLOSSARY)
    return ("<div class='scroll'><table><tr><th class='l'>measure</th><th class='l'>definition</th>"
            "<th class='l'>better</th></tr>" + rows + "</table></div>")


def design(doc: Doc, report: dict, gallery: dict | None, pick: Pick) -> str:
    probs = problems_of(report)
    scen = {sc for _c, sc, *_r in probs}
    o = [doc.chapter("design", "Benchmark design")]
    # methods
    nb = len([s for s in pick.sel if not implementation(s)])
    ni = len([s for s in pick.sel if implementation(s)])
    shown = [name(s) for s in pick.sel if s in pick.on]
    why = (", the most widely used tools for R and Python" if pick.on == set(DEFAULT_VS) & set(pick.sel) else "")
    text = (f"Table {doc.tables + 1} lists the compared methods: Label Anything and {count(nb, 'baseline method')}"
            + (f", and {count(ni, 'further implementation')} of Label Anything" if ni else "") + ".")
    if shown:
        text += (f" By default, the tables and figures show Label Anything together with {_join(shown)}{why}; the bar "
                 "at the top adds or removes methods.")
    o += [doc.section("methods", "Methods"), f"<div class='prose'><p>{esc(text)}</p></div>",
          doc.table("Compared methods."), methods_table(report, gallery, pick), baselines_html(report)]
    # problems
    synth = (" The problems of the stress scenario consist of jittered copies of real airports."
             if "10-stress" in scen else "")
    text = (f"The {report.get('suite', '')} suite comprises {count(len(probs), 'problem')} from "
            f"{count(len(scen), 'scenario')}, built from open data (Table {doc.tables + 1}). Each problem specifies "
            "the canvas, the items with their label texts and marks, the obstacles, such as axes, legends and raster "
            f"images, and the placement options.{synth}")
    o += [doc.section("problems", "Problems"), f"<div class='prose'><p>{esc(text)}</p></div>",
          doc.table("Problems of the run, grouped by data type."), problems_table(report)]
    # measures
    o += [doc.section("measures", "Measures"),
          f"<div class='prose'><p>Table {doc.tables + 1} defines the main measures. All measures are computed from "
          "the drawn results, and the engine's default thresholds apply to every method; "
          f"<a href='{REPO_URL}/blob/main/bench/README.md#evaluator-metrics'>bench/README.md</a> gives the full "
          "definitions.</p></div>",
          doc.table("Main measures."), measures_table(MAIN_MEASURES),
          "<details class='more'><summary><b>Further measures</b><span>leaders, positions, coverage, memory, "
          "stability</span></summary><div class='in'>"
          + measures_table([k for k in GLOSSARY if k not in MAIN_MEASURES]) + "</div></details>"]
    # procedure
    m = report.get("machine") or {}
    machine = ", ".join(x for x in (m.get("cpu"), f"{m['cores']} cores" if m.get("cores") else "", m.get("platform"))
                        if x)
    runs = report.get("runs") or 1
    o += [doc.section("procedure", "Procedure"),
          "<div class='prose'><p>Every method receives the same input per problem: the label boxes (measured as "
          "specified in spec §5, padding included), the item marks, the obstacles and the priority order, which is "
          "passed as input order where a method has no priority parameter. Features that a baseline does not support "
          "are emulated where possible and otherwise omitted; the tables mark affected results with ≈ and name the "
          "emulation in a tooltip.</p><p>One evaluator (<code>bench/eval</code>) scores every result with exact "
          "geometry. One renderer (<code>bench/render.py</code>) draws every result and marks the violations that "
          f"the measures count (Figure {doc.figures + 1}). Each problem was solved "
          f"{'once' if runs == 1 else f'{runs} times'} per method; runtimes are the medians of the times that the "
          "methods report, and wall-clock times additionally include process start-up and input/output."
          + (f" Machine: {esc(machine)}." if machine else "") + "</p><p>Tables colour each value by its deviation "
          "from the median of all methods on the same problem: blue is better, red is worse, grey is close to the "
          "median, and the best value is bold.</p></div>",
          marks_key(), doc.figure("Markers in the result images: label boxes, marks and leaders as each method placed "
                                  "them, and the violations that the measures count."),
          "</section>"]
    return "".join(o)


def results(doc: Doc, report: dict, gallery: dict | None, stats: dict, pick: Pick, fd: dict | None,
            out: Path) -> str:
    n = len({(r["scenario"], r["config"]) for r in report["results"]})
    gsec = {s["id"]: s for s in (gallery or {}).get("sections", [])}
    gfigs = (gallery or {}).get("figures", {})
    key = heat_key("all methods on the same problem")
    o = [doc.chapter("results", "Results"),
         "<div class='prose'><p>This chapter answers the questions with the aggregated results of every method and "
         "with the values per problem. Aggregated values are means or sums over the problems that each method ran; "
         "a method that could not run a problem is compared on fewer problems. In the per-problem tables, rows are "
         "problems, grouped by data type, and columns are methods; the bar at the top selects the methods shown, and "
         "the last row counts the problems on which a method has the best value.</p></div>"]
    # overview
    o += [doc.section("summary", "Overview"),
          f"<div class='prose'><p>Figure {doc.figures + 1} places every method on six measures, aggregated over the "
          f"problems that the method ran; on every scale, right is better. Table {doc.tables + 1} lists all aggregated "
          "values.</p></div>",
          standings_html(stats, pick, n),
          doc.figure("Aggregated results per method. In each strip, the dark dot marks the method of the row and the "
                     "grey dots mark the other methods. The column headings show the definitions as tooltips."),
          f"<details class='more'><summary><b>Table {doc.tables + 1}</b><span>all aggregated values</span></summary>"
          "<div class='in'>"
          + doc.table("Aggregated values per method: means of the rates, sums of the counts and runtimes, the largest "
                      "peak memory, and the exponent k of the runtime's growth with the number of items.")
          + heat_key("the column", detail=True) + summary_table(report, stats, pick) + "</div></details>"]
    # validity and completeness
    o += [doc.section("validity", "Validity and completeness", "Q1, Q2"),
          f"<div class='prose'><p>{answer(fd, 'Q1')} {answer(fd, 'Q2')} Table {doc.tables + 1} lists the values per "
          "problem.</p></div>",
          doc.table("Usable labels, hard violations and placed labels per problem and method; the tabs select the "
                    "measure."), key,
          matrix(report, pick, ["usable_rate", "hard_violations", "placed_rate"], "mx-valid")]
    # clarity
    o += [doc.section("clarity", "Clarity", "Q3"),
          f"<div class='prose'><p>{answer(fd, 'Q3')} Table {doc.tables + 1} lists the values per problem.</p></div>",
          doc.table("Unclear labels, data points covered and labels too close per problem and method; the tabs "
                    "select the measure."), key,
          matrix(report, pick, ["clarity_unclear_rate", "points_covered_rate", "labels_close_rate"], "mx-clear")]
    # priority
    sec = gsec.get("priority") or {}
    pf = [f for f in sec.get("figures", []) if f["key"] in gfigs]
    text = (f"{answer(fd, 'QP')} Table {doc.tables + 1} lists the priority inversions and the normalized discounted "
            "cumulative gain per problem.")
    o += [doc.section("priorities", "Priority", "Q2"), f"<div class='prose'><p>{text}</p></div>",
          doc.table("Priority inversions and NDCG@k per problem and method; the tabs select the measure."), key,
          matrix(report, pick, ["priority_inversions", "ndcg_at_k"], "mx-prio")]
    if pf:
        verb = "shows" if len(pf) == 1 else "show"
        o += [f"<div class='prose'><p>{doc.next_figures(len(pf))} {verb} the omission modes of Label Anything. "
              f"{sec.get('lede') or ''}</p></div>",
              "<div class='figs' data-group='figs-priority'>"
              + "".join(fig_html(f, gfigs[f["key"]], "gallery/", doc.figure_number()) for f in pf) + "</div>"]
    # efficiency
    panels = runtime_panels_html(report, pick)
    text = f"{answer(fd, 'Q4')} Table {doc.tables + 1} lists the runtime per problem"
    o += [doc.section("efficiency", "Efficiency", "Q4"),
          f"<div class='prose'><p>{text}" + (f"; Figure {doc.figures + 1} shows how the runtime grows with the "
                                             "number of items." if panels else ".") + "</p></div>",
          doc.table("Runtime per problem and method, as reported by the method (median over the runs)."), key,
          matrix(report, pick, ["time_ms"], "mx-time")]
    if panels:
        o += [panels, doc.figure("Runtime against the number of items, one panel per method, on shared log–log axes; "
                                 "lines connect the sizes of the stress scenario. Appendix B lists the engine-reported "
                                 "and wall-clock times.")]
    # stability
    if report.get("sequences"):
        sf = (gallery or {}).get("stability", [])
        text = ("In interactive maps and animated graphs, every frame is labeled anew; labels that move or change "
                "sides between frames are hard to track. Label Anything solves each frame with the previous result as "
                f"warm start. {answer(fd, 'Q5')} Table {doc.tables + 1} lists the measures per sequence and method.")
        if sf:
            text += f" {doc.next_figures(len(sf))} {'shows' if len(sf) == 1 else 'show'} frames of Label Anything."
        o += [doc.section("stability", "Stability", "Q5"), f"<div class='prose'><p>{text}</p></div>",
              doc.table("Stability measures per sequence and method."),
              heat_key("all methods on the same sequence"), sequence_table(report, pick)]
        o += [stability_fig(st, "gallery/", doc.figure_number()) for st in sf]
        o.append(frames_by_labeler(report, out, pick))
    o.append("</section>")
    return "".join(o)


def by_problem(doc: Doc, report: dict, gallery: dict | None, out: Path, pick: Pick) -> str:
    cmps = {(c["scenario"], c["config"]): c for c in (gallery or {}).get("comparisons", [])}
    by_sc: dict[str, list] = {}
    for r in report["results"]:
        by_sc.setdefault(r["scenario"], []).append(r)
    o = [doc.chapter("by-problem", "Results by problem"),
         "<div class='prose'><p>This chapter shows the result of every method on every problem, grouped by data type. "
         "Each problem shows the images of the selected methods and a table of their measures. Large canvases show "
         "their densest region; selecting an image opens it in full, and the arrow keys switch between the methods "
         "at the same view.</p></div>", heat_key("all methods on the same problem")]
    for cid, title, sub, lede, scs in chapters(report):
        o.append(doc.section(cid, title, sub))
        if lede:
            o.append(f"<p class='lede'>{esc(lede)}</p>")
        for sc in scs:
            num = doc.add(f"sc-{sc}", scenario_title(report, sc), 2)
            o.append(scenario_html(report, sc, by_sc[sc], cmps, out, pick, num))
    o.append("</section>")
    return "".join(o)


def case_studies(doc: Doc, gallery: dict | None) -> str:
    secs = _cases(gallery)
    if not secs:
        return ""
    figs = gallery["figures"]
    o = [doc.chapter("cases", "Case studies"),
         "<div class='prose'><p>The figures of this chapter show Label Anything on selected problems of the full "
         "suite, solved with each problem's settings and the engine's defaults. They illustrate features that the "
         "comparison does not cover: priority tiers and type sizes, area anchors, margin labels with leaders, and "
         "obstacles read from raster images. Each caption lists the evaluator's measures; the settings of the problem "
         "are folded below it.</p></div>"]
    for s in secs:
        o.append(doc.section(f"case-{s['id']}", s["title"], s.get("sub") or ""))
        if s.get("lede"):
            o.append(f"<p class='lede'>{s['lede']}</p>")
        o.append(f"<div class='figs' data-group='figs-{esc(s['id'])}'>"
                 + "".join(fig_html(f, figs[f["key"]], "gallery/", doc.figure_number()) for f in s["figures"]
                           if f["key"] in figs) + "</div>")
    o.append("</section>")
    return "".join(o)


FEATURES = (  # the last part of an unsupported feature's key (bench/baselines) and the feature
    ("obstacles", "avoiding marks and obstacles"),
    ("leaders", "leader lines"),
    ("style", "leader styles other than straight lines"),
    ("boundary", "labels in the margin"),
    ("internal", "labels inside their marks"),
    ("positions", "alternative positions per label"),
    ("variants", "text variants (wrapped or shortened)"),
    ("priority", "the priority order"),
    ("omission", "omitting labels"),
)


def benchmark_limits(doc: Doc, report: dict, pick: Pick) -> str:
    """What limits the comparison: features that baselines lack, results that are missing, the size of the suite and
    how the runtimes were measured."""
    unsup: dict[str, dict[str, str]] = {}  # feature: {solver: what the baseline reports}
    emul: dict[str, int] = {}
    for r in report["results"]:
        b = r.get("baseline") or {}
        for u in b.get("unsupported", []):
            key, _, msg = u.partition(": ")
            unsup.setdefault(key.rsplit("-", 1)[-1], {}).setdefault(r["solver"], msg or key)
        if b.get("emulations"):
            emul[r["solver"]] = emul.get(r["solver"], 0) + 1
    na = [r for r in report["results"] if "summary" not in r]
    items, tables = [], []
    if unsup or emul:
        items.append(f"Several baselines do not support all features of the problems (Table {doc.tables + 1}). Their "
                     "inputs are emulated where possible, for example obstacles as sampled points, and the tables mark "
                     "results with emulated inputs with ≈.")
        cols = [s for s in pick.order if s in emul or any(s in d for d in unsup.values())]
        known = [k for k, _t in FEATURES if k in unsup] + sorted(k for k in unsup if k not in dict(FEATURES))
        rows = "".join(f"<tr><td class='l'>{esc(dict(FEATURES).get(k, k))}</td>" + "".join(
            f"<td title='{esc(unsup[k][s])}'>✗</td>" if s in unsup[k] else "<td></td>" for s in cols) + "</tr>"
            for k in known)
        rows += ("<tr class='sum'><th class='l'>problems with emulated inputs</th>"
                 + "".join(f"<td>{emul.get(s, 0)}</td>" for s in cols) + "</tr>")
        tables.append(doc.table("Features of the problems that the baselines do not support (✗; the tooltip gives "
                                "the baseline's reason), and the number of problems with emulated inputs.")
                      + "<div class='scroll'><table class='matrix'><tr><th class='l'>feature</th>"
                      + "".join(f"<th>{esc(name(s))}</th>" for s in cols) + "</tr>" + rows + "</table></div>")
    if na:
        items.append(f"{count(len(na), 'result')} {'is' if len(na) == 1 else 'are'} not available "
                     f"(Table {doc.tables + 1}); the aggregated values of the affected methods cover fewer problems.")
        rows = "".join(f"<tr><td class='l solver'>{esc(name(r['solver']))}</td><td class='l'><a href='#sc-"
                       f"{esc(r['scenario'])}'>{esc(scenario_title(report, r['scenario']))}</a> <span class='src'>"
                       f"{esc(r['config'])}</span></td><td class='l wrap'>"
                       f"{esc(r.get('skipped') or r.get('error') or '')}</td></tr>"
                       for r in sorted(na, key=lambda r: (pick.rank(r["solver"]), r["scenario"], r["config"])))
        tables.append(doc.table("Results that are not available, with the reason.")
                      + "<div class='scroll'><table><tr><th class='l'>method</th><th class='l'>problem</th>"
                        "<th class='l'>reason</th></tr>" + rows + "</table></div>")
    m = report.get("machine") or {}
    machine = ", ".join(x for x in (m.get("cpu"), f"{m['cores']} cores" if m.get("cores") else "") if x)
    runs = report.get("runs") or 1
    probs = len({(r["scenario"], r["config"]) for r in report["results"]})
    items.append(f"The {report.get('suite', '')} suite comprises {count(probs, 'problem')}; each problem was solved "
                 f"{'once' if runs == 1 else f'{runs} times'} per method on one machine"
                 + (f" ({esc(machine)})" if machine else "") + ".")
    return ("<div class='prose'><ul class='qs'>" + "".join(f"<li>{x}</li>" for x in items) + "</ul></div>"
            + "".join(tables))


def limitations(doc: Doc, report: dict, gallery: dict | None, pick: Pick) -> tuple[str, int]:
    """The limitations chapter and the number of problem–measure combinations in which a baseline performs better."""
    rows = others_better(report, pick.ref) if pick.ref else []
    o = [doc.chapter("limitations", "Limitations")]
    if pick.ref:
        o.append(doc.section("better", "Problems on which a baseline performs better"))
        if rows:
            o += [f"<div class='prose'><p>Table {doc.tables + 1} lists the problems and measures for which a baseline "
                  "achieves a value better than that of Label Anything by more than one percentage point, with at "
                  "least as many usable labels and no more hard violations.</p></div>",
                  doc.table("Problems and measures on which a baseline performs better than Label Anything."),
                  better_table(report, pick, rows)]
        else:
            o.append("<div class='prose'><p>No baseline achieves a value better than that of Label Anything by more "
                     "than one percentage point with at least as many usable labels and no more hard violations."
                     "</p></div>")
    sec = next((s for s in (gallery or {}).get("sections", []) if s["id"] == "weak"), None) or {}
    figs = (gallery or {}).get("figures", {})
    wf = [f for f in sec.get("figures", []) if f["key"] in figs]
    notes = (gallery or {}).get("notes") or []
    if wf or notes:
        text = sec.get("lede") or "Known weaknesses of the current defaults and models."
        if wf:
            text += (f" {doc.next_figures(len(wf))} {'shows' if len(wf) == 1 else 'show'} an example"
                     + ("; the notes below describe further cases." if notes else "."))
        o += [doc.section("weak", "Known weaknesses of Label Anything"), f"<div class='prose'><p>{text}</p></div>"]
        if wf:
            o.append("<div class='figs' data-group='figs-weak'>"
                     + "".join(fig_html(f, figs[f["key"]], "gallery/", doc.figure_number()) for f in wf) + "</div>")
        if notes:
            o.append("<div class='notes'>" + "".join(f"<div class='notecard'><h4>{esc(n['title'])}</h4><p>{n['html']}"
                                                     "</p></div>" for n in notes) + "</div>")
    o += [doc.section("threats", "Limitations of the benchmark"), benchmark_limits(doc, report, pick), "</section>"]
    return "".join(o), len(rows)


def conclusion(doc: Doc, report: dict, fd: dict | None) -> str:
    if not fd:
        return ""
    items = []
    for q, aspect, _t in QUESTIONS:
        if q == "Q5" and not report.get("sequences"):
            continue
        a = answer(fd, q) + (" " + answer(fd, "QP") if q == "Q2" else "")
        if a.strip():
            items.append(f"<li><b>{q} {esc(aspect)}.</b> {a}</li>")
    lim = doc.number("limitations")
    return (doc.chapter("conclusion", "Conclusion")
            + "<div class='prose'><p>The results answer the questions of the introduction as follows.</p>"
            + f"<ul class='qs'>{''.join(items)}</ul>"
            + (f"<p>Section {lim} lists the cases in which a baseline performs better, the known weaknesses of Label "
               "Anything and the limitations of the benchmark.</p>" if lim else "")
            + "</div></section>")


def appendices(doc: Doc, report: dict, plots: dict) -> str:
    doc.start_appendix()
    suite = esc(report.get("suite") or "quick")
    return (doc.chapter("details", "Release engineering")
            + "<div class='prose'><p>Results that concern the development of Label Anything: its performance targets, "
              "the release gates, the agreement between its implementations, and the changes since the previous "
              "release.</p></div>"
            + perf_html(report.get("perf")) + gates_html(report.get("gate")) + parity_html(report.get("parity"))
            + diff_html(report.get("diff")) + "</section>"
            + doc.chapter("measurements", "Runtime measurements")
            + "<div class='prose'><p>The runtime of every method on every problem, as reported by the method and as "
              "wall-clock time, against the number of items.</p></div>" + runtime_html(report, plots) + "</section>"
            + doc.chapter("reproduction", "Reproduction")
            + f"<div class='prose'><p>The run is reproduced with <code>python bench/run.py --suite {suite} --engine "
              "rust/target/release/label-anything --baselines</code>, followed by <code>python -m bench.gallery "
              "--engine rust/target/release/label-anything --run bench-report</code> for the figures of Label "
              f"Anything; <a href='{REPO_URL}/blob/main/bench/README.md'>bench/README.md</a> describes the "
              "requirements and the data sources. Times are the medians of the method-reported times unless marked "
              "as wall-clock time; the times in the figures of Label Anything are engine-reported after three warm-up "
              "runs.</p></div></section>")


def runtime_panels_html(report: dict, pick: Pick) -> str:
    """The runtime panels on shared axes: Label Anything's and one per baseline, hidden with the baseline."""
    panels = sorted(runtime_panels(report, "engine", name), key=lambda p: -1 if p[0] is None else pick.rank(p[0]))
    if not panels:
        return ""
    return ("<div class='panels'>" + "".join(f"<div class='chart'{pick.attrs(s) if s else ''}>{svg}</div>"
                                             for s, svg in panels) + "</div>")




# ---------------------------------------------------------------------------
# the page
# ---------------------------------------------------------------------------
VIEWER_HTML = f"""<dialog class="viewer" id="viewer" aria-label="Image viewer">
  <div class="stage" id="v-stage"><img id="v-img" alt="" draggable="false"></div>
  <div class="vbar top">
    <div class="vtitle"><p class="vcap" id="v-cap"></p>
      <p class="vhint"><span class="touch">Pinch or double-tap to zoom; swipe to switch images</span><span
        class="fine">Scroll or double-click to zoom; drag to pan; arrow keys switch images and keep the
        view</span></p></div>
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
    """The report: abstract and contents, then the chapters in order — introduction, benchmark design, results by
    question, results by problem, case studies, limitations, conclusion — and the appendices."""
    pick = Pick(report["solvers"])
    stats = {s: aggregates(report, s) for s in report["solvers"]}
    fd = findings(report, stats, pick)
    doc = Doc()
    body = [introduction(doc, report, gallery), design(doc, report, gallery, pick),
            results(doc, report, gallery, stats, pick, fd, out), by_problem(doc, report, gallery, out, pick),
            case_studies(doc, gallery)]
    lim, n_better = limitations(doc, report, gallery, pick)
    body += [lim, conclusion(doc, report, fd), appendices(doc, report, plots)]
    css = (ASSETS / "report.css").read_text(encoding="utf-8")
    js = (ASSETS / "report.js").read_text(encoding="utf-8")
    footer = (f"<footer class='wrap'><p>Label Anything benchmark report, {esc(report['suite'])} suite, generated "
              f"{esc(report['generated_at'])}. Source code: <a href='{REPO_URL}'>"
              f"{esc(REPO_URL.removeprefix('https://'))}</a>.</p></footer>")
    return ("<!doctype html>\n<html lang='en'>\n<head>\n<meta charset='utf-8'>\n"
            "<meta name='viewport' content='width=device-width, initial-scale=1'>\n"
            "<title>Label Anything benchmark report</title>\n<meta name='description' content='Comparison of Label "
            "Anything with baseline label placement methods on maps, charts, photographs, embeddings and "
            "networks.'>\n"
            f"<style>{css}</style>\n</head>\n<body>\n"
            + header_html(report, gallery, abstract_text(report, fd, doc, n_better), doc.toc)
            + bar_html(doc.toc, pick) + "<main>" + "\n".join(b for b in body if b) + "</main>" + footer + VIEWER_HTML
            + f"\n<script>\n{js}</script>\n</body>\n</html>\n")




def write_page(out: Path, report: dict, plots: dict | None) -> Path:
    """``out/index.html`` with the fonts next to it."""
    (out / "fonts").mkdir(parents=True, exist_ok=True)
    for f in ("NotoSans-Regular.ttf", "NotoSans-Bold.ttf", "OFL.txt"):
        if not (out / "fonts" / f).exists():
            shutil.copy2(paths.FONTS / f, out / "fonts" / f)
    p = out / "index.html"
    p.write_text(page(out, report, plots or {}, load_gallery(out)), encoding="utf-8")
    return p


