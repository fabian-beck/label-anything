"""How soft classes and internal labels reach the baselines (scene.build_scene, results.build_result)."""
from __future__ import annotations

import pytest

from bench.baselines.results import build_result
from bench.baselines.scene import build_scene
from bench.common.geom import Box
from bench.eval import evaluate
from bench.eval.tests.helpers import item, problem


def _problem():
    return problem([item("A", 100, 50, r=30, placement={"internal": "allow",
                                                          "models": ["internal", "adjacent"]}),
                    item("B", 20, 20)],
                   obstacles={"vector": [{"class": "grid", "polylines": [[[0, 80], [200, 80]]], "width": 1},
                                         {"class": "axes", "polylines": [[[10, 0], [10, 100]]], "width": 1}]},
                   avoid={"label": {"grid": 0.2, "axes": "hard"}})


def test_soft_classes_are_avoided_like_hard_ones_by_default():
    sc = build_scene(_problem())
    assert sc.obstacles.classes() == ["axes", "grid"]
    assert any(n.feature == "soft-classes" and "treated as hard obstacles" in n.message for n in sc.notes)


def test_soft_classes_can_be_left_out():
    sc = build_scene(_problem(), soft="ignore")
    assert sc.obstacles.classes() == ["axes"]
    assert any(n.feature == "soft-classes" and "are ignored" in n.message and "grid" in n.message for n in sc.notes)
    with pytest.raises(ValueError):
        build_scene(_problem(), soft="sometimes")


def test_a_box_inside_its_own_shape_is_an_internal_label():
    prob = _problem()
    sc = build_scene(prob)
    inside = Box(85, 45, 115, 55)        # well inside the r = 30 circle around (100, 50)
    res = build_result(sc, {"A": inside, "B": Box(25, 5, 55, 15)}, {}, 1.0, "test")
    a = next(p for p in res["placements"] if p["id"] == "A")
    assert a["model"] == "internal" and a["anchor_side"] == "internal"
    m = evaluate(prob, res, removal_test=False)
    assert m["hard"]["own_mark"] == 0 and m["hard"]["internal_outside"] == 0
    # straddling the boundary is still a label over its own mark
    res = build_result(sc, {"A": Box(120, 45, 150, 55)}, {}, 1.0, "test")
    a = next(p for p in res["placements"] if p["id"] == "A")
    assert a["model"] == "slider"
    assert evaluate(prob, res, removal_test=False)["hard"]["own_mark"] == 1


def test_no_internal_labels_where_the_problem_forbids_them():
    prob = _problem()
    prob["items"][0]["placement"] = {"internal": "never"}
    sc = build_scene(prob)
    res = build_result(sc, {"A": Box(85, 45, 115, 55)}, {}, 1.0, "test")
    assert next(p for p in res["placements"] if p["id"] == "A")["model"] == "slider"
