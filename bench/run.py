"""Benchmark runner: solve every problem with every solver, evaluate, render, report.

    python bench/run.py [--suite quick|full] [--solver SPEC ...] [--runs 7] [--scenario NN ...]
                        [--out bench-report] [--no-render] [--timeout 600]

Solvers (``--solver``, repeatable; default: the built-in baselines ``naive`` and ``greedy``):

* ``naive`` / ``greedy``                 built-in Python baselines (bench/solvers/),
* ``NAME=COMMAND``                       external command template with ``{problem}`` and
                                         ``{result}`` placeholders, e.g.
                                         ``rust=label-anything place {problem} -o {result}``.

Problems are discovered from ``bench/out/problems/*/scenario.json``: the quick suite
takes the configs marked ``quick`` (one small config per scenario) and the quick
sequence of scenario 11; the full suite takes everything. Each (solver, problem) is
run ``--runs`` times; runtime = median and p95 (nearest rank) of the wall time and of
``stats.runtime_ms``; the last result is evaluated (and compared with the first for
determinism). Sequences are solved frame by frame with ``warm_start`` = the previous
result, every previous box shifted by its anchor's movement.

Output: ``<out>/results.json`` (all metrics), ``<out>/index.html`` (tables + images),
``<out>/results/…`` (result JSON), ``<out>/metrics/…``, ``<out>/img/…``.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import os
import shlex
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bench import render  # noqa: E402
from bench.common import paths  # noqa: E402
from bench.common.jsonio import read_json, write_json  # noqa: E402
from bench.common.model import load_problem  # noqa: E402
from bench.eval import evaluate, evaluate_sequence  # noqa: E402
from bench.solvers import greedy, naive  # noqa: E402

BUILTIN = {"naive": naive.solve, "greedy": greedy.solve}
SUMMARY_COLS = [("placed_rate", "placed", "{:.1%}"), ("hard_violations", "hard viol.", "{:d}"),
                ("leader_crossings", "crossings", "{:d}"), ("ambiguity_rate", "ambig.", "{:.1%}"),
                ("priority_inversions", "inversions", "{:d}"), ("ndcg_at_k", "NDCG@k", "{:.3f}"),
                ("adjacent_gap_abs_mean", "gap px", "{:.2f}"), ("position_rank_mean", "pos. rank", "{:.2f}"),
                ("soft_coverage_mean", "soft cov.", "{:.3f}")]


# ---------------------------------------------------------------------------
# discovery
# ---------------------------------------------------------------------------
def discover(root: Path, suite: str, scenarios: list[str] | None):
    problems, sequences = [], []
    for man_path in sorted(root.glob("*/scenario.json")):
        man = read_json(man_path)
        sc = man["scenario"]
        if scenarios and not any(sc == s or sc.startswith(s.zfill(2) + "-") or sc.startswith(s + "-")
                                 for s in scenarios):
            continue
        for c in man.get("configs", []):
            if c.get("sequence_frame"):
                continue
            if suite == "full" or c.get("quick"):
                problems.append({"scenario": sc, "title": man.get("title", sc), "config": c["name"],
                                 "description": c.get("description", ""), "n_items": c.get("n_items"),
                                 "path": man_path.parent / c["files"]["problem"],
                                 "truth": (man_path.parent / c["files"]["truth"]) if "truth" in c["files"] else None,
                                 "background_png": (man_path.parent / c["files"]["background_png"])
                                 if "background_png" in c["files"] else None})
        for s in man.get("sequences", []):
            if suite == "full" or s.get("quick"):
                sequences.append({"scenario": sc, "title": man.get("title", sc), "name": s["name"],
                                  "manifest": man_path.parent / s["manifest"]})
    return problems, sequences


# ---------------------------------------------------------------------------
# solving
# ---------------------------------------------------------------------------
class Solver:
    def __init__(self, spec: str):
        if spec in BUILTIN:
            self.name, self.cmd, self.fn = spec, None, BUILTIN[spec]
        elif "=" in spec:
            self.name, self.cmd = spec.split("=", 1)
            self.fn = None
        else:
            raise SystemExit(f"unknown solver {spec!r} (built-ins: {', '.join(BUILTIN)}; or NAME=COMMAND)")

    def solve(self, problem: dict, problem_path: Path, result_path: Path, timeout: float) -> tuple[dict, float]:
        result_path.parent.mkdir(parents=True, exist_ok=True)
        if self.fn is not None:
            t0 = time.perf_counter()
            res = self.fn(problem)
            wall = (time.perf_counter() - t0) * 1000.0
            write_json(result_path, res, nd=3)
            return res, wall
        cmd = self.cmd.format(problem=shlex.quote(str(problem_path)), result=shlex.quote(str(result_path)))
        t0 = time.perf_counter()
        r = subprocess.run(shlex.split(cmd), capture_output=True, text=True, timeout=timeout)
        wall = (time.perf_counter() - t0) * 1000.0
        if r.returncode != 0:
            raise RuntimeError(f"{self.name} failed ({r.returncode}): {r.stderr.strip()[:500]}")
        return read_json(result_path), wall


def pct(vals: list[float], q: float) -> float:
    s = sorted(vals)
    k = max(0, min(len(s) - 1, math.ceil(q * len(s)) - 1))
    return s[k]


def digest(res: dict) -> str:
    keep = [{k: p.get(k) for k in ("id", "placed", "box", "leader")} for p in res.get("placements", [])]
    return hashlib.sha256(json.dumps(keep, sort_keys=True).encode()).hexdigest()[:16]


def run_problem(solver: Solver, prob_entry: dict, out: Path, runs: int, timeout: float, do_render: bool) -> dict:
    problem = read_json(prob_entry["path"])
    rel = Path(prob_entry["scenario"]) / prob_entry["config"]
    res_path = out / "results" / solver.name / rel.with_suffix(".json")
    walls, reported, digests = [], [], []
    res = None
    error = None
    for _ in range(runs):
        try:
            res, wall = solver.solve(problem, prob_entry["path"], res_path, timeout)
        except Exception as e:  # noqa: BLE001 - report and continue
            error = f"{type(e).__name__}: {e}"
            break
        walls.append(wall)
        rt = (res.get("stats") or {}).get("runtime_ms")
        if isinstance(rt, (int, float)):
            reported.append(float(rt))
        digests.append(digest(res))
    entry = {"solver": solver.name, "scenario": prob_entry["scenario"], "config": prob_entry["config"],
             "problem": str(prob_entry["path"].relative_to(paths.REPO)), "n_items": prob_entry["n_items"]}
    if error is not None or res is None:
        entry["error"] = error
        return entry
    truth = read_json(prob_entry["truth"]) if prob_entry["truth"] else None
    metrics = evaluate(problem, res, truth)
    metrics["runtime"]["wall_ms"] = {"median": statistics.median(walls), "p95": pct(walls, 0.95), "runs": walls}
    if reported:
        metrics["runtime"]["reported_ms"] = {"median": statistics.median(reported), "p95": pct(reported, 0.95)}
    metrics["deterministic"] = len(set(digests)) == 1
    mpath = out / "metrics" / solver.name / rel.with_suffix(".json")
    write_json(mpath, metrics, nd=6, indent=1)
    entry.update({"result": str(res_path.relative_to(out)), "metrics": str(mpath.relative_to(out)),
                  "summary": metrics["summary"], "runtime": metrics["runtime"]["wall_ms"],
                  "runtime_reported": metrics["runtime"].get("reported_ms"),
                  "deterministic": metrics["deterministic"]})
    if do_render:
        img = out / "img" / solver.name / rel.with_suffix(".png")
        img.parent.mkdir(parents=True, exist_ok=True)
        render.render_png(problem, res, prob_entry["background_png"]).save(img, optimize=True)
        entry["image"] = str(img.relative_to(out))
    return entry


def shifted_warm_start(prev_problem: dict, prev_result: dict, problem: dict) -> dict:
    """Previous placements with every box shifted by its anchor's movement between the frames."""
    pa = {it.id: it.ref for it in load_problem(prev_problem).items}
    na = {it.id: it.ref for it in load_problem(problem).items}
    out = []
    for p in prev_result.get("placements", []):
        i = p["id"]
        if i not in na or i not in pa:
            continue
        q = {"id": i, "placed": bool(p.get("placed"))}
        if p.get("placed") and "box" in p:
            dx, dy = na[i][0] - pa[i][0], na[i][1] - pa[i][1]
            b = p["box"]
            q["box"] = {"x": round(b["x"] + dx, 3), "y": round(b["y"] + dy, 3), "w": b["w"], "h": b["h"]}
        out.append(q)
    return {"placements": out}


def run_sequence(solver: Solver, seq: dict, out: Path, timeout: float, do_render: bool) -> dict:
    man = read_json(seq["manifest"])
    base = seq["manifest"].parent
    frames, steps, per_frame = [], [], []
    prev = None
    tmp = out / "tmp" / solver.name / seq["scenario"] / seq["name"]
    for fr in man["frames"]:
        problem = read_json(base / fr["file"])
        if prev is not None and man.get("warm_start", True):
            problem = dict(problem)
            problem["warm_start"] = shifted_warm_start(prev[0], prev[1], problem)
        ppath = tmp / fr["file"]
        write_json(ppath, problem, nd=3)
        rpath = out / "results" / solver.name / seq["scenario"] / seq["name"] / fr["file"]
        try:
            res, wall = solver.solve(problem, ppath, rpath, timeout)
        except Exception as e:  # noqa: BLE001
            return {"solver": solver.name, "scenario": seq["scenario"], "sequence": seq["name"],
                    "error": f"{type(e).__name__}: {e}"}
        frames.append((problem, res))
        steps.append(fr.get("step", "unknown"))
        placed = sum(1 for p in res.get("placements", []) if p.get("placed"))
        per_frame.append({"file": fr["file"], "items": len(problem["items"]), "placed": placed, "wall_ms": wall,
                          "runtime_ms": (res.get("stats") or {}).get("runtime_ms")})
        prev = (problem, res)
    m = evaluate_sequence(frames, steps)
    entry = {"solver": solver.name, "scenario": seq["scenario"], "sequence": seq["name"], "metrics": m,
             "frames": per_frame}
    if do_render and frames:
        imgs = []
        for k in (0, len(frames) // 2, len(frames) - 1):
            img = out / "img" / solver.name / seq["scenario"] / seq["name"] / f"frame{k:03d}.png"
            img.parent.mkdir(parents=True, exist_ok=True)
            render.render_png(frames[k][0], frames[k][1]).save(img, optimize=True)
            imgs.append(str(img.relative_to(out)))
        entry["images"] = imgs
    return entry


# ---------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------
def fmt(v, f):
    if v is None:
        return "–"
    try:
        if "d" in f:
            return f.format(int(v))
        return f.format(v)
    except (TypeError, ValueError):
        return str(v)


def write_html(out: Path, report: dict) -> Path:
    solvers = report["solvers"]
    by_sc: dict[str, list] = {}
    for r in report["results"]:
        by_sc.setdefault(r["scenario"], []).append(r)
    o = ["<!doctype html><html><head><meta charset='utf-8'><title>Label Anything benchmark</title>",
         "<meta name='viewport' content='width=device-width, initial-scale=1'>",
         "<style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#222;background:#fff}"
         "table{border-collapse:collapse;margin:8px 0 16px}td,th{border:1px solid #ddd;padding:3px 7px;"
         "text-align:right}th{background:#f3f3f3}td.l,th.l{text-align:left}img{max-width:100%;border:1px solid #ccc}"
         ".imgs{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:10px}"
         "figure{margin:0}figcaption{font-size:12px;color:#555}h2{margin-top:36px}.err{color:#b00}</style>",
         "</head><body>",
         f"<h1>Label Anything — real-world benchmark</h1><p>Suite <b>{html.escape(report['suite'])}</b>, "
         f"{report['runs']} runs per problem, generated {html.escape(report['generated_at'])}. Solvers: "
         f"{', '.join(html.escape(s) for s in solvers)}. Metrics: see bench/README.md.</p>"]
    for sc in sorted(by_sc):
        rows = by_sc[sc]
        o.append(f"<h2>{html.escape(sc)}</h2>")
        o.append("<table><tr><th class='l'>config</th><th class='l'>solver</th><th>items</th>"
                 + "".join(f"<th>{html.escape(h)}</th>" for _, h, _f in SUMMARY_COLS)
                 + "<th>wall ms (median / p95)</th><th>det.</th></tr>")
        for r in sorted(rows, key=lambda r: (r["config"], solvers.index(r["solver"]))):
            if "error" in r:
                o.append(f"<tr><td class='l'>{html.escape(r['config'])}</td><td class='l'>"
                         f"{html.escape(r['solver'])}</td><td colspan='{len(SUMMARY_COLS) + 3}' class='l err'>"
                         f"{html.escape(r['error'])}</td></tr>")
                continue
            s = r["summary"]
            rt = r["runtime"]
            o.append(f"<tr><td class='l'>{html.escape(r['config'])}</td><td class='l'>{html.escape(r['solver'])}</td>"
                     f"<td>{r['n_items']}</td>"
                     + "".join(f"<td>{fmt(s.get(k), f)}</td>" for k, _h, f in SUMMARY_COLS)
                     + f"<td>{rt['median']:.1f} / {rt['p95']:.1f}</td><td>{'yes' if r['deterministic'] else 'NO'}</td></tr>")
        o.append("</table>")
        for cfg in sorted({r["config"] for r in rows}):
            o.append(f"<h3>{html.escape(cfg)}</h3><div class='imgs'>")
            for r in sorted((r for r in rows if r["config"] == cfg), key=lambda r: solvers.index(r["solver"])):
                if r.get("image"):
                    o.append(f"<figure><img loading='lazy' src='{html.escape(r['image'])}' alt=''>"
                             f"<figcaption>{html.escape(r['solver'])}</figcaption></figure>")
            o.append("</div>")
    if report.get("sequences"):
        o.append("<h2>Stability sequences</h2><table><tr><th class='l'>sequence</th><th class='l'>solver</th>"
                 "<th>frames</th><th>displacement px (mean / median)</th><th>flip rate</th><th>nesting rate</th>"
                 "<th>nesting fraction</th><th>added</th><th>removed</th></tr>")
        for s in report["sequences"]:
            if "error" in s:
                o.append(f"<tr><td class='l'>{html.escape(s['sequence'])}</td><td class='l'>{html.escape(s['solver'])}"
                         f"</td><td colspan='7' class='l err'>{html.escape(s['error'])}</td></tr>")
                continue
            m = s["metrics"]
            o.append(f"<tr><td class='l'>{html.escape(s['sequence'])}</td><td class='l'>{html.escape(s['solver'])}</td>"
                     f"<td>{m['frames']}</td><td>{fmt(m['displacement_mean_px'], '{:.2f}')} / "
                     f"{fmt(m['displacement_median_px'], '{:.2f}')}</td><td>{fmt(m['flip_rate'], '{:.1%}')}</td>"
                     f"<td>{fmt(m['nesting_rate'], '{:.1%}')}</td><td>{fmt(m['nesting_fraction_mean'], '{:.3f}')}</td>"
                     f"<td>{m['added_total']}</td><td>{m['removed_total']}</td></tr>")
        o.append("</table>")
        for s in report["sequences"]:
            if s.get("images"):
                o.append(f"<h3>{html.escape(s['sequence'])} — {html.escape(s['solver'])}</h3><div class='imgs'>")
                for im in s["images"]:
                    o.append(f"<figure><img loading='lazy' src='{html.escape(im)}' alt=''><figcaption>"
                             f"{html.escape(Path(im).stem)}</figcaption></figure>")
                o.append("</div>")
    o.append("</body></html>")
    p = out / "index.html"
    p.write_text("\n".join(o) + "\n", encoding="utf-8")
    return p


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--suite", choices=["quick", "full"], default="quick")
    ap.add_argument("--solver", action="append", help="naive | greedy | NAME=COMMAND (repeatable)")
    ap.add_argument("--runs", type=int, default=7, help="runs per problem (median and p95 runtime)")
    ap.add_argument("--scenario", action="append", help="restrict to scenario ids/names (repeatable)")
    ap.add_argument("--problems", default=str(paths.PROBLEMS))
    ap.add_argument("--out", default=str(paths.REPORT))
    ap.add_argument("--no-render", action="store_true")
    ap.add_argument("--timeout", type=float, default=600.0, help="seconds per external solver run")
    a = ap.parse_args(argv)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    solvers = [Solver(s) for s in (a.solver or ["naive", "greedy"])]
    problems, sequences = discover(Path(a.problems), a.suite, a.scenario)
    if not problems and not sequences:
        print("no problems found; run `python -m bench.scenarios build` first", file=sys.stderr)
        return 1
    report = {"generated_at": time.strftime("%Y-%m-%d %H:%M:%S"), "suite": a.suite, "runs": a.runs,
              "solvers": [s.name for s in solvers], "python": sys.version.split()[0],
              "problems": [{k: (str(v.relative_to(paths.REPO)) if isinstance(v, Path) else v)
                            for k, v in p.items()} for p in problems],
              "results": [], "sequences": []}
    for p in problems:
        for s in solvers:
            t0 = time.time()
            r = run_problem(s, p, out, a.runs, a.timeout, not a.no_render)
            report["results"].append(r)
            msg = r.get("error") or (f"placed {r['summary']['placed']}/{r['summary']['total']}, "
                                     f"hard {r['summary']['hard_violations']}, "
                                     f"wall {r['runtime']['median']:.1f} ms")
            print(f"{s.name:>8}  {p['scenario']}/{p['config']}: {msg}  ({time.time() - t0:.1f} s)")
    for q in sequences:
        for s in solvers:
            t0 = time.time()
            r = run_sequence(s, q, out, a.timeout, not a.no_render)
            report["sequences"].append(r)
            msg = r.get("error") or (f"nesting {fmt(r['metrics']['nesting_rate'], '{:.1%}')}, "
                                     f"displacement {fmt(r['metrics']['displacement_mean_px'], '{:.2f}')} px")
            print(f"{s.name:>8}  {q['scenario']}/{q['name']}: {msg}  ({time.time() - t0:.1f} s)")
    write_json(out / "results.json", report, nd=6, indent=1)
    fonts = out / "fonts"
    fonts.mkdir(exist_ok=True)
    shutil.copy2(paths.FONTS / "NotoSans-Regular.ttf", fonts / "NotoSans-Regular.ttf")
    shutil.copy2(paths.FONTS / "OFL.txt", fonts / "OFL.txt")
    page = write_html(out, report)
    shutil.rmtree(out / "tmp", ignore_errors=True)
    print(f"wrote {out / 'results.json'} and {page}")
    return 0 if not any("error" in r for r in report["results"] + report["sequences"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
