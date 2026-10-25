"""Label–point association: clarity margins, points covered, label spacing (``association.py``)."""
from __future__ import annotations

import pytest

from bench.eval import evaluate
from bench.eval.tests.helpers import item, placed, problem, result

EM = 12.0  # the default font size: thresholds 0.2 em = 2.4 px, 0.5 em = 6 px


def _assoc(prob, placements):
    return evaluate(prob, result(placements), removal_test=False)["association"]


def test_label_about_as_near_to_another_point_is_unclear():
    # A's label right of A: 1 px from A's mark; B's mark 2 px beyond its right edge
    prob = problem([item("A", 50, 50), item("B", 87, 50)])
    a = _assoc(prob, [placed("A", 53, 45, side="right")])
    c = a["clarity"]
    assert c["plain"] == 1
    assert (c["misattributed"], c["unclear"], c["weak"]) == (0, 1, 1)
    assert c["by_item"]["unclear"] == 1 and c["by_background"]["unclear"] == 0
    assert c["margin_p10_em"] == pytest.approx(1.0 / EM)
    assert c["examples"]["unclear"] == ["A"]
    # 4 px beyond: clear by more than the margin, but less than 0.5 em
    prob = problem([item("A", 50, 50), item("B", 89, 50)])
    c = _assoc(prob, [placed("A", 53, 45, side="right")])["clarity"]
    assert (c["misattributed"], c["unclear"], c["weak"]) == (0, 0, 1)
    # another point strictly nearer: misattributed
    prob = problem([item("A", 50, 50), item("B", 85.5, 50)])
    c = _assoc(prob, [placed("A", 53, 45, side="right")])["clarity"]
    assert (c["misattributed"], c["unclear"], c["weak"]) == (1, 1, 1)
    assert c["misattributed_rate"] == 1.0


def test_coincident_points_name_one_spot():
    prob = problem([item("A", 50, 50), item("B", 50.2, 50)])
    c = _assoc(prob, [placed("A", 53, 45, side="right")])["clarity"]
    assert (c["misattributed"], c["unclear"], c["weak"]) == (0, 0, 0)
    # points 1 px apart need only that 1 px: B is nearer to the label, A's label reads as B's
    prob = problem([item("A", 50, 50), item("B", 51, 50)])
    c = _assoc(prob, [placed("A", 53, 45, side="right")])["clarity"]
    assert c["misattributed"] == 1
    # ...on the side away from B, A's label is as clear as the 1 px between them allows
    c = _assoc(prob, [placed("A", 17, 45, side="left")])["clarity"]
    assert (c["misattributed"], c["unclear"], c["weak"]) == (0, 0, 0)


def test_unlabelled_background_points_compete_and_are_covered():
    prob = problem([item("A", 50, 50), item("B", 150, 50)],
                   obstacles={"vector": [
                       # one dot 2 px right of A's label, one under it, one drawn at B's own point
                       {"class": "dots", "points": [[87, 50], [70, 50], [150, 50]], "r": 2},
                   ]},
                   avoid={"label": {"dots": 0.5}})
    a = _assoc(prob, [placed("A", 53, 45, side="right")])
    c, pts = a["clarity"], a["points"]
    # the dot under the label is hidden, not a competitor; the one beside it makes it unclear
    assert (c["misattributed"], c["unclear"]) == (0, 1) and c["by_background"]["unclear"] == 1
    assert pts["total"] == 4                           # A, B and two dots: B's dot is B's mark
    assert (pts["covered"], pts["hidden"], pts["background_covered"], pts["items_covered"]) == (1, 1, 1, 0)
    assert pts["labels_covering"] == 1 and pts["labels_covering_rate"] == 1.0
    # a dot partly under the label's edge is covered, not hidden, and nearer than A
    prob["obstacles"]["vector"][0]["points"] = [[83, 50]]
    a = _assoc(prob, [placed("A", 53, 45, side="right")])
    assert a["clarity"]["by_background"]["misattributed"] == 1
    assert (a["points"]["covered"], a["points"]["hidden"]) == (1, 0)
    # ignored classes are not data points
    prob["avoid"] = {"label": {"dots": "ignore"}}
    a = _assoc(prob, [placed("A", 53, 45, side="right")])
    assert a["points"]["total"] == 2 and a["points"]["covered"] == 0
    assert a["clarity"]["misattributed"] == 0 and a["clarity"]["unclear"] == 0


def test_covered_item_marks_count_whatever_the_avoidance():
    prob = problem([item("A", 50, 50), item("B", 70, 50)], avoid={"label": {"items": 0.2}})
    m = evaluate(prob, result([placed("A", 53, 45, side="right")]), removal_test=False)
    assert m["hard"]["label_item"] == 0                # soft: not a violation
    pts = m["association"]["points"]
    assert (pts["covered"], pts["items_covered"], pts["hidden"]) == (1, 1, 1)
    assert m["summary"]["points_covered_rate"] == pytest.approx(0.5)


def test_label_spacing():
    # two labels 1.2 px (0.1 em) apart, a third 6 px (0.5 em) from the second
    prob = problem([item("A", 20, 80), item("B", 60, 80), item("C", 100, 80)], width=300)
    a = _assoc(prob, [placed("A", 10, 10), placed("B", 41.2, 10), placed("C", 77.2, 10)])
    sp = a["spacing"]
    assert (sp["pairs_tight"], sp["pairs_close"]) == (1, 1)
    assert sp["labels_close"] == 2
    assert sp["labels_close_rate"] == pytest.approx(2 / 3)
    assert sp["nearest_p10_em"] == pytest.approx(0.1)
    # labels stacked exactly the engine's spacing apart (0.4 em, up to rounding) are not close
    a = _assoc(prob, [placed("A", 10, 10), placed("B", 10, 24.8 - 1e-12), placed("C", 10, 39.6 + 0.7)])
    assert a["spacing"]["labels_close"] == 0
    a = _assoc(prob, [placed("A", 10, 10), placed("B", 10, 24.7), placed("C", 10, 40)])
    assert (a["spacing"]["labels_close"], a["spacing"]["pairs_close"], a["spacing"]["pairs_tight"]) == (2, 1, 0)


def _marks(prob, placements):
    return evaluate(prob, result(placements), removal_test=False, marks=True)["marks"]


def test_marks_name_the_point_a_label_may_be_taken_for_the_points_covered_and_the_gaps():
    # A's label 1 px from A's mark, B's mark 2 px beyond its right edge: unclear, taken for B
    mk = _marks(problem([item("A", 50, 50), item("B", 87, 50)]), [placed("A", 53, 45, side="right")])
    assert mk["ambiguous"] == [{"label": "A", "level": "unclear", "point": [87, 50]}]
    # B strictly nearer: misattributed
    mk = _marks(problem([item("A", 50, 50), item("B", 85.5, 50)]), [placed("A", 53, 45, side="right")])
    assert mk["ambiguous"] == [{"label": "A", "level": "misattributed", "point": [85.5, 50]}]
    # a background dot under the label is covered (and hidden), the one beside it makes it unclear
    prob = problem([item("A", 50, 50), item("B", 150, 50)],
                   obstacles={"vector": [{"class": "dots", "points": [[87, 50], [70, 50]], "r": 2}]},
                   avoid={"label": {"dots": 0.5}})
    mk = _marks(prob, [placed("A", 53, 45, side="right")])
    assert mk["covered"] == [{"point": [70, 50], "r": 2, "hidden": True}]
    assert mk["ambiguous"] == [{"label": "A", "level": "unclear", "point": [87, 50]}]
    # two labels 1.2 px apart: the gap between them
    prob = problem([item("A", 20, 80), item("B", 60, 80)], width=300)
    assert _marks(prob, [placed("A", 10, 10), placed("B", 41.2, 10)])["close"] == [[40, 15, 41.2, 15]]


def test_leadered_labels_are_measured_by_what_they_sit_next_to():
    prob = problem([item("A", 20, 80), item("B", 150, 20)])
    # the label far from A, 1 px from B's mark: the leader says A, the position says B
    a = _assoc(prob, [placed("A", 117, 15, side=None, model="distant", leader={"points": [[22, 78], [117, 25]]})])
    c = a["clarity"]
    assert c["plain"] == 0 and c["leadered"] == 1
    assert c["unclear"] == 0 and c["leadered_unclear"] == 1
    assert c["examples"]["leadered_unclear"] == ["A"]
    # 3 px away (more than 0.2 em): clear
    c = _assoc(prob, [placed("A", 115, 15, side=None, model="distant", leader={"points": [[22, 78], [115, 25]]})])["clarity"]
    assert c["leadered_unclear"] == 0


def test_stub_counts():
    prob = problem([item("A", 50, 50), item("B", 150, 50)])
    m = evaluate(prob, result([placed("A", 56, 45, side="right", leader={"points": [[52, 50], [56, 50]], "stub": True}),
                               placed("B", 153, 45, side="right")]), removal_test=False)
    assert m["leaders"]["stubs"] == 1 and m["leaders"]["stub_rate"] == 0.5
    assert m["summary"]["stub_rate"] == 0.5
