"""The Result object: placements, leaders, export."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import label_anything as la


def crowded() -> la.Result:
    pts = [(100.0 + (i % 5) * 3.0, 100.0 + (i // 5) * 3.0) for i in range(15)]
    return la.place(pts, [f"label {i}" for i in range(15)], canvas=(300, 220), models=["adjacent", "distant"], leaders="straight", priority=la.Priority.input_order())


def test_placements() -> None:
    res = crowded()
    assert len(res) == len(res.placements) == 15
    assert [p.id for p in res] == [str(i) for i in range(15)]
    placed, unplaced = res.placed, res.unplaced
    assert placed and unplaced
    assert len(placed) + len(unplaced) == 15
    for p in placed:
        assert isinstance(p, la.Placement)
        assert p.box is not None and p.box.w > 0 and p.box.h > 0
        assert p.model in ("adjacent", "slider", "distant", "internal", "boundary")
        # the degradation ladder may wrap a label onto two lines
        assert " ".join(p.lines) == f"label {p.id}"
        assert len(p.baselines) == len(p.lines)
        assert all(p.box.y < b < p.box.y1 for b in p.baselines)
        assert p.priority is not None and "rank" in p.priority
        assert p.reason is None
    for p in unplaced:
        assert p.box is None and p.reason is not None
    assert set(res.omission_order) == {p.id for p in unplaced}
    assert res["0"] is res.placements[0] and res.get("nope") is None
    with pytest.raises(KeyError):
        res["nope"]
    # placed boxes do not overlap
    boxes = [p.box for p in placed if p.box is not None]
    for i, a in enumerate(boxes):
        for b in boxes[i + 1 :]:
            assert not a.intersects(b, 1e-6)
    assert "placed=" in repr(res)


def test_leaders() -> None:
    res = crowded()
    with_leader = [p for p in res.placed if p.leader is not None]
    assert with_leader, "expected some distant labels"
    for p in with_leader:
        ld = p.leader
        assert ld is not None and isinstance(ld, la.Leader)
        assert ld.style == "straight" and len(ld.points) >= 2
        assert ld.points[-1] == pytest.approx(ld.port)
        assert ld.length > 0
        assert p.all_leaders == (ld,)
        assert p.model == "distant"


def test_bbox_helpers() -> None:
    b = la.BBox(10, 20, 30, 40)
    assert (b.x0, b.y0, b.x1, b.y1, b.cx, b.cy) == (10, 20, 40, 60, 25, 40)
    assert b.center == (25, 40) and b.contains(10, 60) and not b.contains(9, 30)
    assert b.intersects(la.BBox(39, 59, 5, 5)) and not b.intersects(la.BBox(40, 20, 5, 5))


def test_export(tmp_path: Path) -> None:
    res = crowded()
    d = res.to_dict()
    assert d == res.raw and d is not res.raw
    d["placements"].clear()
    assert res.raw["placements"]
    assert json.loads(res.to_json()) == res.raw
    svg_path = tmp_path / "debug.svg"
    svg = res.to_svg(svg_path)
    assert svg.startswith("<svg") and svg.rstrip().endswith("</svg>")
    assert svg_path.read_text(encoding="utf-8") == svg
    assert la.render_svg(res.problem or {}, res) == svg
    assert la.render_svg(res.problem or {}, res.to_json()) == svg


def test_debug_svg_from_the_solve() -> None:
    res = la.place([(50, 50), (52, 51)], ["a", "b"], canvas=(200, 100), debug_svg=True)
    assert res.debug_svg is not None and res.debug_svg.startswith("<svg")
    assert res.to_svg() == res.debug_svg
    plain = la.place([(50, 50), (52, 51)], ["a", "b"], canvas=(200, 100))
    assert plain.debug_svg is None


def test_result_without_problem() -> None:
    res = la.Result({"version": "1", "placements": [], "stats": {"placed": 0, "total": 0}})
    with pytest.raises(ValueError):
        res.to_svg()
    assert res.omission_order == [] and res.warnings == []


def test_groups_and_parts() -> None:
    res = la.place(
        [(100, 100), (100.3, 100.2), (200, 60)],
        ["A", "B", la.Composite([la.Icon(10, 10), "Server"], gap=2)],
        ids=["a", "b", "c"],
        groups=["dup", "dup", None],
        canvas=(300, 200),
    )
    grouped = [p for p in res.placements if p.members]
    assert grouped and set(grouped[0].members) == {"a", "b"}
    c = res["c"]
    assert c.placed and len(c.parts) == 2
    assert c.parts[1]["text"]["lines"] == ["Server"]


def test_problem_path_strings(tmp_path) -> None:
    import json as _json

    import label_anything as la

    problem = {"canvas": {"width": 200, "height": 100},
               "items": [{"id": "a", "anchor": {"type": "point", "x": 100, "y": 50},
                          "label": {"type": "text", "text": "A"}}]}
    f = tmp_path / "problem.json"
    f.write_text(_json.dumps(problem), encoding="utf-8")
    # a string that is not JSON text is the path of a JSON file
    assert len(la.place_problem(str(f)).placed) == len(la.place_problem(problem).placed) == 1
    assert la.validate(str(f)).valid
    try:
        la.place_problem(str(tmp_path / "missing.json"))
    except FileNotFoundError as e:
        assert "missing.json" in str(e)
    else:
        raise AssertionError("expected FileNotFoundError")
