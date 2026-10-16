"""Measure Label Anything implementations against the performance targets (``bench.perf.TARGETS``).

Each solver is an external command template with ``{problem}`` and ``{result}``
placeholders (as in ``bench/run.py``); only solvers whose name identifies an
implementation (``rust``, ``wasm``, ``ts``) are measured. Every problem is solved
``runs`` times; the value is the median of the engine-reported metric.
"""
from __future__ import annotations

import os
import platform
import shlex
import statistics
import subprocess
import tempfile
from pathlib import Path

from ..common.jsonio import read_json
from . import TARGETS, implementation
from .generate import write_all


def metric_value(result: dict, metric: str) -> float | None:
    """``runtime_ms`` or a dotted path into ``stats`` such as ``phases_ms.prepare``."""
    cur = result.get("stats") or {}
    for part in metric.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return float(cur) if isinstance(cur, (int, float)) else None


def machine() -> dict:
    cpu = platform.processor() or ""
    try:
        with open("/proc/cpuinfo", encoding="utf-8") as f:
            for line in f:
                if line.startswith("model name"):
                    cpu = line.split(":", 1)[1].strip()
                    break
    except OSError:
        pass
    return {"platform": platform.platform(), "cpu": cpu, "cores": os.cpu_count(), "python": platform.python_version()}


def solve_once(cmd: str, problem: Path, result: Path, timeout: float) -> dict:
    line = cmd.format(problem=shlex.quote(str(problem)), result=shlex.quote(str(result)))
    r = subprocess.run(shlex.split(line), capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"exit {r.returncode}: {r.stderr.strip()[:400]}")
    return read_json(result)


def run_perf(solvers: list[tuple[str, str]], runs: int = 7, problem_dir: str | Path = "bench/out/perf",
             timeout: float = 600.0, log=print) -> dict:
    """Measure every (name, command) solver that is a Label Anything implementation."""
    todo = [(n, c) for n, c in solvers if implementation(n) is not None]
    report = {"runs": runs, "machine": machine(), "targets": TARGETS, "rows": []}
    if not todo:
        return report
    paths = write_all(problem_dir)
    with tempfile.TemporaryDirectory(prefix="la-perf-") as d:
        for name, cmd in todo:
            impl = implementation(name)
            for pname, spec in TARGETS.items():
                row = {"solver": name, "implementation": impl, "problem": pname, "title": spec["title"],
                       "metric": spec["metric"], "target": spec["targets"][impl]}
                vals, totals = [], []
                try:
                    for k in range(runs):
                        res = solve_once(cmd, paths[pname], Path(d) / f"{name}-{pname}-{k}.json", timeout)
                        v = metric_value(res, spec["metric"])
                        if v is None:
                            raise RuntimeError(f"result has no stats.{spec['metric']}")
                        vals.append(v)
                        totals.append(metric_value(res, "runtime_ms"))
                        st = res.get("stats") or {}
                        row["placed"], row["total"] = st.get("placed"), st.get("total")
                        row["strategy_used"] = st.get("strategy_used")
                except Exception as e:  # noqa: BLE001 - reported in the table
                    row["error"] = f"{type(e).__name__}: {e}"
                if vals:
                    row["values"] = vals
                    row["median"] = statistics.median(vals)
                    row["runtime_median"] = statistics.median([t for t in totals if t is not None] or [0.0])
                    row["passed"] = "error" not in row and row["median"] <= row["target"]
                else:
                    row["passed"] = False
                report["rows"].append(row)
                msg = row.get("error") or (f"{spec['metric']} median {row['median']:.1f} ms "
                                           f"(target {row['target']:g} ms): {'ok' if row['passed'] else 'MISSED'}")
                log(f"{'perf':>8}  {name}/{pname}: {msg}")
    return report


def passed(report: dict | None) -> bool:
    return bool(report and report.get("rows")) and all(r.get("passed") for r in report["rows"])
