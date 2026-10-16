"""Naive baseline: every label top-right of its anchor, no collision handling.

The label box touches the item's true shape inflated by ``placement.offset``
(spec §6.1 support-function position); area anchors get an internal label at
their pole of inaccessibility. This exists so the whole pipeline (problems →
results → evaluator → renderer → report) is testable without the engine, and as
the "no placement intelligence" reference row of the report.

    python -m bench.solvers.naive problem.json -o result.json
"""
from __future__ import annotations

import argparse
import time

from ..common.geom import Box
from ..common.jsonio import read_json, write_json
from ..common.model import adjacent_box, load_problem
from .common import placement, result

IMPLEMENTATION = "bench-naive/0.1"


def solve(problem: dict) -> dict:
    t0 = time.perf_counter()
    prob = load_problem(problem)
    out = []
    for it in prob.items:
        w, h = it.label.w, it.label.h
        if it.anchor_type == "area":
            c = it.area.inner_center()
            out.append(placement(it, Box(c[0] - w / 2, c[1] - h / 2, c[0] + w / 2, c[1] + h / 2),
                                 "internal", "internal"))
        else:
            out.append(placement(it, adjacent_box(it.shape, it.offset, w, h, "top-right"), "top-right", "adjacent"))
    return result(out, (time.perf_counter() - t0) * 1000.0, IMPLEMENTATION)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("problem")
    ap.add_argument("-o", "--out", required=True)
    a = ap.parse_args(argv)
    write_json(a.out, solve(read_json(a.problem)), nd=3)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
