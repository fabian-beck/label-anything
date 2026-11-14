"""The reimplementation of Mumtaz et al. (2019): outward labels, avoided points, no omission."""
from __future__ import annotations

from bench.baselines.mumtaz2019_baseline import solve
from bench.common.geom import Box
from bench.eval.tests.helpers import item, problem


def box(res, iid) -> Box:
    p = next(p for p in res["placements"] if p["id"] == iid)
    assert p["placed"]
    return Box.xywh(p["box"]["x"], p["box"]["y"], p["box"]["w"], p["box"]["h"])


def test_labels_go_outward_beside_their_point():
    # one point in each quadrant: each label lies on the side away from the chart centre
    pts = {"tl": (50.0, 30.0), "tr": (150.0, 30.0), "bl": (50.0, 70.0), "br": (150.0, 70.0)}
    res = solve(problem([item(k, x, y) for k, (x, y) in pts.items()]))
    for k, (x, y) in pts.items():
        b = box(res, k)
        assert (b.cx <= x) == (x < 100.0) and (b.cy <= y) == (y < 50.0), k
        assert b.x0 >= 4.0 and b.x1 <= 196.0 and b.y0 >= 4.0 and b.y1 <= 96.0
        # beside the point: neither on it nor on a leader
        assert b.grow(-0.01).contains_point((x, y)) is False
        p = next(p for p in res["placements"] if p["id"] == k)
        assert p["leader"] is None


def test_non_outlier_points_are_avoided():
    # unlabeled points just above and left of the point leave the label the other sides
    pts = [[50.0 + dx, 30.0 - dy] for dx in range(-24, 25, 4) for dy in range(4, 20, 4)]
    pts += [[50.0 - dx, 30.0 + dy] for dx in range(4, 40, 4) for dy in range(-8, 9, 4)]
    p = problem([item("A", 50.0, 30.0)], obstacles={"vector": [{"class": "points", "r": 1.0, "points": pts}]})
    b = box(solve(p), "A")
    hidden = [q for q in pts if b.grow(1.0).contains_point(tuple(q))]
    assert hidden == []


def test_every_label_is_placed_and_the_result_is_deterministic():
    items = [item(f"i{k}", 100.0 + (k % 3) * 2.0, 50.0 + (k // 3) * 2.0) for k in range(9)]
    p = problem(items)
    a, b = solve(p), solve(p)
    assert all(q["placed"] for q in a["placements"])
    assert [q["box"] for q in a["placements"]] == [q["box"] for q in b["placements"]]
    assert any(q["leader"] for q in a["placements"])  # a crowd needs leaders
