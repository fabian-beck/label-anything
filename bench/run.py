"""Benchmark runner: solve every problem with every solver, evaluate, render, report.

    python bench/run.py [--suite quick|full] [--solver SPEC ...] [--engine PATH] [--baselines]
                        [--runs 7] [--baseline-runs 1] [--scenario NN ...] [--out bench-report]
                        [--perf] [--previous OLD/results.json] [--gate] [--no-render] [--timeout 600]

Solvers (``--solver``, repeatable; default: the built-in baselines ``naive`` and ``greedy``):

* ``naive`` / ``greedy``                 built-in Python baselines (bench/solvers/),
* ``textalloc`` / ``adjusttext`` /       third-party baselines (bench/baselines/; skipped with a
  ``vega-label`` / ``ggrepel``           message when their toolchain is missing),
* ``NAME=COMMAND``                       external command template with ``{problem}`` and
                                         ``{result}`` placeholders, e.g.
                                         ``rust=label-anything place {problem} -o {result}``.

Solvers named ``rust``, ``wasm`` or ``ts`` (optionally ``-suffix``) are Label Anything
implementations: they get the performance targets, the parity table and the release
gates. ``--engine PATH`` adds ``rust=PATH place {problem} -o {result}`` and its debug
overlay; ``--baselines`` adds all six baselines (what ``label-anything bench --baselines``
passes). ``--overlay NAME=COMMAND`` (placeholders ``{problem}``, ``{result}``, ``{svg}``)
renders an engine debug overlay next to the benchmark rendering, from one extra untimed run.

Problems are discovered from ``bench/out/problems/*/scenario.json``: the quick suite
takes the configs marked ``quick`` (one small config per scenario) and the quick
sequence of scenario 11; the full suite takes everything. Each (solver, problem) is
run ``--runs`` times (built-in and third-party baselines ``--baseline-runs`` times);
runtime = median and p95 (nearest rank) of the wall time and of ``stats.runtime_ms``;
the last result is evaluated (and compared with the first for determinism). Sequences
are solved frame by frame with ``warm_start`` = the previous result, every previous
box shifted by its anchor's movement. A baseline that cannot express a problem at all
is reported "n/a" with the reason.

``--perf`` measures the performance targets (bench/perf), ``--previous`` adds the
changes against an earlier results.json, ``--gate`` evaluates the release gates
(bench/gates.py; implies ``--perf``) and makes the exit code reflect them.

Output: ``<out>/results.json`` (all metrics), ``<out>/index.html`` (report),
``<out>/results/…`` (result JSON), ``<out>/metrics/…``, ``<out>/img/…``, ``<out>/overlay/…``,
``<out>/plots/…``.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shlex
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bench import render  # noqa: E402
from bench import report as rep  # noqa: E402
from bench.baselines import BASELINES, Unsupported  # noqa: E402
from bench.baselines.results import baseline_info  # noqa: E402
from bench.common import paths  # noqa: E402
from bench.common.jsonio import read_json, write_json  # noqa: E402
from bench.common.model import load_problem  # noqa: E402
from bench.eval import evaluate, evaluate_sequence  # noqa: E402
from bench.perf import implementation  # noqa: E402
from bench.solvers import greedy, naive  # noqa: E402

BUILTIN = {"naive": naive.solve, "greedy": greedy.solve}
BUILTIN_NAMES = set(BUILTIN) | set(BASELINES)
ALL_BASELINES = ["naive", "greedy", "textalloc", "adjusttext", "vega-label", "ggrepel"]
SUMMARY_COLS = [("placed_rate", "placed", "{:.1%}"), ("hard_violations", "hard viol.", "{:d}"),
                ("leader_crossings", "crossings", "{:d}"), ("ambiguity_rate", "ambig.", "{:.1%}"),
                ("priority_inversions", "inversions", "{:d}"), ("ndcg_at_k", "NDCG@k", "{:.3f}"),
                ("adjacent_gap_abs_mean", "gap px", "{:.2f}"), ("position_rank_mean", "pos. rank", "{:.2f}"),
                ("soft_coverage_mean", "soft cov.", "{:.3f}")]
fmt = rep.fmt


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


def _rel(p: Path) -> str:
    try:
        return str(Path(p).resolve().relative_to(paths.REPO))
    except ValueError:
        return str(p)


# ---------------------------------------------------------------------------
# solving
# ---------------------------------------------------------------------------
class Solver:
    """A built-in baseline (naive, greedy), a third-party baseline or an external command."""

    def __init__(self, spec: str, overlay: str | None = None):
        self.overlay = overlay
        self.cmd = None
        self.fn = None
        self.baseline = None
        if spec in BUILTIN:
            self.name, self.kind = spec, "builtin"
            self.fn = lambda problem, _path, f=BUILTIN[spec]: f(problem)
        elif spec in BASELINES:
            self.name, self.kind = spec, "baseline"
            self.baseline = BASELINES[spec]
            self.fn = lambda problem, path, b=self.baseline: b.solve(problem, path)
        elif "=" in spec:
            self.name, self.cmd = spec.split("=", 1)
            self.kind = "external"
        else:
            raise SystemExit(f"unknown solver {spec!r} (built-ins: {', '.join(sorted(BUILTIN_NAMES))}; "
                             "or NAME=COMMAND)")

    @property
    def is_baseline(self) -> bool:
        return self.kind in ("builtin", "baseline")

    @property
    def is_la(self) -> bool:
        return self.kind == "external" and implementation(self.name) is not None

    def warmup(self) -> None:
        """One-time tool start-up (imports, font registration) outside the timed runs."""
        if self.baseline is not None:
            mod = self.baseline.load()
            if hasattr(mod, "warmup"):
                mod.warmup()

    def solve(self, problem: dict, problem_path: Path, result_path: Path, timeout: float) -> tuple[dict, float]:
        result_path.parent.mkdir(parents=True, exist_ok=True)
        if self.fn is not None:
            t0 = time.perf_counter()
            res = self.fn(problem, problem_path)
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

    def render_overlay(self, problem_path: Path, svg_path: Path, timeout: float) -> None:
        svg_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="la-overlay-") as d:
            cmd = self.overlay.format(problem=shlex.quote(str(problem_path)),
                                      result=shlex.quote(str(Path(d) / "result.json")), svg=shlex.quote(str(svg_path)))
            r = subprocess.run(shlex.split(cmd), capture_output=True, text=True, timeout=timeout)
        if r.returncode != 0 or not svg_path.exists():
            raise RuntimeError(f"overlay failed ({r.returncode}): {r.stderr.strip()[:300]}")


def pct(vals: list[float], q: float) -> float:
    s = sorted(vals)
    k = max(0, min(len(s) - 1, math.ceil(q * len(s)) - 1))
    return s[k]


def digest(res: dict) -> str:
    keep = [{k: p.get(k) for k in ("id", "placed", "box", "leader")} for p in res.get("placements", [])]
    return hashlib.sha256(json.dumps(keep, sort_keys=True).encode()).hexdigest()[:16]


def _base_entry(solver: Solver, prob_entry: dict) -> dict:
    return {"solver": solver.name, "kind": rep.kind(solver.name), "scenario": prob_entry["scenario"],
            "config": prob_entry["config"], "problem": _rel(prob_entry["path"]), "n_items": prob_entry["n_items"]}


def run_problem(solver: Solver, prob_entry: dict, out: Path, runs: int, timeout: float, do_render: bool,
                svg: bool = False) -> dict:
    problem = read_json(prob_entry["path"])
    rel = Path(prob_entry["scenario"]) / prob_entry["config"]
    res_path = out / "results" / solver.name / rel.with_suffix(".json")
    walls, reported, digests = [], [], []
    res = None
    error = None
    entry = _base_entry(solver, prob_entry)
    for _ in range(runs):
        try:
            res, wall = solver.solve(problem, prob_entry["path"], res_path, timeout)
        except Unsupported as e:
            entry["skipped"] = str(e)
            return entry
        except Exception as e:  # noqa: BLE001 - report and continue
            error = f"{type(e).__name__}: {e}"
            break
        walls.append(wall)
        rt = (res.get("stats") or {}).get("runtime_ms")
        if isinstance(rt, (int, float)):
            reported.append(float(rt))
        digests.append(digest(res))
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
                  "deterministic": metrics["deterministic"], "digest": digests[-1],
                  "implementation": (res.get("stats") or {}).get("implementation")})
    if solver.is_baseline and solver.kind == "baseline":
        entry["baseline"] = baseline_info(res)
    if do_render:
        img = out / "img" / solver.name / rel.with_suffix(".png")
        img.parent.mkdir(parents=True, exist_ok=True)
        render.render_png(problem, res, prob_entry["background_png"]).save(img, optimize=True)
        entry["image"] = str(img.relative_to(out))
        if svg:
            sp = img.with_suffix(".svg")
            href = os.path.relpath(out / "fonts" / "NotoSans-Regular.ttf", sp.parent)
            sp.write_text(render.render_svg(problem, res, font_href=href), encoding="utf-8")
            entry["svg"] = str(sp.relative_to(out))
        if solver.overlay:
            ov = out / "overlay" / solver.name / rel.with_suffix(".svg")
            try:
                solver.render_overlay(prob_entry["path"], ov, timeout)
                entry["overlay"] = str(ov.relative_to(out))
            except Exception as e:  # noqa: BLE001 - the overlay is optional
                entry["overlay_error"] = f"{type(e).__name__}: {e}"
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
    frames, steps, per_frame, digests = [], [], [], []
    prev = None
    tmp = out / "tmp" / solver.name / seq["scenario"] / seq["name"]
    head = {"solver": solver.name, "kind": rep.kind(solver.name), "scenario": seq["scenario"], "sequence": seq["name"]}
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
        except Unsupported as e:
            return {**head, "skipped": f"frame {fr['file']}: {e}"}
        except Exception as e:  # noqa: BLE001
            return {**head, "error": f"{type(e).__name__}: {e}"}
        frames.append((problem, res))
        steps.append(fr.get("step", "unknown"))
        digests.append(digest(res))
        placed = sum(1 for p in res.get("placements", []) if p.get("placed"))
        per_frame.append({"file": fr["file"], "items": len(problem["items"]), "placed": placed, "wall_ms": wall,
                          "runtime_ms": (res.get("stats") or {}).get("runtime_ms")})
        prev = (problem, res)
    m = evaluate_sequence(frames, steps)
    entry = {**head, "metrics": m, "frames": per_frame,
             "digest": hashlib.sha256("".join(digests).encode()).hexdigest()[:16]}
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
# report (kept for callers of the old API)
# ---------------------------------------------------------------------------
def write_html(out: Path, report: dict) -> Path:
    return rep.write_html(out, report)


def build_solvers(a, log=print) -> tuple[list[Solver], dict[str, str]]:
    """Solvers from --solver / --engine / --baselines; baselines whose toolchain is missing are skipped."""
    specs: list[str] = list(a.solver or [])
    overlays = dict(o.split("=", 1) for o in (a.overlay or []) if "=" in o)
    if a.engine:
        eng = shlex.quote(str(Path(a.engine).resolve()))
        if not any(s.split("=", 1)[0] == "rust" for s in specs):
            specs.insert(0, f"rust={eng} place {{problem}} -o {{result}}")
        overlays.setdefault("rust", f"{eng} place {{problem}} -o {{result}} --debug-svg {{svg}}")
    if a.baselines:
        specs += [b for b in ALL_BASELINES if b not in specs]
    if not specs:
        specs = ["naive", "greedy"]
    solvers, skipped = [], {}
    for spec in specs:
        name = spec.split("=", 1)[0]
        if spec in BASELINES:
            why = BASELINES[spec].check()
            if why is not None:
                if a.require_baselines:
                    raise SystemExit(f"baseline {spec} requested but its toolchain is missing: {why}")
                log(f"skipping baseline {spec}: {why}")
                skipped[spec] = why
                continue
        s = Solver(spec, overlays.get(name))
        if any(t.name == s.name for t in solvers):
            raise SystemExit(f"duplicate solver name {s.name!r}")
        solvers.append(s)
    return solvers, skipped


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--suite", choices=["quick", "full"], default="quick")
    ap.add_argument("--solver", action="append",
                    help="naive | greedy | textalloc | adjusttext | vega-label | ggrepel | NAME=COMMAND (repeatable)")
    ap.add_argument("--engine", help="Rust CLI binary: adds rust=ENGINE place {problem} -o {result} and its overlay")
    ap.add_argument("--baselines", action="store_true", help="add all baselines (naive, greedy and the four tools)")
    ap.add_argument("--require-baselines", action="store_true",
                    help="fail instead of skipping a requested baseline whose toolchain is missing")
    ap.add_argument("--overlay", action="append",
                    help="NAME=COMMAND rendering the engine debug overlay ({problem}, {result}, {svg})")
    ap.add_argument("--runs", type=int, default=7, help="runs per problem (median and p95 runtime)")
    ap.add_argument("--baseline-runs", type=int, default=1, help="runs per problem for the baselines")
    ap.add_argument("--scenario", action="append", help="restrict to scenario ids/names (repeatable)")
    ap.add_argument("--problems", default=str(paths.PROBLEMS))
    ap.add_argument("--out", default=str(paths.REPORT))
    ap.add_argument("--no-render", action="store_true")
    ap.add_argument("--svg", action="store_true", help="also write SVG renderings next to the PNGs")
    ap.add_argument("--timeout", type=float, default=600.0, help="seconds per external solver run")
    ap.add_argument("--perf", action="store_true", help="measure the performance targets (bench/perf)")
    ap.add_argument("--perf-runs", type=int, default=7, help="runs per performance problem")
    ap.add_argument("--perf-problems", default=str(paths.OUT / "perf"), help="where the perf problems are written")
    ap.add_argument("--previous", help="results.json of the previous release (diff + regression gate)")
    ap.add_argument("--gate", action="store_true", help="evaluate the release gates (implies --perf); exit 1 on failure")
    ap.add_argument("--gates-allow", help="allow-list of accepted regressions (default bench/gates-allow.json)")
    ap.add_argument("--threshold", type=float, default=0.02, help="relative regression threshold")
    a = ap.parse_args(argv)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    solvers, skipped = build_solvers(a)
    problems, sequences = discover(Path(a.problems), a.suite, a.scenario)
    if not problems and not sequences:
        print("no problems found; run `python -m bench.scenarios build` first", file=sys.stderr)
        return 1
    previous = read_json(a.previous) if a.previous else None
    from bench.perf.runner import machine

    report = {"generated_at": time.strftime("%Y-%m-%d %H:%M:%S"), "suite": a.suite, "runs": a.runs,
              "baseline_runs": a.baseline_runs, "solvers": [s.name for s in solvers], "python": sys.version.split()[0],
              "machine": machine(), "skipped_solvers": skipped,
              "baseline_versions": {s.name: s.baseline.version() for s in solvers if s.baseline is not None},
              "problems": [{k: (_rel(v) if isinstance(v, Path) else v) for k, v in p.items()} for p in problems],
              "results": [], "sequences": []}
    for s in solvers:
        s.warmup()
    for p in problems:
        for s in solvers:
            t0 = time.time()
            r = run_problem(s, p, out, a.baseline_runs if s.is_baseline else a.runs, a.timeout, not a.no_render, a.svg)
            report["results"].append(r)
            if "skipped" in r:
                msg = f"n/a: {r['skipped']}"
            else:
                msg = r.get("error") or (f"placed {r['summary']['placed']}/{r['summary']['total']}, "
                                         f"hard {r['summary']['hard_violations']}, "
                                         f"wall {r['runtime']['median']:.1f} ms")
            print(f"{s.name:>10}  {p['scenario']}/{p['config']}: {msg}  ({time.time() - t0:.1f} s)", flush=True)
    for q in sequences:
        for s in solvers:
            t0 = time.time()
            r = run_sequence(s, q, out, a.timeout, not a.no_render)
            report["sequences"].append(r)
            if "skipped" in r:
                msg = f"n/a: {r['skipped']}"
            else:
                msg = r.get("error") or (f"nesting {fmt(r['metrics']['nesting_rate'], '{:.1%}')}, "
                                         f"displacement {fmt(r['metrics']['displacement_mean_px'], '{:.2f}')} px")
            print(f"{s.name:>10}  {q['scenario']}/{q['name']}: {msg}  ({time.time() - t0:.1f} s)", flush=True)
    if a.perf or a.gate:
        from bench.perf.runner import run_perf

        la = [(s.name, s.cmd) for s in solvers if s.is_la]
        report["perf"] = run_perf(la, a.perf_runs, a.perf_problems, a.timeout,
                                  log=lambda m: print(m, flush=True))
    if previous is not None:
        report["diff"] = rep.compare(previous, report, a.threshold)
    report["parity"] = rep.parity(report)
    gate = None
    if a.gate:
        from bench import gates

        allow, problems_allow = gates.load_allow(a.gates_allow)
        gate = gates.check(report, previous, allow, problems_allow, a.threshold)
        report["gate"] = gate
    fonts = out / "fonts"
    fonts.mkdir(exist_ok=True)
    shutil.copy2(paths.FONTS / "NotoSans-Regular.ttf", fonts / "NotoSans-Regular.ttf")
    shutil.copy2(paths.FONTS / "OFL.txt", fonts / "OFL.txt")
    report["plots"] = rep.write_plots(out, report)
    write_json(out / "results.json", report, nd=6, indent=1)
    page = rep.write_html(out, report, report["plots"])
    shutil.rmtree(out / "tmp", ignore_errors=True)
    print(f"wrote {out / 'results.json'} and {page}")
    if gate is not None:
        from bench import gates

        print("\n".join(gates.summary_lines(gate)))
        return 0 if gate["passed"] else 1
    return 0 if not any("error" in r for r in report["results"] + report["sequences"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
