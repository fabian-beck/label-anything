"""The benchmark report: ``bench-report/index.html`` and the analyses written to ``results.json``.

* per-scenario metric tables — Label Anything implementations (solver names
  ``rust``, ``wasm``, ``ts``) next to the baselines; baseline rows that rely on an
  emulation are marked ≈ (the emulations are listed in the cell's tooltip and in
  the baseline methods section), problems a baseline cannot run show "n/a",
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
    ("leader_crossings", "crossings", "{:d}", -1),
    ("leader_rate", "leaders", "{:.1%}", 0),
    ("ambiguity_rate", "ambig.", "{:.1%}", -1),
    ("priority_inversions", "inversions", "{:d}", -1),
    ("prefix_rate", "prefix", "{:.1%}", +1),
    ("ndcg_at_k", "NDCG@k", "{:.3f}", +1),
    ("coverage_satisfaction", "cov. groups", "{:.1%}", +1),
    ("adjacent_gap_abs_mean", "gap px", "{:.2f}", -1),
    ("internal_rate", "internal", "{:.1%}", 0),
    ("position_rank_mean", "pos. rank", "{:.2f}", -1),
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
TABLE_COLS = ["placed_rate", "hard_violations", "leader_crossings", "leader_near_crossings", "leader_mark_touches",
              "ambiguity_rate", "priority_inversions", "ndcg_at_k", "adjacent_gap_abs_mean", "position_rank_mean",
              "soft_coverage_mean"]
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


def runtime_svg(report: dict, which: str = "engine") -> str | None:
    pts = runtime_points(report, which)
    if not pts:
        return None
    solvers = [s for s in report["solvers"] if s in pts]
    la = [s for s in solvers if implementation(s)]
    ref = la[0] if la else None
    panels = ([("Label Anything", "implementations", la)] if la else [])
    for s in solvers:
        if s not in la:
            panels.append((s, f"vs {ref}" if ref else "", ([ref] if ref else []) + [s]))
    allv = [p for s in solvers for p in pts[s]]
    xs = _decades(min(p["n"] for p in allv), max(p["n"] for p in allv))
    ys = _decades(min(p["ms"] for p in allv), max(p["ms"] for p in allv))
    cols = min(3, len(panels))
    rows = math.ceil(len(panels) / cols)
    PW, PH = 300, 210
    ml, mr, mt, mb = 52, 14, 34, 30
    legend_h = 26
    W, H = cols * PW, rows * PH + legend_h

    def cls(s: str) -> str:
        return SERIES.get(implementation(s) or "", "base")

    o = [f'<svg xmlns="http://www.w3.org/2000/svg" class="rt" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
         f'role="img" aria-label="{"Engine-reported" if which == "engine" else "Wall-clock"} runtime against '
         f'problem size, one panel per solver">', SVG_STYLE, f'<rect class="bg" width="{W}" height="{H}"/>']
    # legend (one entry per series present)
    lx = 8
    entries = [(IMPL_NAME[implementation(s)] + f" ({s})", cls(s)) for s in la]
    if len(solvers) > len(la):
        entries.append(("baseline named in the panel title", "base"))
    for label, c in entries:
        o.append(f'<circle class="dot {c}" cx="{lx + 5}" cy="14" r="4"/>'
                 f'<text class="sub" x="{lx + 14}" y="18">{esc(label)}</text>')
        lx += 22 + 6.5 * len(label)
    lx0, ly0 = math.log10(xs[0]), math.log10(ys[0])
    lx1, ly1 = math.log10(xs[-1]), math.log10(ys[-1])
    def scale(v: float, lo: float, hi: float, a: float, b: float) -> float:
        """log10(v) mapped from [lo, hi] (log10 units) to [a, b] (px)."""
        return a + (math.log10(v) - lo) / (hi - lo) * (b - a)

    for k, (title, sub, series) in enumerate(panels):
        ox = (k % cols) * PW
        oy = legend_h + (k // cols) * PH
        x0, x1 = ox + ml, ox + PW - mr
        y0, y1 = oy + PH - mb, oy + mt
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
            c = cls(s)
            stress = sorted((p for p in pts[s] if p["scenario"].startswith("10-")), key=lambda p: p["n"])
            if len(stress) >= 2:
                o.append(f'<polyline class="line {c}" points="'
                         + " ".join(f"{X(p['n']):.1f},{Y(p['ms']):.1f}" for p in stress) + '"/>')
        for s in series:
            c = cls(s)
            for p in sorted(pts[s], key=lambda p: p["n"]):
                tip = f"{s} · {p['scenario']}/{p['config']} · {p['n']:,} items · {p['ms']:,.1f} ms"
                o.append(f'<g><title>{esc(tip)}</title><circle class="hit" cx="{X(p["n"]):.1f}" cy="{Y(p["ms"]):.1f}" '
                         f'r="12"/><circle class="dot {c}" cx="{X(p["n"]):.1f}" cy="{Y(p["ms"]):.1f}" r="4"/></g>')
    o.append("</svg>")
    return "\n".join(o) + "\n"


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


# ---------------------------------------------------------------------------
# HTML
# ---------------------------------------------------------------------------
CSS = """
:root{color-scheme:light dark;--bg:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;
--line:#e1e0d9;--head:#f0efec;--bad:#d03b3b;--bad-bg:#fbeaea;--good:#006300;--good-bg:#e7f4e7;--warn-bg:#fdf3dc;
--link:#1c5cab}
@media (prefers-color-scheme:dark){:root{--bg:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;
--line:#2c2c2a;--head:#242422;--bad:#e66767;--bad-bg:#3a1f1f;--good:#0ca30c;--good-bg:#17301a;--warn-bg:#352d18;
--link:#86b6ef}}
body{font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:20px 16px 48px;color:var(--ink);
background:var(--bg)}
main{max-width:1500px;margin:0 auto}a{color:var(--link)}
h1{font-size:24px;margin:0 0 6px}
h2{margin-top:40px;font-size:19px;border-bottom:1px solid var(--line);padding-bottom:4px}
h3{font-size:15px;margin:22px 0 6px}.meta,.note{color:var(--ink2)}.small{font-size:12px}
.scroll{overflow-x:auto;max-width:100%}
table{border-collapse:collapse;margin:8px 0 16px;background:var(--surface);font-variant-numeric:tabular-nums}
td,th{border:1px solid var(--line);padding:3px 7px;text-align:right;white-space:nowrap}
th{background:var(--head);font-weight:600}td.l,th.l{text-align:left}td.wrap{white-space:normal;max-width:520px}
tr.la td:first-child,tr.la td.solver{font-weight:600}tr.na td{color:var(--muted);font-style:italic}
td.bad,span.bad{color:var(--bad);font-weight:600}td.bad{background:var(--bad-bg)}
td.good,span.good{color:var(--good);font-weight:600}td.good{background:var(--good-bg)}td.warn{background:var(--warn-bg)}
.err{color:var(--bad)}.em{cursor:help;border-bottom:1px dotted var(--muted)}
img{max-width:100%;border:1px solid var(--line);background:#fff}
.imgs{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr));gap:10px}
figure{margin:0}figcaption{font-size:12px;color:var(--ink2)}
figure.na{border:1px dashed var(--line);padding:10px;align-self:start}
.chart svg{max-width:100%;height:auto}details{margin:6px 0 14px}summary{cursor:pointer;color:var(--ink2)}
nav ul{columns:2;padding-left:18px}@media (max-width:640px){nav ul{columns:1}}
"""


def _status_cell(passed: bool | None, text_ok="pass", text_bad="FAIL") -> str:
    if passed is None:
        return "<td class='l'>–</td>"
    return f"<td class='l good'>✓ {text_ok}</td>" if passed else f"<td class='l bad'>✗ {text_bad}</td>"


def _numbers(rows: list[dict], key: str) -> list[float]:
    return [r["summary"][key] for r in rows if isinstance(r["summary"].get(key), (int, float))]


def _mean(v: list[float]) -> float | None:
    return sum(v) / len(v) if v else None


def _summary_table(report: dict) -> list[str]:
    """One row per solver: aggregates over the problems it ran."""
    o = ["<div class='scroll'><table><tr><th class='l'>solver</th><th class='l'>kind</th><th>problems</th>"
         "<th>n/a</th><th>errors</th><th>placed (mean)</th><th>hard viol. (sum)</th><th>problems with hard viol.</th>"
         "<th>ambig. (mean)</th><th>inversions (sum)</th><th>engine ms (sum of medians)</th>"
         "<th>wall ms (sum of medians)</th></tr>"]
    for s in report["solvers"]:
        rs = [r for r in report["results"] if r["solver"] == s]
        ok = [r for r in rs if "summary" in r]
        na = sum(1 for r in rs if "skipped" in r)
        er = sum(1 for r in rs if "error" in r)
        engs = [v for v in ((r.get("runtime_reported") or {}).get("median") for r in ok) if isinstance(v, (int, float))]
        eng = sum(engs) if engs else None
        wall = sum(r["runtime"]["median"] for r in ok) if ok else None
        hv, inv = _numbers(ok, "hard_violations"), _numbers(ok, "priority_inversions")
        k = kind(s)
        o.append(f"<tr class='{'la' if k == 'label-anything' else ''}'><td class='l solver'>{esc(s)}</td>"
                 f"<td class='l'>{esc(k)}</td><td>{len(ok)}</td><td>{na}</td><td>{er}</td>"
                 f"<td>{fmt(_mean(_numbers(ok, 'placed_rate')), '{:.1%}')}</td>"
                 f"<td>{fmt(sum(hv) if hv else None, '{:d}')}</td>"
                 f"<td>{sum(1 for r in ok if r['summary'].get('hard_violations'))}</td>"
                 f"<td>{fmt(_mean(_numbers(ok, 'ambiguity_rate')), '{:.1%}')}</td>"
                 f"<td>{fmt(sum(inv) if inv else None, '{:d}')}</td>"
                 f"<td>{fmt(eng, '{:,.1f}')}</td><td>{fmt(wall, '{:,.1f}')}</td></tr>")
    o.append("</table></div>")
    return o


def _perf_section(perf: dict | None) -> list[str]:
    o = ["<h2 id='perf'>Performance targets</h2>"]
    if not perf or not perf.get("rows"):
        o.append("<p class='note'>Not measured in this run (use <code>--perf</code>; only solvers named rust, "
                 "wasm or ts are measured).</p>")
        return o
    m = perf.get("machine", {})
    threads = perf.get("threads")
    thr = ("one thread, as the targets of brief §5.8" if threads == 1 else
           "all cores" if threads == 0 else f"{threads} threads" if threads else "the engine's default threads")
    o.append(f"<p class='note'>Median of {perf['runs']} runs of the engine's own timing "
             f"(<code>stats.runtime_ms</code>; raster target: <code>stats.phases_ms.prepare</code>), not process "
             f"wall time; the native engine on {thr}. Machine: {esc(m.get('cpu', '?'))}, "
             f"{esc(m.get('cores', '?'))} cores, {esc(m.get('platform', ''))}. Problems: "
             "<code>python -m bench.perf generate</code> (deterministic).</p>")
    o.append("<div class='scroll'><table><tr><th class='l'>problem</th><th class='l'>solver</th>"
             "<th class='l'>metric</th><th>median ms</th><th>target ms</th><th>ratio</th><th>runs (ms)</th>"
             "<th class='l'>result</th></tr>")
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
                     f"<td class='l'><code>{esc(r['metric'])}</code></td><td>–</td><td>{r['target']:g}</td><td>–</td>"
                     f"<td class='l err' colspan='2'>{esc(r.get('error', 'not measured'))}</td></tr>")
    o.append("</table></div>")
    return o


def _gate_section(gate: dict | None) -> list[str]:
    o = ["<h2 id='gates'>Release gates</h2>"]
    if not gate:
        o.append("<p class='note'>Not evaluated (run with <code>--gate</code>, or <code>python -m bench.gates "
                 "results.json --previous previous/results.json</code>).</p>")
        return o
    o.append(f"<p><b class='{'good' if gate['passed'] else 'bad'}'>"
             f"{'✓ all gates pass' if gate['passed'] else '✗ gates failed'}</b></p>")
    o.append("<div class='scroll'><table><tr><th class='l'>gate</th><th class='l'>result</th>"
             "<th class='l'>details</th></tr>")
    for c in gate["checks"]:
        res = "<td class='l warn'>– skipped</td>" if c.get("skipped") else _status_cell(c["passed"])
        det = "<br>".join(esc(d) for d in c.get("details", [])[:40])
        if len(c.get("details", [])) > 40:
            det += f"<br>… {len(c['details']) - 40} more"
        o.append(f"<tr><td class='l'>{esc(c['name'])}</td>{res}<td class='l wrap small'>{det}</td></tr>")
    o.append("</table></div>")
    return o


def _plots_section(report: dict, plots: dict) -> list[str]:
    o = ["<h2 id='runtime'>Runtime vs. problem size</h2>",
         "<p class='note'>One dot per problem (median over the runs), log–log axes shared by all panels; the line "
         "follows scenario 10 (stress sizes) when more than one size ran. Label Anything implementations keep "
         "their colour in every panel; each other panel shows one baseline (grey) against the reference "
         "implementation. Hover a dot for its problem.</p>"]
    if not plots:
        o.append("<p class='note'>No runtimes to plot.</p>")
        return o
    for which, title in (("engine", "Engine-reported runtime (stats.runtime_ms: the solve or the tool call itself)"),
                         ("wall", "Wall-clock time per run (process start-up and I/O included)")):
        if which not in plots:
            continue
        svg = runtime_svg(report, which)
        o.append(f"<h3>{esc(title)}</h3><div class='chart'>{svg}</div>"
                 f"<p class='small note'>Static file: <a href='{esc(plots[which])}'>{esc(plots[which])}</a></p>")
    pts_e = runtime_points(report, "engine")
    pts_w = runtime_points(report, "wall")
    o.append("<details><summary>Table view</summary><div class='scroll'><table><tr><th class='l'>solver</th>"
             "<th class='l'>problem</th><th>items</th><th>engine ms</th><th>wall ms</th></tr>")
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
    return o


def _parity_section(par: dict | None) -> list[str]:
    o = ["<h2 id='parity'>Implementation parity</h2>"]
    if not par or not par.get("pairs"):
        o.append("<p class='note'>Needs the Rust implementation and at least one other (solver names rust and "
                 "ts / wasm) in the same run.</p>")
        return o
    for pair in par["pairs"]:
        o.append(f"<h3>{esc(pair['solver'])} − {esc(par['reference'])}</h3><p class='note'>{pair['identical']} of "
                 f"{pair['compared']} problems with identical placements (ids, boxes, leaders). Cells show "
                 f"{esc(pair['solver'])} minus {esc(par['reference'])}; non-zero deltas are highlighted.</p>")
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
                    cells.append(f"<td class='{'warn' if abs(v) > EPS else ''}'>{v:+.4g}</td>" if abs(v) > EPS
                                 else "<td>0</td>")
            o.append(f"<tr><td class='l'>{esc(row['scenario'])}/{esc(row['config'])}</td>"
                     f"<td>{'yes' if row['identical'] else '<b>no</b>'}</td>" + "".join(cells) + "</tr>")
        o.append("<tr><th class='l'>max |Δ|</th><th></th>" + "".join(
            f"<th>{pair['max_abs_delta'][k]:.4g}</th>" for k in keys) + "</tr></table></div>")
    return o


def _diff_section(diff: dict | None) -> list[str]:
    o = ["<h2 id='diff'>Changes vs. previous release</h2>"]
    if not diff:
        o.append("<p class='note'>No previous results given (<code>--previous path/to/results.json</code>).</p>")
        return o
    pv = diff["previous"]
    o.append(f"<p class='note'>Previous: {esc(pv.get('generated_at'))}, suite {esc(pv.get('suite'))}, solvers "
             f"{esc(', '.join(pv.get('solvers') or []))}. Threshold {diff['threshold']:.0%} relative "
             f"(any change from 0 counts). <span class='bad'>{diff['regressions']} regressions</span>, "
             f"<span class='good'>{diff['improvements']} improvements</span>; runtimes are not compared here "
             "(the performance targets cover them).</p>")
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
    return o


def _baseline_note(r: dict) -> str:
    b = r.get("baseline") or {}
    items = b.get("emulations", []) + [f"not supported: {u}" for u in b.get("unsupported", [])]
    if not items:
        return ""
    tip = "\n".join(items)
    return f"<span class='em' title='{esc(tip)}'>≈ {len(items)}</span>"


def _order(solvers: list[str], name: str) -> int:
    return solvers.index(name) if name in solvers else len(solvers)


def _scenario_sections(report: dict) -> list[str]:
    solvers = report["solvers"]
    by_sc: dict[str, list] = {}
    for r in report["results"]:
        by_sc.setdefault(r["scenario"], []).append(r)
    o = []
    for sc in sorted(by_sc):
        rows = by_sc[sc]
        o.append(f"<h2 id='sc-{esc(sc)}'>{esc(sc)}</h2>")
        o.append("<div class='scroll'><table><tr><th class='l'>config</th><th class='l'>solver</th><th>items</th>"
                 + "".join(f"<th>{esc(META[k][0])}</th>" for k in TABLE_COLS)
                 + "<th>engine ms</th><th>wall ms (median / p95)</th><th>det.</th><th class='l'>notes</th></tr>")
        for r in sorted(rows, key=lambda r: (r["config"], _order(solvers, r["solver"]))):
            cls = "la" if kind(r["solver"]) == "label-anything" else ""
            head = f"<td class='l'>{esc(r['config'])}</td><td class='l solver'>{esc(r['solver'])}</td>"
            if "skipped" in r:
                o.append(f"<tr class='na'>{head}<td>{r.get('n_items') or ''}</td><td colspan='{len(TABLE_COLS) + 3}' "
                         f"class='l'>n/a</td><td class='l wrap small'>{esc(r['skipped'])}</td></tr>")
                continue
            if "error" in r:
                o.append(f"<tr class='{cls}'>{head}<td>{r.get('n_items') or ''}</td><td colspan='{len(TABLE_COLS) + 4}'"
                         f" class='l err wrap'>{esc(r['error'])}</td></tr>")
                continue
            s = r["summary"]
            rt = r["runtime"]
            eng = (r.get("runtime_reported") or {}).get("median")
            det = "–" if len(rt.get("runs", [])) < 2 else ("yes" if r["deterministic"] else "<b>NO</b>")
            hv = s.get("hard_violations") or 0
            cells = []
            for k in TABLE_COLS:
                c = " class='bad'" if (k == "hard_violations" and hv and cls == "la") else ""
                cells.append(f"<td{c}>{fmt(s.get(k), META[k][1])}</td>")
            o.append(f"<tr class='{cls}'>{head}<td>{r['n_items']}</td>" + "".join(cells)
                     + f"<td>{fmt(eng, '{:,.1f}')}</td><td>{rt['median']:,.1f} / {rt['p95']:,.1f}</td><td>{det}</td>"
                       f"<td class='l'>{_baseline_note(r)}</td></tr>")
        o.append("</table></div>")
        for cfg in sorted({r["config"] for r in rows}):
            o.append(f"<h3>{esc(cfg)}</h3><div class='imgs'>")
            for r in sorted((r for r in rows if r["config"] == cfg),
                            key=lambda r: _order(solvers, r["solver"])):
                if r.get("image"):
                    link = f" · <a href='{esc(r['svg'])}'>SVG</a>" if r.get("svg") else ""
                    note = " · ≈ emulation" if (r.get("baseline") or {}).get("emulations") else ""
                    o.append(f"<figure><img loading='lazy' src='{esc(r['image'])}' alt='{esc(r['solver'])} result for "
                             f"{esc(cfg)}'><figcaption>{esc(r['solver'])}{note} · <a href='{esc(r['metrics'])}'>"
                             f"metrics</a> · <a href='{esc(r['result'])}'>result</a>{link}</figcaption></figure>")
                if r.get("overlay"):
                    o.append(f"<figure><img loading='lazy' src='{esc(r['overlay'])}' alt='{esc(r['solver'])} debug "
                             f"overlay for {esc(cfg)}'><figcaption>{esc(r['solver'])} · engine debug overlay (cost "
                             f"grids, candidates) · <a href='{esc(r['overlay'])}'>open</a></figcaption></figure>")
                elif "skipped" in r or "error" in r:
                    what = f"n/a: {r['skipped']}" if "skipped" in r else f"failed: {r['error']}"
                    o.append(f"<figure class='na'><figcaption>{esc(r['solver'])} · {esc(what)}</figcaption></figure>")
            o.append("</div>")
    return o


def _sequence_section(report: dict) -> list[str]:
    if not report.get("sequences"):
        return []
    o = ["<h2 id='sequences'>Stability sequences</h2><div class='scroll'><table><tr><th class='l'>sequence</th>"
         "<th class='l'>solver</th><th>frames</th><th>displacement px (mean / median)</th><th>flip rate</th>"
         "<th>nesting rate</th><th>nesting fraction</th><th>added</th><th>removed</th><th>engine ms (median frame)"
         "</th></tr>"]
    for s in report["sequences"]:
        opt = s.get("options") or {}
        tip = (f"{opt['iter_lim']} iterations per frame (the comparison budget of the sequence), "
               f"lines sampled every {opt['step']:g} px" if "iter_lim" in opt and "step" in opt else "")
        note = f" <span class='em' title='{esc(tip)}'>≈</span>" if tip else ""
        head = f"<td class='l'>{esc(s['sequence'])}</td><td class='l'>{esc(s['solver'])}{note}</td>"
        if "skipped" in s:
            o.append(f"<tr class='na'>{head}<td colspan='8' class='l'>n/a: {esc(s['skipped'])}</td></tr>")
            continue
        if "error" in s:
            o.append(f"<tr>{head}<td colspan='8' class='l err'>{esc(s['error'])}</td></tr>")
            continue
        m = s["metrics"]
        rts = sorted(f["runtime_ms"] for f in s.get("frames", []) if isinstance(f.get("runtime_ms"), (int, float)))
        med = rts[len(rts) // 2] if rts else None
        o.append(f"<tr class='{'la' if kind(s['solver']) == 'label-anything' else ''}'>{head}<td>{m['frames']}</td>"
                 f"<td>{fmt(m['displacement_mean_px'], '{:.2f}')} / {fmt(m['displacement_median_px'], '{:.2f}')}</td>"
                 f"<td>{fmt(m['flip_rate'], '{:.1%}')}</td><td>{fmt(m['nesting_rate'], '{:.1%}')}</td>"
                 f"<td>{fmt(m['nesting_fraction_mean'], '{:.3f}')}</td><td>{m['added_total']}</td>"
                 f"<td>{m['removed_total']}</td><td>{fmt(med, '{:,.1f}')}</td></tr>")
    o.append("</table></div>")
    for s in report["sequences"]:
        if s.get("images"):
            o.append(f"<h3>{esc(s['sequence'])} — {esc(s['solver'])}</h3><div class='imgs'>")
            for im in s["images"]:
                o.append(f"<figure><img loading='lazy' src='{esc(im)}' alt='{esc(s['solver'])} {esc(Path(im).stem)}'>"
                         f"<figcaption>{esc(Path(im).stem)}</figcaption></figure>")
            o.append("</div>")
    return o


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
}


def _baselines_section(report: dict) -> list[str]:
    present = [s for s in report["solvers"] if s in BASELINE_METHODS]
    if not present:
        return []
    o = ["<h2 id='baselines'>Baseline methods</h2><p class='note'>Every tool is handed the problem's own label "
         "boxes (spec §5 measurement, padding included), canvas pixel coordinates and the items in the problem's "
         "priority order (input order; vega-label: <code>sort</code>); results are scored by the same evaluator and "
         "drawn by the same renderer. Details, parameters and every emulation: <code>bench/baselines/README.md"
         "</code>.</p><div class='scroll'><table><tr><th class='l'>solver</th><th class='l'>version</th>"
         "<th class='l'>method</th></tr>"]
    vers = report.get("baseline_versions", {})
    for s in present:
        o.append(f"<tr><td class='l'>{esc(s)}</td><td class='l small'>{esc(vers.get(s, ''))}</td>"
                 f"<td class='l wrap'>{esc(BASELINE_METHODS[s])}</td></tr>")
    o.append("</table></div>")
    skipped = report.get("skipped_solvers") or {}
    if skipped:
        o.append("<p class='note'>Not run (toolchain missing): " + "; ".join(
            f"<b>{esc(k)}</b>: {esc(v)}" for k, v in skipped.items()) + "</p>")
    return o


def write_html(out: Path, report: dict, plots: dict | None = None) -> Path:
    plots = plots if plots is not None else write_plots(out, report)
    solvers = report["solvers"]
    scen = sorted({r["scenario"] for r in report["results"]})
    o = ["<!doctype html><html lang='en'><head><meta charset='utf-8'><title>Label Anything benchmark</title>",
         "<meta name='viewport' content='width=device-width, initial-scale=1'>", f"<style>{CSS}</style>",
         "</head><body><main>",
         "<h1>Label Anything — real-world benchmark</h1>",
         f"<p class='meta'>Suite <b>{esc(report['suite'])}</b>, {report['runs']} runs per problem for Label Anything "
         f"and external solvers, {report.get('baseline_runs', report['runs'])} for the built-in baselines; generated "
         f"{esc(report['generated_at'])}. Solvers: {esc(', '.join(solvers))}. Metric definitions: bench/README.md."
         "</p>",
         "<nav><ul><li><a href='#summary'>Summary</a></li><li><a href='#perf'>Performance targets</a></li>"
         "<li><a href='#gates'>Release gates</a></li><li><a href='#runtime'>Runtime vs. size</a></li>"
         "<li><a href='#parity'>Implementation parity</a></li><li><a href='#diff'>Changes vs. previous release</a>"
         "</li>"
         + "".join(f"<li><a href='#sc-{esc(s)}'>{esc(s)}</a></li>" for s in scen)
         + ("<li><a href='#sequences'>Stability sequences</a></li>" if report.get("sequences") else "")
         + "<li><a href='#baselines'>Baseline methods</a></li>"
         + ("<li><a href='gallery/'>Gallery</a></li>" if (out / "gallery" / "index.html").exists() else "")
         + "</ul></nav>",
         "<h2 id='summary'>Summary</h2>"]
    o += _summary_table(report)
    o += _perf_section(report.get("perf"))
    o += _gate_section(report.get("gate"))
    o += _plots_section(report, plots)
    o += _parity_section(report.get("parity"))
    o += _diff_section(report.get("diff"))
    o += _scenario_sections(report)
    o += _sequence_section(report)
    o += _baselines_section(report)
    o.append("</main></body></html>")
    p = out / "index.html"
    p.write_text("\n".join(o) + "\n", encoding="utf-8")
    return p


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
