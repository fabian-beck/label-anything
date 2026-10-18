"""Running the Node baselines (d3fc, ECharts, D3-Labeler): toolchain checks and one script call per solve."""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
NODE_MODULES = HERE / "node_modules"
TIMEOUT = 900.0


def pkg_version(name: str) -> str | None:
    try:
        return json.loads((NODE_MODULES / name / "package.json").read_text(encoding="utf-8"))["version"]
    except (OSError, ValueError, KeyError):
        return None


def available(packages: tuple[str, ...] = ()) -> str | None:
    """None when Node ≥ 20 and ``packages`` (in bench/baselines/node_modules) are present, else the reason."""
    node = shutil.which("node")
    if node is None:
        return "node is not on PATH (Node ≥ 20 is required)"
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=30).stdout.strip()
        major = int(out.lstrip("v").split(".")[0])
    except (OSError, ValueError, subprocess.SubprocessError):
        return "cannot run node --version"
    if major < 20:
        return f"node {out} is older than 20"
    for pkg in packages:
        if pkg_version(pkg) is None:
            return f"{pkg} is not installed (npm ci --prefix bench/baselines)"
    return None


def run(script: str, scene: dict, prefix: str) -> dict:
    """Run ``node bench/baselines/<script> scene.json out.json`` and return the parsed output."""
    with tempfile.TemporaryDirectory(prefix=prefix) as d:
        sp, op = Path(d) / "scene.json", Path(d) / "out.json"
        sp.write_text(json.dumps(scene), encoding="utf-8")
        r = subprocess.run([shutil.which("node") or "node", str(HERE / script), str(sp), str(op)],
                           capture_output=True, text=True, timeout=TIMEOUT)
        if r.returncode != 0:
            raise RuntimeError(f"{script} failed ({r.returncode}): {r.stderr.strip()[-800:]}")
        return json.loads(op.read_text(encoding="utf-8"))
