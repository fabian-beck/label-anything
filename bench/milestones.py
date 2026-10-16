"""Acceptance checks of the brief's milestones M3 and M4 on a benchmark run.

* **M3 (leaders):** 0 leader crossings on every problem and every sequence frame (these
  evaluated here from the frame results next to ``results.json``), for every Label
  Anything solver of the run.
* **M4 (optimization):** on the dense problems — those where the greedy solve omits labels
  (``placed_rate`` < 1) — the full solve (local search, ejection chains) improves
  ``placed_weighted`` by at least 5 % over the greedy solve at the same budget (relative,
  mean over the dense problems), with no new priority inversions (per problem, the full
  solve has at most the greedy solve's inversions).

The greedy solve is a Label Anything solver whose name ends in ``-greedy``, run with
``--strategy greedy``; the full solve is the solver of the same name without the suffix::

    E=rust/target/release/label-anything
    python bench/run.py --suite full --engine $E --runs 1 --warmup 0 --no-render --out /tmp/m \\
        --solver "rust-greedy=$E place {problem} -o {result} --strategy greedy"
    python -m bench.milestones /tmp/m/results.json

Exit code 0 when both checks pass, 1 otherwise.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .common import paths
from .common.jsonio import read_json
from .eval import evaluate
from .perf import implementation

GREEDY_SUFFIX = "-greedy"
M4_MIN_GAIN = 0.05


def frame_crossings(out: Path, seq: dict) -> list[tuple[str, int | None]]:
    """(frame, leader crossings) of a solved sequence; None when the frame result is missing."""
    src = paths.BENCH / "out" / "problems" / seq["scenario"] / seq["sequence"]
    res_dir = out / "results" / seq["solver"] / seq["scenario"] / seq["sequence"]
    rows = []
    for f in seq.get("frames", []):
        rp = res_dir / f["file"]
        if not rp.exists():
            rows.append((f["file"], None))
            continue
        truth = src / (Path(f["file"]).stem + ".truth.json")
        m = evaluate(read_json(src / f["file"]), read_json(rp), read_json(truth) if truth.exists() else None)
        rows.append((f["file"], m["leaders"]["crossings"]))
    return rows


def m3(report: dict, out: Path | None = None) -> tuple[bool, list[str]]:
    """Leader crossings of every Label Anything solver, problems and sequence frames."""
    lines, ok, n = [], True, 0
    for r in report.get("results", []):
        if not implementation(r["solver"]):
            continue
        n += 1
        x = (r.get("summary") or {}).get("leader_crossings")
        if x is None:
            ok = False
            lines.append(f"  {r['solver']} {r['scenario']}/{r['config']}: not evaluated")
        elif x:
            ok = False
            lines.append(f"  {r['solver']} {r['scenario']}/{r['config']}: {x} crossings")
    for s in report.get("sequences", []):
        if not implementation(s.get("solver", "")) or out is None:
            continue
        for file, x in frame_crossings(out, s):
            n += 1
            if x is None:
                ok = False
                lines.append(f"  {s['solver']} {s['sequence']}/{file}: result missing")
            elif x:
                ok = False
                lines.append(f"  {s['solver']} {s['sequence']}/{file}: {x} crossings")
    head = f"M3 {'pass' if ok else 'FAIL'}: 0 leader crossings on all {n} solves" if ok else \
        f"M3 FAIL: leader crossings (of {n} solves)"
    return ok, [head, *lines]


def m4(report: dict, min_gain: float = M4_MIN_GAIN) -> tuple[bool, list[str]]:
    """placed_weighted of each full solver against its ``-greedy`` twin on dense problems."""
    by = {(r["solver"], r["scenario"], r["config"]): r.get("summary") or {}
          for r in report.get("results", [])}
    greedy_solvers = sorted({s for s, _, _ in by if implementation(s) and s.endswith(GREEDY_SUFFIX)})
    if not greedy_solvers:
        return False, [f"M4 FAIL: no Label Anything solver named *{GREEDY_SUFFIX} in the run"]
    ok, lines = True, []
    for g in greedy_solvers:
        full = g[: -len(GREEDY_SUFFIX)]
        gains, rows, new_inv = [], [], []
        for (s, sc, cfg), gs in sorted(by.items()):
            if s != g or (full, sc, cfg) not in by:
                continue
            fs = by[(full, sc, cfg)]
            if gs.get("placed_rate") is None or gs["placed_rate"] >= 1 or not gs.get("placed_weighted"):
                continue
            gain = fs["placed_weighted"] / gs["placed_weighted"] - 1
            gains.append(gain)
            gi, fi = gs.get("priority_inversions") or 0, fs.get("priority_inversions") or 0
            if fi > gi:
                new_inv.append(f"{sc}/{cfg}: {gi} -> {fi}")
            rows.append(f"  {sc}/{cfg}: placed_weighted {gs['placed_weighted']:.3f} -> "
                        f"{fs['placed_weighted']:.3f} ({gain:+.1%}), placed {gs.get('placed')} -> "
                        f"{fs.get('placed')}, inversions {gi} -> {fi}")
        if not gains:
            ok = False
            lines.append(f"M4 FAIL: {full} vs {g}: no dense problem (greedy placing < 100 %)")
            continue
        mean = sum(gains) / len(gains)
        passed = mean >= min_gain and not new_inv
        ok &= passed
        lines.append(f"M4 {'pass' if passed else 'FAIL'}: {full} vs {g} on {len(gains)} dense problems: "
                     f"placed_weighted {mean:+.1%} on average (needs {min_gain:+.0%}), "
                     f"{len(new_inv)} with new priority inversions")
        lines += rows
    return ok, lines


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("results", help="results.json of bench/run.py")
    ap.add_argument("--min-gain", type=float, default=M4_MIN_GAIN, help="M4: required mean relative gain")
    a = ap.parse_args(argv)
    report = read_json(a.results)
    ok3, l3 = m3(report, Path(a.results).parent)
    ok4, l4 = m4(report, a.min_gain)
    print("\n".join(l3 + l4))
    return 0 if ok3 and ok4 else 1


if __name__ == "__main__":
    sys.exit(main())
