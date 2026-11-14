"""The benchmark report: ``bench-report/index.html`` and the analyses written to ``results.json``.

* per-scenario metric tables — Label Anything implementations (solver names
  ``rust``, ``wasm``, ``ts``) next to the baselines; baseline rows that rely on an
  emulation are marked ≈ (the emulations are listed in the cell's tooltip and in
  the baseline methods section), problems a baseline cannot run show "n/a"; these,
  the summary and the sequence tables colour every value against its column's
  median (``heat``),
* rendered images side by side (``bench/render.py`` for every solver) plus the
  engine's own debug overlay where an ``--overlay`` command is known,
* runtime-vs-size small multiples (static SVG, also written to ``plots/``),
* changes against a previous ``results.json`` (regressions beyond the threshold
  highlighted), implementation parity (Rust vs TS / WASM deltas on every metric),
* the performance-target table (``bench/perf``) and the release-gate summary
  (``bench/gates.py``).
"""
from __future__ import annotations

import functools
import html
import math
from pathlib import Path

from .perf import implementation

# (summary key, column label, format, direction: +1 higher is better, -1 lower is better, 0 informational)
METRICS = [
    ("placed_rate", "placed", "{:.1%}", +1),
    ("placed_weighted", "placed (weighted)", "{:.3f}", +1),
    ("hard_violations", "hard viol.", "{:d}", -1),
    ("hard_conflicts", "conflicts", "{:d}", -1),
    ("hard_spacing", "spacing viol.", "{:d}", -1),
    ("usable_rate", "usable", "{:.1%}", +1),
    ("usable_weighted", "usable (weighted)", "{:.3f}", +1),
    ("leader_crossings", "crossings", "{:d}", -1),
    ("leader_rate", "leaders", "{:.1%}", 0),
    ("ambiguity_rate", "ambig.", "{:.1%}", -1),
    ("clarity_misattributed_rate", "misattributed", "{:.1%}", -1),
    ("clarity_unclear_rate", "unclear", "{:.1%}", -1),
    ("clarity_weak_rate", "weak", "{:.1%}", -1),
    ("clarity_unclear_background", "unclear by bg. points", "{:d}", -1),
    ("clarity_margin_p10_em", "margin p10 em", "{:.2f}", 0),
    ("leadered_unclear_rate", "leadered unclear", "{:.1%}", -1),
    ("points_covered_rate", "points covered", "{:.1%}", -1),
    ("points_inside_labels", "points inside labels", "{:d}", -1),
    ("labels_covering_points_rate", "labels covering points", "{:.1%}", -1),
    ("labels_close_rate", "labels close", "{:.1%}", -1),
    ("label_gap_p10_em", "label gap p10 em", "{:.2f}", 0),
    ("stub_rate", "stubs", "{:.1%}", 0),
    ("priority_inversions", "inversions", "{:d}", -1),
    ("prefix_rate", "prefix", "{:.1%}", +1),
    ("ndcg_at_k", "NDCG@k", "{:.3f}", +1),
    ("coverage_satisfaction", "cov. groups", "{:.1%}", +1),
    ("adjacent_gap_abs_mean", "gap px", "{:.2f}", -1),
    ("internal_rate", "internal", "{:.1%}", 0),
    ("position_rank_mean", "pos. rank", "{:.2f}", -1),
    ("region_coverage", "regions labeled", "{:.1%}", +1),
    ("soft_coverage_mean", "soft cov.", "{:.3f}", -1),
    ("leader_near_crossings", "near cross.", "{:d}", -1),
    ("leader_mark_touches", "leader–mark", "{:d}", -1),
    ("leaders_far", "far leaders", "{:d}", -1),
    ("leader_len_p90_em", "leader p90 em", "{:.1f}", -1),
    ("label_points_hidden", "points hidden", "{:d}", -1),
    ("label_lines_em", "lines hidden em", "{:.1f}", -1),
    ("labels_on_contrast_border", "contrast border", "{:d}", -1),
    ("schema_errors", "schema err.", "{:d}", -1),
]
TABLE_COLS = ["placed_rate", "usable_rate", "hard_violations", "hard_conflicts", "leader_crossings",
              "leader_near_crossings", "leader_mark_touches", "ambiguity_rate", "clarity_unclear_rate",
              "points_covered_rate", "labels_close_rate", "priority_inversions", "ndcg_at_k",
              "adjacent_gap_abs_mean", "position_rank_mean", "region_coverage", "soft_coverage_mean"]
SEQ_METRICS = [
    ("displacement_mean_px", "displacement px", "{:.2f}", -1),
    ("flip_rate", "flip rate", "{:.1%}", -1),
    ("nesting_rate", "nesting rate", "{:.1%}", +1),
    ("nesting_fraction_mean", "nesting fraction", "{:.3f}", +1),
    ("added_total", "added", "{:d}", 0),
    ("removed_total", "removed", "{:d}", 0),
]
META = {k: (label, f, d) for k, label, f, d in METRICS + SEQ_METRICS}
EPS = 1e-9
DIGITS = 6  # results.json stores floats with 6 decimals: comparisons happen at that precision
SERIES = {"rust": "s1", "wasm": "s2", "ts": "s3"}  # categorical slots 1-3 (validated all-pairs)
IMPL_NAME = {"rust": "Rust", "wasm": "WASM", "ts": "TypeScript"}


def esc(s) -> str:
    return html.escape(str(s))


def fmt(v, f: str) -> str:
    if v is None:
        return "–"
    try:
        if "d" in f:
            return f.format(int(v))
        return f.format(v)
    except (TypeError, ValueError):
        return str(v)


def kind(solver: str) -> str:
    """``label-anything`` (rust / wasm / ts), ``baseline`` (built-in names) or ``other``."""
    from .baselines import BASELINES

    if implementation(solver):
        return "label-anything"
    return "baseline" if solver in ("naive", "greedy") or solver in BASELINES else "other"


# ---------------------------------------------------------------------------
# changes against a previous run
# ---------------------------------------------------------------------------
def _change(key: str, old, new, threshold: float) -> dict | None:
    if not isinstance(old, (int, float)) or not isinstance(new, (int, float)) or isinstance(old, bool):
        return None
    d = META[key][2]
    old, new = round(float(old), DIGITS), round(float(new), DIGITS)
    delta = new - old
    if abs(delta) <= EPS:
        return None
    rel = abs(delta) / abs(old) if abs(old) > EPS else math.inf
    worse = d != 0 and delta * d < 0
    better = d != 0 and delta * d > 0
    status = "changed"
    if worse and rel > threshold:
        status = "regression"
    elif better and rel > threshold:
        status = "improvement"
    return {"metric": key, "old": old, "new": new, "delta": delta, "relative": None if math.isinf(rel) else rel,
            "status": status}


def compare(previous: dict, current: dict, threshold: float = 0.02) -> dict:
    """Metric changes per (solver, scenario, config) and (solver, sequence) between two results.json."""
    rows = []
    prev = {(r["solver"], r["scenario"], r["config"]): r for r in previous.get("results", []) if "summary" in r}
    seen = set()
    for r in current.get("results", []):
        if "summary" not in r:
            continue
        key = (r["solver"], r["scenario"], r["config"])
        seen.add(key)
        p = prev.get(key)
        if p is None:
            continue
        for k, _l, _f, _d in METRICS:
            c = _change(k, p["summary"].get(k), r["summary"].get(k), threshold)
            if c:
                rows.append({"solver": r["solver"], "scenario": r["scenario"], "config": r["config"], **c})
    prev_seq = {(s["solver"], s["scenario"], s["sequence"]): s for s in previous.get("sequences", []) if "metrics" in s}
    for s in current.get("sequences", []):
        if "metrics" not in s:
            continue
        key = (s["solver"], s["scenario"], s["sequence"])
        seen.add(key)
        p = prev_seq.get(key)
        if p is None:
            continue
        for k, _l, _f, _d in SEQ_METRICS:
            c = _change(k, p["metrics"].get(k), s["metrics"].get(k), threshold)
            if c:
                rows.append({"solver": s["solver"], "scenario": s["scenario"], "config": s["sequence"], **c})
    missing = sorted("/".join(k) for k in list(prev) + list(prev_seq) if k not in seen)
    return {"previous": {k: previous.get(k) for k in ("generated_at", "suite", "solvers", "version")},
            "threshold": threshold, "rows": rows,
            "regressions": sum(1 for r in rows if r["status"] == "regression"),
            "improvements": sum(1 for r in rows if r["status"] == "improvement"), "missing": missing}


# ---------------------------------------------------------------------------
# implementation parity
# ---------------------------------------------------------------------------
def parity(report: dict) -> dict:
    """Deltas of every metric between the Rust implementation and each other implementation (TS, WASM)."""
    sol = report["solvers"]
    ref = next((s for s in sol if implementation(s) == "rust"), None)
    others = [s for s in sol if implementation(s) in ("ts", "wasm") and s != ref]
    out = {"reference": ref, "pairs": []}
    if ref is None or not others:
        return out
    by = {(r["solver"], r["scenario"], r["config"]): r for r in report["results"]}
    seq = {(s["solver"], s["scenario"], s["sequence"]): s for s in report.get("sequences", [])}
    for o in others:
        rows = []
        for (sv, sc, cfg), r in sorted(by.items()):
            if sv != ref:
                continue
            q = by.get((o, sc, cfg))
            if q is None or "summary" not in r or "summary" not in q:
                continue
            deltas = {}
            for k, _l, _f, _d in METRICS:
                a, b = r["summary"].get(k), q["summary"].get(k)
                if isinstance(a, (int, float)) and isinstance(b, (int, float)):
                    deltas[k] = round(float(b) - float(a), DIGITS)
                elif a != b:
                    deltas[k] = None
            rows.append({"scenario": sc, "config": cfg, "identical": r.get("digest") == q.get("digest"),
                         "deltas": deltas, "runtime_ms": [(r.get("runtime_reported") or {}).get("median"),
                                                          (q.get("runtime_reported") or {}).get("median")]})
        for (sv, sc, name), s in sorted(seq.items()):
            q = seq.get((o, sc, name))
            if sv != ref or q is None or "metrics" not in s or "metrics" not in q:
                continue
            deltas = {}
            for k, _l, _f, _d in SEQ_METRICS:
                a, b = s["metrics"].get(k), q["metrics"].get(k)
                if isinstance(a, (int, float)) and isinstance(b, (int, float)):
                    deltas[k] = round(float(b) - float(a), DIGITS)
            rows.append({"scenario": sc, "config": name, "sequence": True, "deltas": deltas,
                         "identical": s.get("digest") is not None and s.get("digest") == q.get("digest")})
        maxabs = {}
        for row in rows:
            for k, v in row["deltas"].items():
                if v is not None:
                    maxabs[k] = max(maxabs.get(k, 0.0), abs(v))
        out["pairs"].append({"solver": o, "implementation": implementation(o), "rows": rows,
                             "identical": sum(1 for r in rows if r["identical"]), "compared": len(rows),
                             "max_abs_delta": maxabs})
    return out


# ---------------------------------------------------------------------------
# runtime-vs-size small multiples (static SVG)
# ---------------------------------------------------------------------------
_LIGHT = {"surface": "#fcfcfb", "ink": "#0b0b0b", "ink2": "#52514e", "muted": "#898781", "grid": "#e1e0d9",
          "axis": "#c3c2b7", "s1": "#2a78d6", "s2": "#eb6834", "s3": "#1baf7a", "base": "#52514e"}
_DARK = {"surface": "#1a1a19", "ink": "#f0efec", "ink2": "#c3c2b7", "muted": "#898781", "grid": "#2c2c2a",
         "axis": "#383835", "s1": "#3987e5", "s2": "#d95926", "s3": "#199e70", "base": "#c3c2b7"}


def _svg_rules(c: dict) -> str:
    """Class rules with literal colours (no CSS variables: standalone SVG viewers such as librsvg lack them)."""
    r = [f".rt .bg{{fill:{c['surface']}}}", f".rt .grid{{stroke:{c['grid']}}}", f".rt .axis{{stroke:{c['axis']}}}",
         f".rt .tick{{fill:{c['muted']}}}", f".rt .title{{fill:{c['ink']}}}", f".rt .sub{{fill:{c['ink2']}}}",
         f".rt .dot{{stroke:{c['surface']}}}"]
    for k in ("s1", "s2", "s3", "base"):
        r.append(f".rt .line.{k}{{stroke:{c[k]}}}.rt .dot.{k}{{fill:{c[k]}}}")
    return "".join(r)


SVG_STYLE = ("<style>.rt{font-family:system-ui,-apple-system,'Segoe UI',sans-serif}"
             ".rt .grid,.rt .axis{stroke-width:1}.rt .tick{font-size:10px;font-variant-numeric:tabular-nums}"
             ".rt .title{font-size:12px;font-weight:600}.rt .sub{font-size:11px}"
             ".rt .line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}"
             ".rt .dot{stroke-width:2}.rt .hit{fill:transparent;stroke:none}"
             + _svg_rules(_LIGHT) + "@media (prefers-color-scheme:dark){" + _svg_rules(_DARK) + "}</style>")


def _compact(v: float) -> str:
    for div, suf in ((1e6, "M"), (1e3, "K")):
        if abs(v) >= div:
            s = f"{v / div:g}"
            return s + suf
    return f"{v:g}"


def _ms(v: float) -> str:
    if v >= 1000:
        return f"{v / 1000:g} s"
    return f"{v:g} ms"


def _decades(lo: float, hi: float) -> list[float]:
    a, b = math.floor(math.log10(lo)), math.ceil(math.log10(hi))
    if a == b:
        b += 1
    return [10.0 ** k for k in range(a, b + 1)]


def runtime_points(report: dict, which: str) -> dict[str, list[dict]]:
    """Per solver: problems with n_items and the median runtime (``engine``: stats.runtime_ms, ``wall``)."""
    pts: dict[str, list[dict]] = {}
    for r in report.get("results", []):
        if "summary" not in r or not r.get("n_items"):
            continue
        rt = (r.get("runtime_reported") or {}).get("median") if which == "engine" else (r.get("runtime") or {}).get(
            "median")
        if not isinstance(rt, (int, float)) or rt <= 0:
            continue
        pts.setdefault(r["solver"], []).append({"n": int(r["n_items"]), "ms": float(rt), "scenario": r["scenario"],
                                                "config": r["config"]})
    return pts


def _runtime_panels(report: dict, which: str):
    """The points, the panels (solver of the panel or None for the Label Anything implementations, title,
    subtitle, series) and the decades of both axes, shared by every panel; None without runtimes."""
    pts = runtime_points(report, which)
    if not pts:
        return None
    solvers = [s for s in report["solvers"] if s in pts]
    la = [s for s in solvers if implementation(s)]
    ref = la[0] if la else None
    panels = ([(None, "Label Anything", "implementations", la)] if la else [])
    for s in solvers:
        if s not in la:
            panels.append((s, s, f"vs {ref}" if ref else "", ([ref] if ref else []) + [s]))
    allv = [p for s in solvers for p in pts[s]]
    xs = _decades(min(p["n"] for p in allv), max(p["n"] for p in allv))
    ys = _decades(min(p["ms"] for p in allv), max(p["ms"] for p in allv))
    return pts, la, panels, xs, ys


PANEL_W, PANEL_H = 300, 210


def _series_class(s: str) -> str:
    return SERIES.get(implementation(s) or "", "base")


def _panel(o: list[str], ox: float, oy: float, title: str, sub: str, series: list[str], pts: dict, xs: list[float],
           ys: list[float]) -> None:
    """One runtime panel at (ox, oy): log–log axes over ``xs`` (items) and ``ys`` (ms), a dot per problem and solver
    of ``series``, the stress scenario's sizes joined by a line."""
    ml, mr, mt, mb = 52, 14, 34, 30
    lx0, ly0 = math.log10(xs[0]), math.log10(ys[0])
    lx1, ly1 = math.log10(xs[-1]), math.log10(ys[-1])

    def scale(v: float, lo: float, hi: float, a: float, b: float) -> float:
        """log10(v) mapped from [lo, hi] (log10 units) to [a, b] (px)."""
        return a + (math.log10(v) - lo) / (hi - lo) * (b - a)

    x0, x1 = ox + ml, ox + PANEL_W - mr
    y0, y1 = oy + PANEL_H - mb, oy + mt
    X = functools.partial(scale, lo=lx0, hi=lx1, a=x0, b=x1)
    Y = functools.partial(scale, lo=ly0, hi=ly1, a=y0, b=y1)
    o.append(f'<text class="title" x="{ox + ml}" y="{oy + 16}">{esc(title)}</text>'
             f'<text class="sub" x="{ox + ml}" y="{oy + 29}">{esc(sub)}</text>')
    for v in xs:
        o.append(f'<line class="grid" x1="{X(v):.1f}" y1="{y1}" x2="{X(v):.1f}" y2="{y0}"/>'
                 f'<text class="tick" x="{X(v):.1f}" y="{y0 + 14}" text-anchor="middle">{_compact(v)}</text>')
    for v in ys:
        o.append(f'<line class="grid" x1="{x0}" y1="{Y(v):.1f}" x2="{x1}" y2="{Y(v):.1f}"/>'
                 f'<text class="tick" x="{x0 - 5}" y="{Y(v) + 3.5:.1f}" text-anchor="end">{_ms(v)}</text>')
    o.append(f'<line class="axis" x1="{x0}" y1="{y0}" x2="{x1}" y2="{y0}"/>')
    o.append(f'<text class="tick" x="{x1}" y="{y0 + 26}" text-anchor="end">items</text>')
    for s in series:
        stress = sorted((p for p in pts[s] if p["scenario"].startswith("10-")), key=lambda p: p["n"])
        if len(stress) >= 2:
            o.append(f'<polyline class="line {_series_class(s)}" points="'
                     + " ".join(f"{X(p['n']):.1f},{Y(p['ms']):.1f}" for p in stress) + '"/>')
    for s in series:
        c = _series_class(s)
        for p in sorted(pts[s], key=lambda p: p["n"]):
            tip = f"{s} · {p['scenario']}/{p['config']} · {p['n']:,} items · {p['ms']:,.1f} ms"
            o.append(f'<g><title>{esc(tip)}</title><circle class="hit" cx="{X(p["n"]):.1f}" cy="{Y(p["ms"]):.1f}" '
                     f'r="12"/><circle class="dot {c}" cx="{X(p["n"]):.1f}" cy="{Y(p["ms"]):.1f}" r="4"/></g>')


def runtime_svg(report: dict, which: str = "engine") -> str | None:
    """Runtime against problem size, one panel per solver (the Label Anything implementations together), in one
    standalone SVG with a legend."""
    frame = _runtime_panels(report, which)
    if frame is None:
        return None
    pts, la, panels, xs, ys = frame
    cols = min(3, len(panels))
    rows = math.ceil(len(panels) / cols)
    legend_h = 26
    W, H = cols * PANEL_W, rows * PANEL_H + legend_h
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" class="rt" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
         f'role="img" aria-label="{"Engine-reported" if which == "engine" else "Wall-clock"} runtime against '
         f'problem size, one panel per solver">', SVG_STYLE, f'<rect class="bg" width="{W}" height="{H}"/>']
    # legend (one entry per series present)
    lx = 8
    entries = [(IMPL_NAME[implementation(s)] + f" ({s})", _series_class(s)) for s in la]
    if len(panels) > (1 if la else 0):
        entries.append(("baseline named in the panel title", "base"))
    for label, c in entries:
        o.append(f'<circle class="dot {c}" cx="{lx + 5}" cy="14" r="4"/>'
                 f'<text class="sub" x="{lx + 14}" y="18">{esc(label)}</text>')
        lx += 22 + 6.5 * len(label)
    for k, (_solver, title, sub, series) in enumerate(panels):
        _panel(o, (k % cols) * PANEL_W, legend_h + (k // cols) * PANEL_H, title, sub, series, pts, xs, ys)
    o.append("</svg>")
    return "\n".join(o) + "\n"


def runtime_panels(report: dict, which: str = "engine", name=str) -> list[tuple[str | None, str]]:
    """The panels of ``runtime_svg`` as separate SVGs on the same axes: (the panel's solver, None for the Label
    Anything implementations; the SVG); ``name`` turns a solver into the name its panel shows."""
    frame = _runtime_panels(report, which)
    if frame is None:
        return []
    pts, la, panels, xs, ys = frame
    out = []
    for solver, title, sub, series in panels:
        if solver is not None:
            title, sub = name(solver), f"and {name(la[0])}" if la else ""
        o = [f'<svg xmlns="http://www.w3.org/2000/svg" class="rt" viewBox="0 0 {PANEL_W} {PANEL_H}" '
             f'width="{PANEL_W}" height="{PANEL_H}" role="img" aria-label="{esc(title)}: runtime against problem '
             f'size">', SVG_STYLE, f'<rect class="bg" width="{PANEL_W}" height="{PANEL_H}"/>']
        _panel(o, 0, 0, title, sub, series, pts, xs, ys)
        o.append("</svg>")
        out.append((solver, "\n".join(o)))
    return out


def write_plots(out: Path, report: dict) -> dict[str, str]:
    """Write the runtime-vs-size figures to ``out/plots``; returns name -> relative path."""
    made = {}
    for which in ("engine", "wall"):
        svg = runtime_svg(report, which)
        if svg is None:
            continue
        p = out / "plots" / f"runtime-{which}.svg"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(svg, encoding="utf-8")
        made[which] = str(p.relative_to(out))
    return made


def _numbers(rows: list[dict], key: str) -> list[float]:
    return [r["summary"][key] for r in rows if isinstance(r["summary"].get(key), (int, float))]


def _mean(v: list[float]) -> float | None:
    return sum(v) / len(v) if v else None


SCALING_SCENARIO = "10-stress"


def scaling_exponent(results: list[dict], solver: str, scenario: str = SCALING_SCENARIO) -> float | None:
    """Empirical scaling exponent k of runtime ∝ nᵏ: the least-squares slope of log runtime over log items on
    the problems of ``scenario`` (one problem family at growing sizes), from the engine-reported runtime where
    the solver reports one, else the wall time; None with fewer than three sizes."""
    pts = []
    for r in results:
        if r.get("solver") != solver or r.get("scenario") != scenario or "summary" not in r:
            continue
        t = (r.get("runtime_reported") or {}).get("median") or (r.get("runtime") or {}).get("median")
        n = r.get("n_items")
        if isinstance(t, (int, float)) and t > 0 and n:
            pts.append((math.log(n), math.log(t)))
    if len({x for x, _ in pts}) < 3:
        return None
    mx = sum(x for x, _ in pts) / len(pts)
    my = sum(y for _, y in pts) / len(pts)
    den = sum((x - mx) ** 2 for x, _ in pts)
    return sum((x - mx) * (y - my) for x, y in pts) / den if den > 0 else None


# Colour-coded tables: every value against the median of its column, on a diverging scale with five classes.
HEAT_NEAR, HEAT_FAR = 0.25, 0.65  # |score| from which a value is better (worse), much better (much worse)
HEAT_CLASS = {-2: "hw2", -1: "hw1", 0: "h0", 1: "hb1", 2: "hb2"}
HEAT_TEXT = {-2: "much worse", -1: "worse", 0: "near the median", 1: "better", 2: "much better"}


def _shown(v: float, f: str) -> float:
    """``v`` as the table shows it (rounded to the format ``f``)."""
    s = fmt(v, f).replace(",", "")
    return float(s[:-1]) / 100 if s.endswith("%") else float(s)


def _median(v: list[float]) -> float:
    v = sorted(v)
    return (v[(len(v) - 1) // 2] + v[len(v) // 2]) / 2


def heat(values: list, f: str, direction: int, log: bool = False) -> tuple[list[tuple[int, bool] | None],
                                                                             float | None]:
    """Colour classes of one table column and its median: per value (None where there is none) the class from −2
    (much worse than the median) to +2 (much better) and whether it is the column's best value.

    Values are compared as the table shows them (rounded to ``f``), on log10(1 + v) with ``log`` (counts, times,
    memory: there ratios matter, not differences). Each side of the median is scaled to its farthest value but
    at least to a floor — 5 percentage points for rates and other fractions, a factor of two on the log scale,
    a tenth of the column's largest value otherwise — so that small differences stay near the median. The best
    value is marked when it is better than the median (all values shown alike)."""
    out: list[tuple[int, bool] | None] = [None] * len(values)
    shown = {i: _shown(v, f) for i, v in enumerate(values) if isinstance(v, (int, float)) and not isinstance(v, bool)}
    if direction == 0 or len(shown) < 2:
        return out, None
    t = {i: math.log10(1 + max(v, 0.0)) if log else v for i, v in shown.items()}
    mid = _median(list(t.values()))
    dev = {i: direction * (x - mid) for i, x in t.items()}
    floor = (math.log10(2) if log else 0.05 if "%" in f or f.endswith(".3f}")
             else 0.1 * max(abs(x) for x in t.values()))
    up = max([floor, EPS] + list(dev.values()))
    down = max([floor, EPS] + [-d for d in dev.values()])
    top = max(dev.values())
    for i, d in dev.items():
        s = d / up if d >= 0 else d / down
        c = 0 if abs(s) < HEAT_NEAR else 1 if abs(s) < HEAT_FAR else 2
        out[i] = (c if s > 0 else -c, s > 0 and c > 0 and d >= top - EPS)
    return out, _median(list(shown.values()))


def heat_attrs(rows: list[dict], cols: list[tuple[str, str, int, bool]]) -> list[dict[str, str]]:
    """Per row and column key the attributes of the cell: its ``heat`` class among ``rows`` and a tooltip saying
    how it compares ("" where the column has no direction or the row no value). ``cols``: (key, format,
    direction, log scale)."""
    out: list[dict[str, str]] = [{} for _ in rows]
    for k, f, d, lg in cols:
        hs, mid = heat([r.get(k) for r in rows], f, d, lg)
        m = "" if mid is None else f"{mid:.1f}".removesuffix(".0") if "d" in f else fmt(mid, f)
        for a, h in zip(out, hs):
            if h is None:
                a[k] = ""
                continue
            c, best = h
            tip = f"{HEAT_TEXT[c]}{' than the median' if c else ''} ({m}){', the best' if best else ''}"
            a[k] = f" class='{HEAT_CLASS[c]}{' best' if best else ''}' title='{esc(tip)}'"
    return out


def others_better(report: dict, ref: str) -> list[dict]:
    """Per problem and measure, the best other labeler that beats ``ref`` fairly: no more hard violations and, for
    the measures other than the usable rate, at least as many usable labels (half a point of slack), better by more
    than one point. [{scenario, config, metric, ref_value, solver, value}]; Label Anything's other implementations
    are not compared."""
    by: dict[tuple[str, str], dict[str, dict]] = {}
    for r in report.get("results", []):
        if "summary" in r:
            by.setdefault((r["scenario"], r["config"]), {})[r["solver"]] = r["summary"]
    out = []
    for (sc, cfg), rs in sorted(by.items()):
        me = rs.get(ref)
        if me is None:
            continue
        hv, usable = me.get("hard_violations") or 0, me.get("usable_rate")
        for key, d in BETTER_MEASURES:
            mv = me.get(key)
            if not isinstance(mv, (int, float)):
                continue
            best = None
            for s, sm in rs.items():
                v = sm.get(key)
                if s == ref or implementation(s) or not isinstance(v, (int, float)):
                    continue
                if (sm.get("hard_violations") or 0) > hv:
                    continue
                if key != "usable_rate" and (usable is None or (sm.get("usable_rate") or 0) < usable - 0.005):
                    continue
                if d * (v - mv) > BETTER_MARGIN and (best is None or d * (v - best[1]) > 0):
                    best = (s, v)
            if best:
                out.append({"scenario": sc, "config": cfg, "metric": key, "ref_value": mv, "solver": best[0],
                            "value": best[1]})
    return out


BETTER_MEASURES = (("usable_rate", +1), ("clarity_unclear_rate", -1), ("points_covered_rate", -1),
                   ("labels_close_rate", -1))
BETTER_MARGIN = 0.01


def write_html(out: Path, report: dict, plots: dict | None = None) -> Path:
    """The report page ``out/index.html`` (``bench/report_html.py``)."""
    from .report_html import write_page

    return write_page(out, report, plots if plots is not None else write_plots(out, report))


def main(argv=None) -> int:
    """Rebuild the analyses and index.html of an existing run (no solver is run again)."""
    import argparse

    from .common.jsonio import read_json, write_json

    ap = argparse.ArgumentParser(prog="python -m bench.report",
                                 description="Rebuild bench-report/index.html from an existing results.json: "
                                             "parity, plots, optionally the changes against --previous and the "
                                             "release gates (exit 1 when they fail).")
    ap.add_argument("results", help="results.json of the run (index.html is written next to it)")
    ap.add_argument("--previous", help="results.json of the previous release")
    ap.add_argument("--gate", action="store_true", help="evaluate the release gates")
    ap.add_argument("--gates-allow", help="allow-list of accepted regressions (default bench/gates-allow.json)")
    ap.add_argument("--threshold", type=float, default=0.02)
    a = ap.parse_args(argv)
    path = Path(a.results)
    out = path.parent
    report = read_json(path)
    previous = read_json(a.previous) if a.previous else None
    if previous is not None:
        report["diff"] = compare(previous, report, a.threshold)
    report["parity"] = parity(report)
    gate = None
    if a.gate:
        from . import gates

        allow, problems = gates.load_allow(a.gates_allow)
        gate = gates.check(report, previous, allow, problems, a.threshold)
        report["gate"] = gate
    report["plots"] = write_plots(out, report)
    write_json(path, report, nd=DIGITS, indent=1)
    page = write_html(out, report, report["plots"])
    print(f"wrote {path} and {page}")
    if gate is not None:
        from . import gates

        print("\n".join(gates.summary_lines(gate)))
        return 0 if gate["passed"] else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
