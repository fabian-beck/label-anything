"""The benchmark's own implementations of the specification against the repository's language-neutral
conformance cases (format: conformance/README.md): line breaking and wrapping (spec §5.3,
bench/common/text.py), which size the label boxes of the baselines and of the removal test, and the
expression language (spec/expr.peg, bench/eval/expr.py)."""
from __future__ import annotations

import json
import struct

import pytest

from bench.common import paths, text
from bench.eval import expr as ex

CONFORMANCE = paths.REPO / "conformance"
MIN_CASES = {"breaks": 40, "wrap": 150, "balanced": 100, "truncate": 100, "variants": 200, "expr": 1000}


def _text_cases(key: str) -> list:
    out = []
    for path in sorted((CONFORMANCE / "text").glob("wrap-*.json")):
        file = json.loads(path.read_text(encoding="utf-8"))
        assert file["kind"] == "text" and file["font"].get("family") == "default", path.name
        out += [pytest.param(file["font"]["weight"], file["size"], case, id=f"{path.stem}:{i}")
                for i, case in enumerate(file.get(key, []))]
    assert len(out) >= MIN_CASES[key], f"only {len(out)} {key} cases"  # not an empty directory
    return out


@pytest.mark.parametrize("weight,size,case", _text_cases("breaks"))
def test_break_opportunities(weight, size, case):
    assert text.break_opportunities(case["text"]) == case["breaks"]


@pytest.mark.parametrize("weight,size,case", _text_cases("wrap"))
def test_greedy_wrap(weight, size, case):
    assert text.greedy(case["text"], case["max_width"], text.measure_fn(size, weight)) == case["lines"]


@pytest.mark.parametrize("weight,size,case", _text_cases("balanced"))
def test_balanced_wrap(weight, size, case):
    got = text.balanced(case["text"], case["lines_target"], text.measure_fn(size, weight), case["max_width"])
    assert got == case["lines"]


@pytest.mark.parametrize("weight,size,case", _text_cases("truncate"))
def test_truncate(weight, size, case):
    measure = text.measure_fn(size, weight)
    if case["mode"] == "end":
        assert text.truncate_end(case["text"], case["max_width"], measure) == case["result"]
    else:
        got = text.truncate_middle(case["text"], case["max_width"], case["max_lines"], measure)
        assert got == case["lines"]


@pytest.mark.parametrize("weight,size,case", _text_cases("variants"))
def test_wrap_variants(weight, size, case):
    o = case["options"]
    measure = text.measure_fn(size, weight)
    got = text.wrap_variants(case["text"], o["max_width"], o["max_lines"], measure, o["balance"], o["truncate"])
    assert [(lines, truncated) for lines, truncated in got] == \
        [(v["lines"], v["truncated"]) for v in case["variants"]]
    for (lines, _), want in zip(got, case["variants"]):
        assert [measure(s) for s in lines] == pytest.approx(want["widths"], abs=0.01)
    # the box of a label is that of its first variant
    wrap = {k: o[k] for k in ("max_width", "max_lines", "balance") if o[k] is not None}
    lay = text.normal_variant(case["text"], size, weight, 1.2, wrap, o["truncate"])
    assert (lay.lines, lay.truncated) == (case["variants"][0]["lines"], case["variants"][0]["truncated"])


# -- expressions ----------------------------------------------------------------------------------------

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
