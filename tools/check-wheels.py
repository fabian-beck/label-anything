#!/usr/bin/env python3
"""What would be uploaded to PyPI, checked before it is.

    python3 tools/check-wheels.py dist/

``dist/`` holds the wheel and the source distribution of ``label-anything`` (maturin) and
of ``label-anything-extras`` (``python -m build``). Each must carry its license texts —
the engine's also the license of the embedded font metrics — and the typing marker, and
must not carry tests or bytecode.
"""

from __future__ import annotations

import sys
import tarfile
import zipfile
from pathlib import Path

NEEDED = {
    "label_anything": ["LICENSE", "NOTICE", "OFL.txt", "label_anything/py.typed", "label_anything/__init__.py"],
    "label_anything_extras": ["LICENSE", "label_anything_extras/py.typed", "label_anything_extras/__init__.py"],
}
FORBIDDEN = ("__pycache__", ".pyc", "/tests/", ".egg-info/SOURCES")


def names(path: Path) -> list[str]:
    if path.suffix == ".whl":
        with zipfile.ZipFile(path) as z:
            return z.namelist()
    with tarfile.open(path) as t:
        return t.getnames()


def main(dist: Path) -> int:
    problems: list[str] = []
    seen: set[tuple[str, str]] = set()
    for path in sorted(dist.iterdir()):
        kind = "wheel" if path.suffix == ".whl" else "sdist" if path.name.endswith(".tar.gz") else None
        if kind is None:
            continue
        package = "label_anything_extras" if path.name.startswith("label_anything_extras") else "label_anything"
        seen.add((package, kind))
        files = names(path)
        for needed in NEEDED[package]:
            # a wheel keeps licenses in <name>.dist-info/licenses/, an sdist beside pyproject.toml
            if not any(f == needed or f.endswith("/" + needed) for f in files):
                problems.append(f"{path.name}: {needed} is missing")
        if kind == "wheel":
            for f in files:
                if any(bad in f for bad in FORBIDDEN):
                    problems.append(f"{path.name}: {f} should not be in the wheel")
            if package == "label_anything" and not any("_native" in f and f.endswith((".so", ".pyd")) for f in files):
                problems.append(f"{path.name}: the extension module is missing")
        print(f"{path.name}: {len(files)} files")
    for package in NEEDED:
        for kind in ("wheel", "sdist"):
            if (package, kind) not in seen:
                problems.append(f"{dist}: no {kind} of {package}")
    for p in problems:
        print(p, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1] if len(sys.argv) > 1 else "dist")))
