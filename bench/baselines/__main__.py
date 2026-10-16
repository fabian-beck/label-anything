"""Run one baseline adapter on one problem.

    python -m bench.baselines NAME problem.json -o result.json
    python -m bench.baselines --list

Exit codes: 0 solved, 2 toolchain missing, 3 the tool cannot run this problem ("n/a").
"""
from __future__ import annotations

import argparse
import sys

from ..common.jsonio import read_json, write_json
from . import BASELINES, Unsupported


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m bench.baselines", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name", nargs="?", choices=sorted(BASELINES))
    ap.add_argument("problem", nargs="?")
    ap.add_argument("-o", "--out")
    ap.add_argument("--list", action="store_true", help="list the baselines and whether their toolchain is present")
    a = ap.parse_args(argv)
    if a.list or not a.name:
        for name, b in BASELINES.items():
            why = b.check()
            print(f"{name:<11} {'ok ' + str(b.version()) if why is None else 'missing: ' + why}")
        return 0
    if not a.problem or not a.out:
        ap.error("give NAME problem.json -o result.json")
    b = BASELINES[a.name]
    why = b.check()
    if why is not None:
        print(f"{a.name}: toolchain missing: {why}", file=sys.stderr)
        return 2
    try:
        res = b.solve(read_json(a.problem), a.problem)
    except Unsupported as e:
        print(f"{a.name}: n/a: {e}", file=sys.stderr)
        return 3
    write_json(a.out, res, nd=3)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
