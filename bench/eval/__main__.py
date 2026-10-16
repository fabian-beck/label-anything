"""CLI of the evaluator.

    python -m bench.eval PROBLEM.json RESULT.json [--truth TRUTH.json] [-o METRICS.json]
    python -m bench.eval sequence SEQUENCE.json --results DIR [-o METRICS.json]

Without ``--truth``, ``<problem>.truth.json`` next to the problem is used when it
exists. Metrics are printed as JSON (sorted keys) to stdout or written to ``-o``.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from ..common.jsonio import read_json, write_json
from . import evaluate, evaluate_sequence


def default_truth(problem: Path) -> Path | None:
    t = problem.with_name(problem.name[:-len(".json")] + ".truth.json") if problem.name.endswith(".json") else None
    return t if t is not None and t.exists() else None


def _emit(obj, out: str | None) -> None:
    if out:
        write_json(out, obj, nd=6, indent=1)
    else:
        json.dump(obj, sys.stdout, indent=1, sort_keys=True, ensure_ascii=False)
        sys.stdout.write("\n")


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "sequence":
        ap = argparse.ArgumentParser(prog="python -m bench.eval sequence")
        ap.add_argument("sequence", help="sequence manifest (sequence.json)")
        ap.add_argument("--results", required=True, help="directory with one result per frame (same file names)")
        ap.add_argument("-o", "--out")
        a = ap.parse_args(argv[1:])
        man_path = Path(a.sequence)
        man = read_json(man_path)
        frames, steps = [], []
        for fr in man["frames"]:
            frames.append((read_json(man_path.parent / fr["file"]), read_json(Path(a.results) / fr["file"])))
            steps.append(fr.get("step", "unknown"))
        _emit(evaluate_sequence(frames, steps), a.out)
        return 0
    ap = argparse.ArgumentParser(prog="python -m bench.eval", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("problem")
    ap.add_argument("result")
    ap.add_argument("--truth", help="truth.json (default: <problem>.truth.json if present)")
    ap.add_argument("-o", "--out", help="write metrics JSON here instead of stdout")
    ap.add_argument("--no-removal-test", action="store_true", help="skip the priority removal test")
    ap.add_argument("--summary", action="store_true", help="print only the flat summary")
    a = ap.parse_args(argv)
    p = Path(a.problem)
    truth_path = Path(a.truth) if a.truth else default_truth(p)
    m = evaluate(read_json(p), read_json(a.result), read_json(truth_path) if truth_path else None,
                 removal_test=not a.no_removal_test)
    m["files"] = {"problem": str(p), "result": a.result, "truth": str(truth_path) if truth_path else None}
    _emit(m["summary"] if a.summary else m, a.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
