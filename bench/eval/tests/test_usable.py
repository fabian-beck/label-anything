"""Conflicts vs spacing rules among the hard violations, and the usable labels left after dropping conflicts."""
from __future__ import annotations

import math

import pytest

from bench.eval import evaluate
from bench.eval.tests.helpers import item, omitted, placed, problem, result

G = [1.0 / math.log2(r + 2) for r in range(10)]


def test_overlapping_labels_keep_the_more_important_one():
    prob = problem([item("A", 50, 50), item("B", 120, 50), item("C", 180, 90)])
    # A and B overlap by 5 x 6 px; C is clean
    res = result([placed("A", 60, 30), placed("B", 85, 34), placed("C", 150, 60, side="top-left")])
    m = evaluate(prob, res, removal_test=False)
    assert m["hard"]["label_label"] == 1
    assert m["hard"]["conflicts"] == 1 and m["hard"]["spacing"] == 0
    # B (rank 1) is dropped, A (rank 0) and C stay
    assert m["usable"]["count"] == 2
    assert m["usable"]["in_conflict"] == 2
    assert m["usable"]["weighted"] == pytest.approx((G[0] + G[2]) / (G[0] + G[1] + G[2]))
    assert m["summary"]["usable"] == 2 and m["summary"]["hard_conflicts"] == 1
    # the usable prefix stops at B (rank 1), the placed prefix does not
    assert m["usable"]["prefix"] == 1 and m["summary"]["usable_prefix"] == 1
    assert m["priority"]["prefix_length"] == 3


def test_a_label_over_another_mark_is_dropped_whatever_its_rank():
    prob = problem([item("A", 50, 50), item("B", 100, 50, r=5), item("C", 30, 20)])
    res = result([placed("A", 20, 60, side="bottom-left"), placed("B", 120, 60, side="bottom-right"),
                  placed("C", 85, 47, side="left")])  # C covers B's mark
    m = evaluate(prob, res, removal_test=False)
    assert m["hard"]["label_item"] == 1
    assert m["usable"]["count"] == 2
    assert m["usable"]["weighted"] == pytest.approx((G[0] + G[1]) / (G[0] + G[1] + G[2]))


def _leadered(other_y: float) -> dict:
    """A labeled at a distance by a horizontal leader along y = 50; B's mark (r = 2) at (75, other_y)."""
    prob = problem([item("A", 50, 50), item("B", 75, other_y)])
    lead = {"points": [[52, 50], [100, 50]], "style": "straight"}
    return evaluate(prob, result([placed("A", 100, 45, side="distant", model="distant", leader=lead),
                                  omitted("B")]), removal_test=False)


def test_a_leader_near_a_mark_breaks_a_spacing_rule_only():
    # B's mark is 5 - 2 = 3 px from the leader: closer than the clearance (0.4 em), not touching
    m = _leadered(55)
    assert m["hard"]["leader_item"] == 1
    assert m["hard"]["spacing"] == 1 and m["hard"]["conflicts"] == 0
    assert m["usable"]["count"] == 1


def test_a_leader_through_a_mark_is_a_conflict():
    m = _leadered(51)
    assert m["hard"]["leader_item"] == 1
    assert m["hard"]["conflicts"] == 1 and m["hard"]["spacing"] == 0
    assert m["usable"]["count"] == 0 and m["usable"]["weighted"] == 0.0


def test_without_violations_every_placed_label_is_usable():
    prob = problem([item("A", 50, 50), item("B", 150, 50)])
    m = evaluate(prob, result([placed("A", 60, 20), placed("B", 160, 20)]), removal_test=False)
    assert m["hard"]["total"] == 0
    assert m["usable"]["count"] == m["placement"]["placed"] == 2
    assert m["usable"]["weighted"] == pytest.approx(m["placement"]["placed_weighted"])


def test_region_coverage_counts_populated_cells_with_a_label():
    # cells of 8 em = 96 px (default font 12 px): A and B share the cell (0, 0), C is alone in (1, 0)
    prob = problem([item("A", 20, 20), item("B", 50, 60), item("C", 150, 20)])
    m = evaluate(prob, result([placed("A", 25, 5), omitted("B"), omitted("C")]), removal_test=False)
    assert m["spread"]["regions"] == 2 and m["spread"]["labeled"] == 1
    assert m["summary"]["region_coverage"] == pytest.approx(0.5)


def _leader_to(small_at, extra):
    """Item A (r = 3) at ``small_at`` labeled by a leader from its outline to the right; ``extra`` other items."""
    x, y = small_at
    prob = problem([item("A", x, y, r=3)] + extra, width=300, height=200)
    lead = {"points": [[x + 4, y], [x + 60, y]], "style": "straight"}
    return evaluate(prob, result([placed("A", x + 60, y - 5, side="distant", model="distant", leader=lead)]
                                 + [omitted(it["id"]) for it in extra]), removal_test=False)


def test_a_leader_to_a_mark_on_a_larger_one_is_not_ambiguous():
    # A lies on B (r = 30): the leader starts inside B, 1 px from A's outline and 25 px from B's
    m = _leader_to((100, 100), [item("B", 95, 100, r=30)])
    assert m["ambiguity"]["count"] == 0


def test_a_leader_starting_at_another_outline_is_ambiguous():
    # C's outline is 0.5 px from the leader's start, A's 1 px
    m = _leader_to((100, 100), [item("C", 104, 103, r=2.5)])
    assert m["ambiguity"]["count"] == 1
