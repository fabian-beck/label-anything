"""Deterministic JSON output: sorted keys, compact separators, rounded floats.

Builds must be reproducible: the same input data gives byte-identical problem
files. Floats are rounded to a fixed number of decimals (default 3), -0.0 is
normalized to 0.0 and integral floats stay floats only when they were floats.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any


def rounded(obj: Any, nd: int = 3) -> Any:
    """Return a copy of ``obj`` with every float rounded to ``nd`` decimals."""
    if isinstance(obj, bool) or obj is None or isinstance(obj, str):
        return obj
    if isinstance(obj, int):
        return obj
    if isinstance(obj, float):
        if not math.isfinite(obj):
            raise ValueError(f"non-finite float in output: {obj}")
        v = round(obj, nd)
        if v == 0.0:
            v = 0.0  # normalizes -0.0
        return v
    if isinstance(obj, dict):
        return {str(k): rounded(v, nd) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [rounded(v, nd) for v in obj]
    # numpy scalars and similar
    if hasattr(obj, "item"):
        return rounded(obj.item(), nd)
    raise TypeError(f"cannot serialize {type(obj).__name__}")


def dumps(obj: Any, nd: int = 3, indent: int | None = None) -> str:
    data = rounded(obj, nd)
    if indent is None:
        return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return json.dumps(data, sort_keys=True, indent=indent, ensure_ascii=False, allow_nan=False)


def write_json(path: str | Path, obj: Any, nd: int = 3, indent: int | None = None) -> Path:
    """Write ``obj`` deterministically (UTF-8, trailing newline)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = dumps(obj, nd=nd, indent=indent) + "\n"
    path.write_text(text, encoding="utf-8", newline="\n")
    return path


def read_json(path: str | Path) -> Any:
    with open(path, encoding="utf-8") as f:
        return json.load(f)
