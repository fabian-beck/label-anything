"""Validation errors and reports."""

from __future__ import annotations

import math
import pickle

import pytest

import label_anything as la
from label_anything import _native

BAD = {
    "items": [
        {"id": "a", "anchor": {"type": "point", "x": 1}, "label": {"type": "text", "text": "A"}},
        {"id": "a", "anchor": {"type": "point", "x": 5, "y": 5}, "label": {"type": "text", "text": "B", "padding": "3qq"}},
    ],
    "frobnicate": 1,
}


def codes(errors: list) -> set:
    return {(e["pointer"], e["code"]) for e in errors}


def test_invalid_problem_raises_validation_error() -> None:
    with pytest.raises(la.ValidationError) as info:
        la.place_problem(BAD)
    err = info.value
    assert isinstance(err, ValueError)
    assert isinstance(err, la.LabelAnythingError)
    got = codes(err.errors)
    assert ("/items/0/anchor/y", "required") in got
    assert ("/items/1/id", "duplicate_id") in got
    assert ("/frobnicate", "unknown_property") in got
    for e in err.errors:
        assert set(e) == {"pointer", "code", "message"}
        assert isinstance(e["message"], str) and e["message"]
    text = str(err)
    assert text.startswith("invalid problem: ")
    assert "/items/0/anchor/y" in text


def test_native_raises_the_same_error() -> None:
    import json

    with pytest.raises(la.ValidationError) as info:
        _native.place_json(json.dumps(BAD))
    assert ("/items/0/anchor/y", "required") in codes(info.value.errors)


def test_validate_returns_a_report() -> None:
    report = la.validate(BAD)
    assert not report
    assert report.valid is False
    assert ("/items/0/anchor/y", "required") in codes(report.errors)
    with pytest.raises(la.ValidationError):
        report.raise_for_errors()
    ok = la.validate({"items": [{"anchor": {"type": "point", "x": 1, "y": 2}, "label": {"type": "text", "text": "A"}}]})
    assert ok and ok.errors == []
    ok.raise_for_errors()


def test_parse_errors() -> None:
    with pytest.raises(la.ValidationError) as info:
        la.place_problem("{not json")
    assert info.value.errors[0]["code"] == "parse"
    with pytest.raises(la.ValidationError) as info2:
        _native.place_json("[1, 2")
    assert info2.value.errors[0]["code"] == "parse"
    report = la.validate("{")
    assert not report.valid and report.errors[0]["code"] == "parse"
    # JSON that is not an object is no path either
    with pytest.raises(la.ValidationError, match="a problem must be a JSON object") as info3:
        la.place_problem(" [1, 2]")
    assert info3.value.errors[0]["code"] == "type"
    with pytest.raises(FileNotFoundError, match="no file 'problem.json'"):
        la.place_problem("problem.json")


def test_warnings_are_reported() -> None:
    problem = {
        "canvas": {"width": 100, "height": 100},
        "items": [{"anchor": {"type": "point", "x": 50, "y": 50}, "label": {"type": "text", "text": "A"}}],
        "avoid": {"label": {"outlierz": "hard"}},
    }
    report = la.validate(problem)
    assert report.valid
    assert ("/avoid/label/outlierz", "unknown_class") in codes(report.warnings)
    res = la.place_problem(problem)
    assert ("/avoid/label/outlierz", "unknown_class") in codes(res.warnings)


def test_non_finite_numbers() -> None:
    with pytest.raises(la.ValidationError) as info:
        la.place([(1, 2), (math.nan, 3)], ["a", "b"], canvas=(10, 10))
    assert info.value.errors[0]["pointer"] == "/items/1/anchor/x"
    assert info.value.errors[0]["code"] == "invalid_value"
    problem = {"items": [{"anchor": {"type": "point", "x": 1, "y": math.inf}, "label": {"type": "text", "text": "A"}}]}
    with pytest.raises(la.ValidationError) as info2:
        la.place_problem(problem)
    assert info2.value.errors[0]["pointer"] == "/items/0/anchor/y"
    assert not la.validate(problem).valid


def test_model_errors_are_validation_errors(tmp_path) -> None:
    # passes the schema, fails while loading the background
    problem = {
        "items": [{"anchor": {"type": "point", "x": 1, "y": 2}, "label": {"type": "text", "text": "A"}}],
        "obstacles": {"raster": {"source": str(tmp_path / "missing.png")}},
    }
    with pytest.raises(la.ValidationError) as info:
        la.place_problem(problem)
    assert info.value.errors[0]["pointer"].startswith("/obstacles/raster")


def test_unknown_keyword_option() -> None:
    with pytest.raises(TypeError, match="did you mean 'max_labels'"):
        la.Problem(max_label=3)
    with pytest.raises(TypeError):
        la.place([(1, 1)], ["a"], frobnicate=True)  # type: ignore[call-arg]


def test_validation_error_pickles() -> None:
    err = la.ValidationError("invalid problem: /x: bad (type)", [{"pointer": "/x", "code": "type", "message": "bad"}])
    back = pickle.loads(pickle.dumps(err))
    assert isinstance(back, la.ValidationError)
    assert back.errors == err.errors
    assert str(back) == str(err)


def test_length_mismatch() -> None:
    with pytest.raises(ValueError, match="2 anchors but 1 labels"):
        la.place([(1, 1), (2, 2)], ["a"])
    with pytest.raises(TypeError):
        la.place([(1, 1)], "a")
    with pytest.raises(ValueError, match="ids"):
        la.place([(1, 1)], ["a"], ids=["x", "y"])
