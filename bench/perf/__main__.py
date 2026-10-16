"""Performance targets (brief §5.8): generate the problems and measure implementations.

    python -m bench.perf --engine rust/target/release/label-anything [--runs 7] [-o perf.json]
    python -m bench.perf --solver 'ts=node ts/packages/cli/dist/main.js place {problem} -o {result}'
    python -m bench.perf generate [DIR]

Exit code 0 when every measured implementation meets its targets, 1 otherwise.
"""
from __future__ import annotations

import argparse
import sys

from ..common.jsonio import write_json
from . import TARGETS
from .generate import main as generate_main
from .runner import passed, run_perf


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "generate":
        return generate_main(argv[1:])
    ap = argparse.ArgumentParser(prog="python -m bench.perf", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--engine", help="Rust CLI binary (adds the solver rust=ENGINE place {problem} -o {result})")
    ap.add_argument("--solver", action="append", default=[], help="NAME=COMMAND (NAME rust|wasm|ts[-suffix])")
    ap.add_argument("--runs", type=int, default=7)
    ap.add_argument("--problems", default="bench/out/perf", help="where the generated problems are written")
    ap.add_argument("--timeout", type=float, default=600.0)
    ap.add_argument("-o", "--out", help="write the measurements as JSON")
    a = ap.parse_args(argv)
    solvers = []
    if a.engine:
        solvers.append(("rust", f"{a.engine} place {{problem}} -o {{result}}"))
    for s in a.solver:
        if "=" not in s:
            ap.error(f"--solver expects NAME=COMMAND, got {s!r}")
        solvers.append(tuple(s.split("=", 1)))
    if not solvers:
        ap.error("give --engine or --solver")
    rep = run_perf(solvers, a.runs, a.problems, a.timeout)
    if a.out:
        write_json(a.out, rep, nd=4, indent=1)
    print(f"\n{'implementation':<16}{'problem':<14}{'metric':<20}{'median ms':>10}{'target ms':>11}  result")
    for r in rep["rows"]:
        med = f"{r['median']:.1f}" if "median" in r else "–"
        res = r.get("error") or ("ok" if r["passed"] else "MISSED")
        print(f"{r['solver']:<16}{r['problem']:<14}{r['metric']:<20}{med:>10}{r['target']:>11g}  {res}")
    if not rep["rows"]:
        print("no Label Anything implementation among the solvers (names rust, wasm, ts)", file=sys.stderr)
        return 1
    return 0 if passed(rep) else 1


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = ["main", "TARGETS"]
