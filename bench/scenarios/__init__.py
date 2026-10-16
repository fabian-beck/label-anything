"""Benchmark scenarios. Each ``NN-name/`` directory has ``fetch.py`` (download and
verify the data), ``build.py`` (write problems, truths and backgrounds to
``bench/out/problems/NN-name/``), ``LICENSE.md`` and ``README.md``.

    python -m bench.scenarios list
    python -m bench.scenarios fetch [NN ...]     # all when no ids are given
    python -m bench.scenarios build [NN ...]
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from ..common import paths


def scenario_dirs() -> list[Path]:
    return sorted(p for p in paths.SCENARIOS.iterdir() if p.is_dir() and p.name[:2].isdigit())


def find(sel: str) -> Path:
    for d in scenario_dirs():
        if d.name == sel or d.name.startswith(sel + "-") or d.name[:2] == sel.zfill(2):
            return d
    raise SystemExit(f"unknown scenario {sel!r}")


def load_module(scenario: str, module: str):
    """Import ``bench/scenarios/<scenario>/<module>.py`` (directory names are not identifiers)."""
    d = find(scenario)
    path = d / f"{module}.py"
    name = f"bench_scenario_{d.name.replace('-', '_')}_{module}"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod
