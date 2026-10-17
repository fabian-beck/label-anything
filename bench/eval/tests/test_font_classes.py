"""``priority.font_classes`` in the evaluator's model (spec §9.4)."""
from __future__ import annotations

import json

import pytest

from bench.common import paths
from bench.common.model import class_ends, load_problem
from bench.eval import evaluate
from bench.eval.tests.helpers import item, placed, problem, result

CLASSES = [{"first": 1, "scale": 2, "weight": "bold"}, {"first": "50%", "scale": 1.5}]


def text(size):
    return {"lines": ["x"], "used": "original", "baseline_offsets": [size], "font_size": size}


def test_class_ends_are_cumulative():
    cl = [{"first": 1}, {"first": "50%"}, {}]
    assert class_ends(cl, 4) == [1, 2, 4]
    assert class_ends(cl, 0) == [0, 0, 0]
    assert class_ends([{"first": 5}, {"first": 2}, {"first": "10%"}], 40) == [5, 5, 5]
    assert class_ends([{"first": "5%"}], 46) == [3]      # ceil(2.3)
    assert class_ends([{"first": "25%"}], 40) == [10]    # an exact share takes no extra item


def test_host_measured_labels_scale_with_their_class():
    items = [item(k, 30 + 40 * i, 50, attrs={"pop": 4 - i}) for i, k in enumerate("abcd")]
    prob = problem(items, priority={"terms": [{"attr": "pop"}], "font_classes": CLASSES},
                   placement={"offset": "0.5em"})
    by = {it.id: it for it in load_problem(prob).items}
    assert [by[k].font_class for k in "abcd"] == [0, 1, None, None]
    assert (by["a"].label.w, by["a"].label.h, by["a"].label.font_weight) == (60, 20, 700)
    assert (by["b"].label.w, by["b"].label.h, by["b"].label.font_weight) == (45, 15, 400)
    assert (by["c"].label.w, by["c"].label.h) == (30, 10)
    assert [by[k].offset for k in "abc"] == [12, 9, 6]   # 0.5 em of 24, 18 and 12 px


def test_measured_sizes_match_the_conformance_case():
    case = json.loads((paths.REPO / "conformance/place/font-classes.json").read_text())
    by = {it.id: it for it in load_problem(case["problem"]).items}
    for iid, box in case["expect"]["box"].items():
        assert by[iid].label.w == pytest.approx(box["w"], abs=0.01)
        assert by[iid].label.h == pytest.approx(box["h"], abs=0.01)
    for iid, f in case["expect"]["font"].items():
        assert by[iid].font_class == f["class"]
        assert by[iid].label.font_size == pytest.approx(f["size"])


def test_the_result_ranks_decide_the_classes():
    # the reference priority puts b first; the result ranks a first (an engine term the
    # reference only approximates, say) and draws a at the first class's size
    items = [item(k, 40 + 80 * i, 50, attrs={"pop": i}) for i, k in enumerate("ab")]
    prob = problem(items, priority={"terms": [{"attr": "pop"}], "font_classes": CLASSES[:1]})
    pa = placed("a", 10, 10, w=60, h=20, text=text(24))
    pb = placed("b", 120, 10, text=text(12))
    ranked = [{**pa, "priority": {"tier": 0, "score": 1.0, "rank": 0}},
              {**pb, "priority": {"tier": 0, "score": 0.0, "rank": 1}}]
    assert evaluate(prob, result(ranked))["text"]["shrunk"] == 0
    # without ranks in the result, b's nominal size is the class size: drawn at 12 px it shrank
    assert evaluate(prob, result([pa, pb]))["text"]["shrunk"] == 0.5
