"""Hand-computed metric values for small problem/result pairs."""
from __future__ import annotations

import base64
import math

import pytest

from bench.eval import evaluate
from bench.eval.tests.helpers import item, omitted, placed, problem, result, top_right_box

G = [1.0 / math.log2(r + 2) for r in range(10)]


def test_basic_counts_overlap_and_removal_test():
    prob = problem([item("A", 50, 50), item("B", 120, 50), item("C", 180, 90)])
    ax, ay = top_right_box(50, 50)
    res = result([placed("A", ax, ay), placed("B", 75, 40, side="left"), omitted("C")])
    m = evaluate(prob, res)
    assert m["placement"]["placed"] == 2
    assert m["placement"]["placed_rate"] == pytest.approx(2 / 3)
    # ranks by input order: g(0)+g(1) over g(0)+g(1)+g(2)
    assert m["placement"]["placed_weighted"] == pytest.approx((G[0] + G[1]) / (G[0] + G[1] + G[2]))
    assert m["priority"]["rank_source"] == "reference"
    # A's box overlaps B's box by 7.12 x 7.88 px > 0.5 px tolerance: one hard violation
    assert m["hard"]["label_label"] == 1
    assert m["hard"]["total"] == 1
    # A touches its inflated mark exactly; B is 15 - 2 - 1 = 12 px away from r=2 ⊕ offset 1
    assert m["shape"]["adjacent_n"] == 2
    assert m["shape"]["adjacent_gap_mean"] == pytest.approx((0.0 + 12.0) / 2, abs=1e-6)
    assert m["shape"]["adjacent_touch_rate"] == pytest.approx(0.5)
    # C (all keys equal) has free adjacent positions: one inversion; prefix A,B; NDCG 1
    assert m["priority"]["inversions"] == 1
    assert m["priority"]["inversion_examples"] == ["C"]
    assert m["priority"]["prefix_length"] == 2
    assert m["priority"]["ndcg_at_k"] == pytest.approx(1.0)
    assert m["ambiguity"]["rate"] == 0.0
    # position preference: top-right = 4, left = 3 in the perceptual order
    assert m["position"]["rank_mean"] == pytest.approx(3.5)
    assert m["result_check"]["schema_errors"] == []


def test_tolerance_contacts_are_not_violations():
    prob = problem([item("A", 50, 50), item("B", 150, 50)])
    # boxes overlap by exactly 0.4 px horizontally: below the 0.5 px tolerance
    res = result([placed("A", 60, 20), placed("B", 89.6, 20)])
    m = evaluate(prob, res)
    assert m["hard"]["label_label"] == 0
    res = result([placed("A", 60, 20), placed("B", 89.0, 20)])  # 1.0 px overlap
    assert evaluate(prob, res)["hard"]["label_label"] == 1


def test_canvas_edge_own_mark_and_other_item():
    prob = problem([item("A", 50, 50), item("B", 100, 50, r=5), item("C", 30, 20)])
    res = result([
        placed("A", 45, 45, side="right"),          # covers its own mark (hard by default)
        placed("B", 180, 60),                       # x1 = 210 > 200 - 4: canvas edge
        placed("C", 85, 47, side="left"),           # covers B's mark (items hard)
    ])
    m = evaluate(prob, res)
    h = m["hard"]
    assert h["own_mark"] == 1
    assert h["canvas_edge"] == 1
    assert h["label_item"] == 1
    assert h["examples"]["label_item"] == [["C", "B"]]
    assert h["total"] == 3
    # C's label overlaps B's mark: the nearest item shape is B, not C -> ambiguous
    assert "C" in m["ambiguity"]["examples"]


def test_leader_crossing_and_leader_through_label():
    prob = problem([item("A", 20, 80), item("B", 80, 80), item("D", 150, 20)], height=120)
    la = {"points": [[22, 78], [100, 30]], "style": "straight", "port": [100, 30]}
    lb = {"points": [[78, 78], [20, 30]], "style": "straight", "port": [20, 30]}
    res = result([
        placed("A", 100, 25, side="distant", model="distant", leader=la),
        placed("B", -10, 25, side="distant", model="distant", leader=lb),   # also outside the canvas
        placed("D", 40, 50, side="bottom-left"),                            # both leaders pass through D
    ])
    m = evaluate(prob, res)
    assert m["leaders"]["crossings"] == 1
    assert m["hard"]["leader_leader"] == 1
    assert m["leaders"]["label_intersections"] == 2
    assert m["hard"]["leader_label"] == 2
    assert m["hard"]["canvas_edge"] == 1
    la_len = math.hypot(78, 48)
    lb_len = math.hypot(58, 48)
    assert m["leaders"]["length_mean_em"] == pytest.approx((la_len + lb_len) / 2 / 12.0)
    assert m["leaders"]["bends_mean"] == 0
    assert m["leaders"]["rate"] == pytest.approx(2 / 3)


def test_hard_vector_class_and_soft_coverage():
    prob = problem([item("A", 50, 50, w=20, h=20), item("B", 150, 50, w=20, h=20)],
                   obstacles={"vector": [
                       {"class": "axes", "polylines": [[[0, 95], [200, 95]], [[10, 0], [10, 100]]], "width": 1},
                       {"class": "points", "points": [[60, 30], [160, 30]], "r": 4},
                   ]},
                   avoid={"label": {"axes": "hard", "points": 0.3}})
    res = result([placed("A", 50, 20, w=20, h=20), placed("B", 150, 20, w=20, h=20)])
    m = evaluate(prob, res)
    assert m["hard"].get("class:axes", 0) == 0
    # each 20x20 label contains one full point disc of r=4 -> coverage pi*16/400
    assert m["coverage"]["points"]["mean"] == pytest.approx(math.pi * 16 / 400, abs=0.004)
    assert m["coverage"]["points"]["hard"] is False
    res = result([placed("A", 0, 20, w=20, h=20), placed("B", 150, 20, w=20, h=20)])
    m = evaluate(prob, res)
    assert m["hard"]["class:axes"] == 1          # A crosses the vertical axis line at x=10
    assert "axes" in m["problem"]["hard_classes"]


def test_raster_ink_class():
    # 40x40 white raster with a black 10x10 square at (10,10)-(20,20), raw rgba
    w = h = 40
    px = bytearray()
    for y in range(h):
        for x in range(w):
            px += bytes([0, 0, 0, 255]) if 10 <= x < 20 and 10 <= y < 20 else bytes([255, 255, 255, 255])
    data = base64.b64encode(bytes(px)).decode()
    prob = problem([item("A", 30, 30, w=10, h=10)], width=40, height=40, padding=0,
                   obstacles={"raster": {"rgba": {"width": w, "height": h, "data": data}, "mode": "ink"}},
                   avoid={"label": {"ink": "hard"}})
    m = evaluate(prob, result([placed("A", 15, 15, w=10, h=10)]))   # 5x5 px of ink inside
    assert m["coverage"]["ink"]["mean"] == pytest.approx(25 / 100)
    assert m["hard"]["class:ink"] == 1
    m = evaluate(prob, result([placed("A", 20, 25, w=10, h=10)]))   # touches nothing
    assert m["coverage"]["ink"]["mean"] == pytest.approx(0.0)
    assert m["hard"].get("class:ink", 0) == 0


def test_priority_strict_inversion_prefix_and_ndcg():
    items = [item("hi", 40, 50, priority=3), item("mid", 100, 50, priority=2), item("lo", 160, 50, priority=1)]
    prob = problem(items, priority={"omission": "strict"})
    mx, my = top_right_box(100, 50)
    lx, ly = top_right_box(160, 50, w=30)
    res = result([omitted("hi"), placed("mid", mx, my), placed("lo", lx, ly)])
    m = evaluate(prob, res)
    p = m["priority"]
    assert p["prefix_length"] == 0
    exp = (G[1] / math.log2(2) + G[2] / math.log2(3)) / (G[0] / math.log2(2) + G[1] / math.log2(3))
    assert p["ndcg_at_k"] == pytest.approx(exp)
    assert p["inversions"] == 1 and p["inversion_examples"] == ["hi"]
    # results that report priority info are used as the rank source
    for pl, rank, score in ((res["placements"][0], 0, 3.0), (res["placements"][1], 1, 2.0),
                            (res["placements"][2], 2, 1.0)):
        pl["priority"] = {"tier": 0, "score": score, "rank": rank}
    m = evaluate(prob, res)
    assert m["priority"]["rank_source"] == "result"
    assert m["placement"]["placed_weighted"] == pytest.approx((G[1] + G[2]) / (G[0] + G[1] + G[2]))


def test_removal_test_respects_keys_and_blocking():
    # "lo" is omitted but every adjacent position overlaps the higher-key label of "hi": no inversion
    items = [item("hi", 100, 50, w=120, h=60, priority=2), item("lo", 100, 52, w=10, h=6, priority=1)]
    prob = problem(items, width=200, height=200)
    res = result([placed("hi", 40, 20, w=120, h=60, side="internal", model="internal"), omitted("lo")])
    m = evaluate(prob, res)
    assert m["priority"]["inversions"] == 0
    # now "lo" has the higher priority: blocked only by a lower key -> inversion
    items[0]["priority"], items[1]["priority"] = 1, 2
    m = evaluate(problem(items, width=200, height=200), res)
    assert m["priority"]["inversions"] == 1


def test_removal_test_uses_only_the_items_candidates():
    # "lo" sits right below a wall of hard 'block' rects on its right side; only 'left' is free.
    items = [item("lo", 100, 50)]
    obstacles = {"vector": [{"class": "block", "rects": [[103, 0, 97, 100]]}]}
    prob = problem(items, avoid={"label": {"block": "hard"}}, obstacles=obstacles)
    assert evaluate(prob, result([omitted("lo")]))["priority"]["inversions"] == 1      # 'left' is free
    prob["placement"] = {"position_order": ["right", "top-right", "bottom-right"]}
    m = evaluate(prob, result([omitted("lo")]))
    assert m["priority"]["inversions"] == 0                                           # right side is blocked
    prob["placement"] = {"models": ["distant"]}
    m = evaluate(prob, result([omitted("lo")]))
    assert m["priority"]["inversions"] == 0 and m["priority"]["removal_untestable"] == 1


def test_coverage_satisfaction():
    items = [item("a1", 40, 50, attrs={"cat": "a"}), item("a2", 100, 50, attrs={"cat": "a"}),
             item("b1", 160, 50, attrs={"cat": "b"})]
    prob = problem(items, priority={"coverage": {"by": "attrs.cat", "min_per_group": 1}})
    x, y = top_right_box(40, 50)
    m = evaluate(prob, result([placed("a1", x, y), omitted("a2"), omitted("b1")]))
    c = m["priority"]["coverage"]
    assert c["groups"] == 2 and c["satisfied"] == 1 and c["satisfaction"] == pytest.approx(0.5)
    assert c["unsatisfied"] == ['"b"']


def test_text_degradation_fractions():
    prob = problem([item("A", 30, 50), item("B", 100, 50), item("C", 170, 70)])

    def t(lines, used="original", scale=1.0, size=12.0):
        return {"lines": lines, "used": used, "baseline_offsets": [10.0] * len(lines), "font_size": size,
                "scale": scale}

    res = result([placed("A", 10, 10, text=t(["a", "b"])),
                  placed("B", 80, 10, text=t(["B…"], used="truncated")),
                  placed("C", 150, 30, text=t(["C"], scale=0.85, size=10.2))])
    m = evaluate(prob, res)
    assert m["text"]["n_text"] == 3
    assert m["text"]["wrapped"] == pytest.approx(1 / 3)
    assert m["text"]["truncated"] == pytest.approx(1 / 3)
    assert m["text"]["shrunk"] == pytest.approx(1 / 3)
    assert m["text"]["alternative"] == 0


def test_internal_label_rate_and_outside():
    prob = problem([item("big", 60, 50, w=20, h=10, r=30), item("small", 160, 50, w=20, h=10, r=3)])
    res = result([placed("big", 50, 45, w=20, h=10, side="internal", model="internal"),
                  placed("small", 170, 30, w=20, h=10)])
    m = evaluate(prob, res)
    assert m["shape"]["internal_eligible"] == 1
    assert m["shape"]["internal_rate"] == pytest.approx(1.0)
    res = result([placed("big", 80, 45, w=20, h=10, side="internal", model="internal"),
                  placed("small", 170, 30, w=20, h=10)])
    assert evaluate(prob, res)["hard"]["internal_outside"] == 1


def test_transform_and_y_axis_up():
    # data (10, 10) maps to px (100, 200 - 50) = (100, 150)
    it = item("A", 10, 10)
    prob = problem([it], width=300, height=200, transform=[10, 0, 0, 5, 0, 0], y_axis="up")
    x, y = top_right_box(100, 150)
    m = evaluate(prob, result([placed("A", x, y)]))
    assert m["shape"]["adjacent_gap_abs_mean"] == pytest.approx(0.0, abs=1e-6)


def test_schema_and_id_checks():
    prob = problem([item("A", 50, 50)])
    bad = {"version": "1", "placements": [{"id": "Z", "placed": False}], "stats": {}}
    m = evaluate(prob, bad)
    assert m["result_check"]["schema_errors"]
    assert m["result_check"]["unknown_ids"] == ["Z"]
    assert m["result_check"]["missing_ids"] == ["A"]
