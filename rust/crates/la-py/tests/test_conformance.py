"""The shared conformance suite through the Python binding."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest
from conftest import CONFORMANCE, SPEC, load_json

import label_anything as la

PROBLEMS = sorted((CONFORMANCE / "problems").glob("*.json"))
VALIDATE_CASES = sorted((CONFORMANCE / "validate").glob("*.json"))


def test_suite_present() -> None:
    assert len(PROBLEMS) >= 24, f"conformance problems not found under {CONFORMANCE}"


@pytest.mark.parametrize("path", PROBLEMS, ids=lambda p: p.stem)
def test_problem_places_without_violations(path: Path) -> None:
    problem = load_json(path)
    first = la.place_problem(problem)
    st = first.stats
    assert st["hard_violations"] == 0
    assert st["leader_crossings"] == 0
    assert st["priority_inversions"] == 0
    assert st["total"] == len(problem["items"])
    assert len(first.placements) == len(problem["items"])
    # deterministic, and the same through JSON text and a file path
    again = la.place_problem(json.dumps(problem))
    from_file = la.place_problem(path)
    assert first.raw["placements"] == again.raw["placements"]
    assert first.raw["placements"] == from_file.raw["placements"]
    # placed boxes lie inside the canvas
    canvas = problem.get("canvas")
    if canvas and not canvas.get("allow_outside"):
        for p in first.placed:
            assert p.box is not None
            assert p.box.x >= -1e-6 and p.box.y >= -1e-6
            assert p.box.x1 <= canvas["width"] + 1e-6 and p.box.y1 <= canvas["height"] + 1e-6


def _result_validator() -> Any:
    jsonschema = pytest.importorskip("jsonschema")
    schema = load_json(SPEC / "schema" / "result.v1.json")
    return jsonschema.Draft202012Validator(schema)


@pytest.mark.parametrize("path", PROBLEMS[:8], ids=lambda p: p.stem)
def test_result_matches_result_schema(path: Path) -> None:
    validator = _result_validator()
    raw = la.place_problem(path).raw
    errors = sorted(validator.iter_errors(raw), key=lambda e: list(e.path))
    assert not errors, errors[0].message


def _problems_of(case: Dict[str, Any], base: Path) -> List[Any]:
    if "problem" in case:
        return [case["problem"]]
    if "problem_file" in case:
        return [load_json(base / case["problem_file"])]
    return [load_json(base / f) for f in case.get("problem_files", [])]


@pytest.mark.parametrize("path", VALIDATE_CASES, ids=lambda p: p.stem)
def test_validate_cases(path: Path) -> None:
    case = load_json(path)
    expect = case["expect"]
    for problem in _problems_of(case, path.parent):
        report = la.validate(problem)
        assert report.valid == expect["valid"], report.errors
        got = {(e["pointer"], e["code"]) for e in report.errors}
        want = {(e["pointer"], e["code"]) for e in expect.get("errors", [])}
        assert want <= got, f"missing {want - got}, got {got}"
        if expect.get("exact"):
            assert got == want
        got_w = {(w["pointer"], w["code"]) for w in report.warnings}
        want_w = {(w["pointer"], w["code"]) for w in expect.get("warnings", [])}
        assert want_w <= got_w
        if not expect["valid"]:
            with pytest.raises(la.ValidationError) as info:
                la.place_problem(problem)
            assert want <= {(e["pointer"], e["code"]) for e in info.value.errors}
