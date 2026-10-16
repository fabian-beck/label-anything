"""Release gates of the benchmark (brief §8.4).

A run passes when, for the Label Anything solvers (names ``rust``, ``wasm``,
``ts``, optionally with a suffix):

1. every problem and sequence was solved (no errors) with **0 hard violations**,
2. **no metric regressed by more than 2 %** against ``--previous`` (relative; any
   change away from 0 counts; direction per metric as in ``bench/report.py``;
   runtimes excluded — the performance targets cover them), except for entries
   of the allow-list ``bench/gates-allow.json``, each backed by an ADR,
3. the **performance targets** (``bench/perf``) were measured and met for every
   implementation in the run.

Without ``--previous`` the regression gate is reported as skipped (not failed).

    python -m bench.gates bench-report/results.json [--previous old/results.json]
                          [--allow bench/gates-allow.json] [--threshold 0.02]

``bench/run.py --gate`` evaluates the same gates at the end of a run. Exit code 0
when every gate passes, 1 otherwise.

Allow-list format::

    {"allow": [{"metric": "placed_rate", "scenario": "05-airports", "config": "*", "solver": "rust",
                "adr": "0018", "reason": "denser leaders accepted"}]}

``scenario``, ``config`` and ``solver`` are fnmatch patterns (default ``*``);
``adr`` must name an existing ``docs/adr/<adr>-*.md``, otherwise the entry is
ignored (and reported).
"""
from __future__ import annotations

import argparse
import fnmatch
import sys
from pathlib import Path

from .common import paths
from .common.jsonio import read_json, write_json
from .perf import implementation
from .report import compare

ALLOW_FILE = paths.BENCH / "gates-allow.json"
ADR_DIR = paths.REPO / "docs" / "adr"


def load_allow(path: str | Path | None = None) -> tuple[list[dict], list[str]]:
    """Valid allow-list entries and problems with the others."""
    p = Path(path) if path else ALLOW_FILE
    if not p.exists():
        return [], []
    data = read_json(p)
    ok, bad = [], []
    for e in data.get("allow", []):
        adr = str(e.get("adr", "")).strip()
        num = adr.upper().removeprefix("ADR-").removeprefix("ADR").strip("- ")
        if not e.get("metric") or not e.get("scenario"):
            bad.append(f"allow-list entry without metric/scenario: {e}")
        elif not num or not list(ADR_DIR.glob(f"{num.zfill(4)}-*.md")):
            bad.append(f"allow-list entry for {e.get('metric')} / {e.get('scenario')} names no existing ADR "
                       f"({adr or 'missing'}); ignored")
        else:
            ok.append({**e, "adr": num.zfill(4)})
    return ok, bad


def allowed_by(row: dict, allow: list[dict]) -> dict | None:
    for e in allow:
        if (e["metric"] == row["metric"] and fnmatch.fnmatchcase(row["scenario"], e["scenario"])
                and fnmatch.fnmatchcase(row["config"], e.get("config", "*"))
                and fnmatch.fnmatchcase(row["solver"], e.get("solver", "*"))):
            return e
    return None


def check(report: dict, previous: dict | None = None, allow: list[dict] | None = None,
          allow_problems: list[str] | None = None, threshold: float = 0.02) -> dict:
    allow = allow or []
    la = [s for s in report.get("solvers", []) if implementation(s)]
    checks = []

    # 1. hard violations (and failures) of the Label Anything solvers
    det, ok = [], bool(la)
    if not la:
        det.append("no Label Anything solver (rust, wasm, ts) in this run")
    for r in report.get("results", []):
        if r["solver"] not in la:
            continue
        where = f"{r['solver']} {r['scenario']}/{r['config']}"
        if "error" in r or "skipped" in r:
            ok = False
            det.append(f"{where}: {r.get('error') or r.get('skipped')}")
        elif (r["summary"].get("hard_violations") or 0) > 0 or (r["summary"].get("schema_errors") or 0) > 0:
            ok = False
            det.append(f"{where}: {r['summary']['hard_violations']} hard violations, "
                       f"{r['summary'].get('schema_errors', 0)} schema errors")
    for s in report.get("sequences", []):
        if s["solver"] in la and ("error" in s or "skipped" in s):
            ok = False
            det.append(f"{s['solver']} {s['scenario']}/{s['sequence']}: {s.get('error') or s.get('skipped')}")
    n = sum(1 for r in report.get("results", []) if r["solver"] in la)
    checks.append({"name": "0 hard violations (Label Anything solvers)", "passed": ok,
                   "details": det or [f"{n} results checked"]})

    # 2. regressions against the previous run
    if previous is None:
        checks.append({"name": f"no metric regression > {threshold:.0%} vs previous", "passed": True, "skipped": True,
                       "details": ["no --previous results given: regressions not checked"]})
    else:
        diff = compare(previous, report, threshold)
        regs = [r for r in diff["rows"] if r["status"] == "regression" and r["solver"] in la]
        det, failing = [], 0
        for r in regs:
            e = allowed_by(r, allow)
            rel = "from 0" if r["relative"] is None else f"{r['relative']:.1%}"
            line = (f"{r['solver']} {r['scenario']}/{r['config']} {r['metric']}: "
                    f"{r['old']:.6g} -> {r['new']:.6g} ({rel})")
            if e:
                det.append(f"allowed by ADR {e['adr']}: {line}")
            else:
                failing += 1
                det.append(line)
        det += list(allow_problems or [])
        missing = [m for m in diff["missing"] if implementation(m.split("/", 1)[0])]
        if missing:
            det.append("not in this run (not compared): " + ", ".join(missing[:20]))
        checks.append({"name": f"no metric regression > {threshold:.0%} vs previous", "passed": failing == 0,
                       "details": det or ["no regressions"]})

    # 3. performance targets
    perf = report.get("perf") or {}
    rows = perf.get("rows") or []
    det, ok = [], True
    impls_run = {implementation(s) for s in la}
    impls_measured = {r["implementation"] for r in rows}
    for imp in sorted(i for i in impls_run if i):
        if imp not in impls_measured:
            ok = False
            det.append(f"{imp}: performance targets not measured (run with --perf)")
    for r in rows:
        if r.get("passed"):
            det.append(f"{r['solver']} {r['problem']}: {r['median']:.1f} ms ≤ {r['target']:g} ms")
        else:
            ok = False
            det.append(f"{r['solver']} {r['problem']}: " + (r.get("error") or
                       f"{r['median']:.1f} ms > target {r['target']:g} ms ({r['metric']})"))
    if not impls_run:
        ok = False
        det.append("no Label Anything implementation to measure")
    checks.append({"name": "performance targets met", "passed": ok, "details": det})
    return {"passed": all(c["passed"] for c in checks), "threshold": threshold, "checks": checks}


def summary_lines(gate: dict) -> list[str]:
    out = ["release gates: " + ("PASS" if gate["passed"] else "FAIL")]
    for c in gate["checks"]:
        mark = "SKIP" if c.get("skipped") else ("pass" if c["passed"] else "FAIL")
        out.append(f"  [{mark}] {c['name']}")
        for d in c.get("details", [])[:25]:
            out.append(f"         {d}")
        if len(c.get("details", [])) > 25:
            out.append(f"         … {len(c['details']) - 25} more")
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m bench.gates", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("results", help="results.json of the run to check")
    ap.add_argument("--previous", help="results.json of the previous release")
    ap.add_argument("--allow", help=f"allow-list (default {ALLOW_FILE.relative_to(paths.REPO)})")
    ap.add_argument("--threshold", type=float, default=0.02)
    ap.add_argument("-o", "--out", help="write the gate result as JSON")
    a = ap.parse_args(argv)
    report = read_json(a.results)
    allow, problems = load_allow(a.allow)
    gate = check(report, read_json(a.previous) if a.previous else None, allow, problems, a.threshold)
    print("\n".join(summary_lines(gate)))
    if a.out:
        write_json(a.out, gate, nd=6, indent=1)
    return 0 if gate["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
