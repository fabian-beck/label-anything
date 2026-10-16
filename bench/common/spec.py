"""Spec data for the benchmark tools: schemas, the defaults table, presets and
the effective-options merge of spec §2.4 (defaults ← preset ← problem).

The defaults are parsed from ``spec/defaults.md`` (the same table the engine's
code generator reads), so the evaluator never drifts from the spec.
"""
from __future__ import annotations

import copy
import functools
import json
import re
from typing import Any

from . import paths

# Keys of the defaults table that are per-element defaults, not top-level options.
_ELEMENT_PREFIXES = ("obstacles.vector.", "obstacles.svg.", "obstacles.raster.", "priority.term.")
_ELEMENT_KEYS = {"priority.coverage.min_per_group"}
# Option sections merged from presets / the problem (everything except data).
OPTION_SECTIONS = ("canvas", "y_axis", "transform", "defaults", "text", "avoid", "placement",
                   "leaders", "priority", "solver", "degrade", "degrade_options", "weights", "output")


@functools.lru_cache(maxsize=None)
def schema(name: str = "problem") -> dict:
    with open(paths.SPEC / "schema" / f"{name}.v1.json", encoding="utf-8") as f:
        return json.load(f)


@functools.lru_cache(maxsize=None)
def defaults_table() -> dict[str, Any]:
    """Flat map dotted key -> JSON default, parsed from spec/defaults.md."""
    md = (paths.SPEC / "defaults.md").read_text(encoding="utf-8")
    begin = md.index("<!-- defaults:begin -->")
    end = md.index("<!-- defaults:end -->")
    out: dict[str, Any] = {}
    for row in md[begin:end].splitlines():
        if not row.startswith("| `"):
            continue
        m = re.match(r"^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|", row)
        if not m:
            raise ValueError(f"defaults.md: cannot parse row {row!r}")
        out[m.group(1)] = json.loads(m.group(2))
    return out


def element_default(key: str) -> Any:
    """A per-element default such as ``obstacles.vector.r`` or ``priority.term.k``."""
    return defaults_table()[key]


@functools.lru_cache(maxsize=None)
def presets() -> dict[str, dict]:
    out = {}
    for p in sorted((paths.SPEC / "presets").glob("*.json")):
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        data.pop("$comment", None)
        out[p.stem] = data
    return out


def _set_path(d: dict, dotted: str, value: Any) -> None:
    parts = dotted.split(".")
    cur = d
    for k in parts[:-1]:
        cur = cur.setdefault(k, {})
    cur[parts[-1]] = copy.deepcopy(value)


@functools.lru_cache(maxsize=None)
def _nested_defaults() -> str:
    nested: dict[str, Any] = {}
    for key, val in defaults_table().items():
        if key.startswith(_ELEMENT_PREFIXES) or key in _ELEMENT_KEYS:
            continue
        _set_path(nested, key, val)
    return json.dumps(nested)


def nested_defaults() -> dict:
    return json.loads(_nested_defaults())


# Maps keyed by class merge per key (spec §2.4); other objects merge recursively.
def merge(base: Any, over: Any) -> Any:
    """Objects merge recursively; arrays and scalars replace (spec §2.4)."""
    if isinstance(base, dict) and isinstance(over, dict):
        out = dict(base)
        for k, v in over.items():
            out[k] = merge(base.get(k), v) if k in base else copy.deepcopy(v)
        return out
    return copy.deepcopy(over)


def effective_options(problem: dict) -> dict:
    """Effective options = defaults.md ← presets/<preset>.json#options ← problem."""
    opts = nested_defaults()
    preset = problem.get("preset", opts.get("preset", "auto"))
    pdata = presets().get(preset, {})
    if preset != "none":
        opts = merge(opts, pdata.get("options", {}))
    for sec in OPTION_SECTIONS:
        if sec in problem and problem[sec] is not None:
            if sec in opts and isinstance(opts[sec], dict) and isinstance(problem[sec], dict):
                opts[sec] = merge(opts[sec], problem[sec])
            else:
                opts[sec] = copy.deepcopy(problem[sec])
    opts["preset"] = preset
    return opts


def preset_svg_classes(preset: str) -> list[dict]:
    return presets().get(preset, {}).get("svg_classes", [])


# ---------------------------------------------------------------------------
# Lengths (spec §2.1)
# ---------------------------------------------------------------------------
_LEN_RE = re.compile(r"^(-?(?:[0-9]+\.?[0-9]*|\.[0-9]+))(px|pt|em)$")


def length(value: Any, em: float) -> float:
    """Resolve a length (number = px, or '<n>px|pt|em') to pixels."""
    if value is None:
        return 0.0
    if isinstance(value, bool):
        raise ValueError("boolean is not a length")
    if isinstance(value, (int, float)):
        return float(value)
    m = _LEN_RE.match(str(value).strip())
    if not m:
        raise ValueError(f"invalid length {value!r}")
    n = float(m.group(1))
    unit = m.group(2)
    if unit == "px":
        return n
    if unit == "pt":
        return n * 4.0 / 3.0
    return n * em


def avoid_value(amap: dict, cls: str) -> Any:
    """Look up ``cls`` in an avoid map with the ``"*"`` fallback; 'hard', 'ignore' or a weight."""
    if cls in amap:
        return amap[cls]
    return amap.get("*", 1.0)


def is_hard(amap: dict, cls: str) -> bool:
    return avoid_value(amap, cls) == "hard"


RESERVED_CLASSES = ("items", "labels", "leaders", "canvas_edge", "ink", "text")
