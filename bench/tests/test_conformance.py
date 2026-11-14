"""The benchmark's own implementations of the specification against the repository's language-neutral
conformance cases (format: conformance/README.md): the expression language (spec/expr.peg,
bench/eval/expr.py)."""
from __future__ import annotations

import json
import struct

import pytest

from bench.common import paths
from bench.eval import expr as ex

CONFORMANCE = paths.REPO / "conformance"
MIN_CASES = {"expr": 1000}


def _expr_cases() -> list:
    out = []
    for path in sorted((CONFORMANCE / "expr").glob("*.json")):
        file = json.loads(path.read_text(encoding="utf-8"))
        assert file["kind"] == "expr", path.name
        out += [pytest.param(file.get("context") or {}, case, id=f"{path.stem}:{i}")
                for i, case in enumerate(file["cases"])]
    assert len(out) >= MIN_CASES["expr"], f"only {len(out)} expr cases"
    return out


def _identical(a, b) -> bool:
    """Exact equality: numbers bit for bit (``-0.0`` is not ``0``; JSON integers are numbers), the rest
    structurally."""
    num = (int, float)
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, num) and isinstance(b, num):
        return struct.pack(">d", a) == struct.pack(">d", b)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_identical(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_identical(a[k], b[k]) for k in a)
    return type(a) is type(b) and a == b


@pytest.mark.parametrize("defaults,case", _expr_cases())
def test_expr(defaults, case):
    if "error" in case:
        with pytest.raises(ex.ExprError) as e:
            ex.parse(case["expr"])
        assert e.value.code == case["error"] and str(e.value)
        if "offset" in case:
            assert e.value.offset == case["offset"]
        return
    ctx = {"attrs": {}, "id": "", "index": 0, "text": "", "priority": None, "tier": None, "x": 0, "y": 0}
    ctx.update(defaults)
    ctx.update(case.get("context") or {})
    value = ex.evaluate(ex.parse(case["expr"]), ctx)
    assert _identical(value, case["value"]), f"{value!r}, expected {case['value']!r}"
    if "truthy" in case:
        assert ex.truthy(value) is case["truthy"]
    if "term" in case:
        term = ex.term_number(value)
        assert (term is None and case["term"] is None) or _identical(term, case["term"])
