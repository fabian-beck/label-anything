"""Validate every generated problem against spec/schema/problem.v1.json (JSON Schema
Draft 2020-12, ``jsonschema`` package) and check the size budgets:
each problem ≤ 5 MB, quick suite ≤ 20 MB in total.

    python bench/validate_problems.py [--root bench/out/problems] [--quiet]

Exit status 1 if any problem is invalid or a budget is exceeded.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import jsonschema  # noqa: E402

from bench.common import paths, spec  # noqa: E402

MAX_PROBLEM = 5_000_000
MAX_QUICK = 20_000_000


def is_problem_file(p: Path) -> bool:
    n = p.name
    return n.endswith(".json") and not n.endswith(".truth.json") and n not in ("scenario.json", "sequence.json")


def problem_files(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*.json") if is_problem_file(p))


def quick_files(root: Path) -> list[Path]:
    out = []
    for man in sorted(root.glob("*/scenario.json")):
        m = json.loads(man.read_text(encoding="utf-8"))
        for c in m.get("configs", []):
            if c.get("quick"):
                out.append(man.parent / c["files"]["problem"])
        for s in m.get("sequences", []):
            if s.get("quick"):
                seq = man.parent / s["manifest"]
                sm = json.loads(seq.read_text(encoding="utf-8"))
                out += [seq.parent / f["file"] for f in sm["frames"]]
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=str(paths.PROBLEMS))
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    root = Path(a.root)
    validator = jsonschema.Draft202012Validator(spec.schema("problem"))
    files = problem_files(root)
    if not files:
        print(f"no problems under {root}; run `python -m bench.scenarios build` first", file=sys.stderr)
        return 1
    bad = 0
    big = 0
    for p in files:
        data = json.loads(p.read_text(encoding="utf-8"))
        errs = sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path))
        size = p.stat().st_size
        if errs:
            bad += 1
            print(f"INVALID {p.relative_to(root)}")
            for e in errs[:5]:
                print(f"   /{'/'.join(map(str, e.absolute_path))}: {e.message[:300]}")
        elif not a.quiet:
            print(f"ok      {p.relative_to(root)}  ({len(data['items'])} items, {size / 1e6:.2f} MB)")
        if size > MAX_PROBLEM:
            big += 1
            print(f"TOO BIG {p.relative_to(root)}: {size / 1e6:.2f} MB > 5 MB")
    q = quick_files(root)
    qsize = sum(f.stat().st_size for f in q)
    print(f"{len(files)} problems, {bad} invalid, {big} over 5 MB; quick suite: {len(q)} problems, "
          f"{qsize / 1e6:.2f} MB (budget 20 MB)")
    if qsize > MAX_QUICK:
        print("quick suite exceeds 20 MB")
        return 1
    return 1 if bad or big else 0


if __name__ == "__main__":
    raise SystemExit(main())
