"""Performance targets of Label Anything (brief §5.8), enforced by the benchmark.

Three deterministic synthetic problems (``bench/perf/generate.py``) are solved by
every Label Anything implementation that took part in a run (solver names
``rust``, ``wasm``, ``ts``, optionally with a suffix such as ``rust-local``); the
measured value is the median over ``--perf-runs`` runs of the engine's own
timing (``stats.runtime_ms``, or ``stats.phases_ms.prepare`` for the raster
target), not the process wall time, which process start-up dominates. The
engines are timed in steady state: ``--warmup`` solves of the same problem in the
same process precede each timed solve (``bench/run.py`` and ``python -m bench.perf``
pass ``--warmup 3`` to the Rust and TypeScript CLIs).

=================  ====================================================  ======  =====  =====
problem            what                                                  Rust    WASM   TS
=================  ====================================================  ======  =====  =====
scatter-200        200 labels + 10k obstacle points, 800×600, greedy     15 ms   30     60
scatter-2000       2,000 labels + 100k obstacle points, 1920×1080, greedy 120 ms 250    600
raster-2048        2048² raster background preparation (ink + SAT)       25 ms   60     150
=================  ====================================================  ======  =====  =====

    python -m bench.perf --engine rust/target/release/label-anything [--runs 7]
"""
from __future__ import annotations

import re

TARGETS: dict[str, dict] = {
    "scatter-200": {
        "title": "200 labels + 10k obstacle points (800×600)",
        "metric": "runtime_ms",
        "targets": {"rust": 15.0, "wasm": 30.0, "ts": 60.0},
    },
    "scatter-2000": {
        "title": "2,000 labels + 100k obstacle points (1920×1080), greedy",
        "metric": "runtime_ms",
        "targets": {"rust": 120.0, "wasm": 250.0, "ts": 600.0},
    },
    "raster-2048": {
        "title": "2048² raster background preparation (ink + SAT)",
        "metric": "phases_ms.prepare",
        "targets": {"rust": 25.0, "wasm": 60.0, "ts": 150.0},
    },
}

_IMPL = re.compile(r"^(?:la[-_])?(rust|wasm|ts)(?:$|[-_:.].*)", re.IGNORECASE)


def implementation(solver_name: str) -> str | None:
    """``rust`` / ``wasm`` / ``ts`` for a Label Anything solver name (``rust``, ``ts-node``, …), else None."""
    m = _IMPL.match(solver_name)
    return m.group(1).lower() if m else None
