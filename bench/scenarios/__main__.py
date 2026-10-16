"""python -m bench.scenarios {list,fetch,build,all} [NN ...]"""
from __future__ import annotations

import subprocess
import sys
import time

from ..common import paths
from . import find, scenario_dirs


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] not in ("list", "fetch", "build", "all"):
        print(__doc__)
        return 2
    cmd, sel = argv[0], argv[1:]
    dirs = [find(s) for s in sel] if sel else scenario_dirs()
    if cmd == "list":
        for d in dirs:
            print(d.name)
        return 0
    steps = ["fetch", "build"] if cmd == "all" else [cmd]
    failed = []
    for step in steps:
        for d in dirs:
            script = d / f"{step}.py"
            if not script.exists():
                continue
            print(f"== {step} {d.name}")
            t0 = time.time()
            r = subprocess.run([sys.executable, str(script)], cwd=str(paths.REPO))
            print(f"   ({time.time() - t0:.1f} s)")
            if r.returncode != 0:
                failed.append(f"{step} {d.name}")
    if failed:
        print("FAILED: " + ", ".join(failed), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
