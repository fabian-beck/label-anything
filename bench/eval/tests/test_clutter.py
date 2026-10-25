"""Clutter: the edge density of the labels and leaders (``clutter.py``)."""
from __future__ import annotations

import pytest

from bench.eval import evaluate
from bench.eval.clutter import _outlines, text_edges
from bench.eval.tests.helpers import item, placed, problem, result


def _text(lines, size=12.0, weight=400):
    return {"lines": lines, "font_size": size, "font_weight": weight}


def _clutter(prob, placements):
    return evaluate(prob, result(placements), removal_test=False)["clutter"]


def test_text_edges_are_the_glyph_outlines_at_the_font_size():
    cmap, notdef = _outlines(400)
    o, i = cmap[ord("o")], cmap[ord("i")]
    # a lowercase o is two closed curves of about 1.4 em each
    assert 2.5 < o < 3.2 and i < o
    assert text_edges(_text(["oi"])) == pytest.approx((o + i) * 12.0)
    assert text_edges(_text(["oi"], size=24.0)) == pytest.approx(2 * (o + i) * 12.0)
    # spaces have no outline, lines add up, a character the font lacks counts as .notdef
    assert text_edges(_text(["o i", "o"])) == pytest.approx((2 * o + i) * 12.0)
    assert text_edges(_text(["一"])) == pytest.approx(notdef * 12.0)
    # bold glyphs have outlines of their own
    assert text_edges(_text(["o"], weight=700)) != pytest.approx(o * 12.0)


def test_edge_density_counts_text_and_both_edges_of_every_leader():
    prob = problem([item("A", 50, 50), item("B", 150, 50)])
    a = placed("A", 53, 45, side="right", text=_text(["A"]))
    b = placed("B", 160, 20, side="top-right", model="distant", text=_text(["B"]),
               leader={"points": [[152, 48], [160, 30]], "style": "straight"})
    c = _clutter(prob, [a, b])
    area = 200 * 100
    text = text_edges(_text(["A"])) + text_edges(_text(["B"]))
    leader = 2 * (8 ** 2 + 18 ** 2) ** 0.5
    assert c["text"] == pytest.approx(text / area)
    assert c["leaders"] == pytest.approx(leader / area)
    assert c["edge_density"] == pytest.approx((text + leader) / area)
    assert c["leader_share"] == pytest.approx(leader / (text + leader))
    assert c["per_label_em"] == pytest.approx((text + leader) / 2 / 12.0)
    assert c["box_area"] == pytest.approx(2 * 30 * 10 / area)
    # more labels, more clutter; none, none
    assert _clutter(prob, [a])["edge_density"] < c["edge_density"]
    empty = _clutter(prob, [])
    assert empty["edge_density"] == 0.0 and empty["leader_share"] is None and empty["per_label_em"] is None


def test_icons_boxes_and_underlines():
    prob = problem([item("A", 50, 50)])
    # a label without text (an icon or a box) counts the perimeter of its box
    c = _clutter(prob, [placed("A", 53, 45, w=10, h=10, side="right")])
    assert c["edge_density"] == pytest.approx(40 / (200 * 100))
    # composite: text parts by their glyphs, other parts by their boxes; an underline is part of the leader
    comp = placed("A", 53, 45, w=40, h=10, side="right", model="distant",
                  parts=[{"type": "icon", "box": {"x": 53, "y": 45, "w": 8, "h": 8}},
                         {"type": "text", "box": {"x": 63, "y": 45, "w": 30, "h": 10}, "text": _text(["oi"])}],
                  leader={"points": [[52, 50], [53, 50]], "underline": [[53, 55], [93, 55]], "style": "straight"})
    c = _clutter(prob, [comp])
    assert c["text"] * 200 * 100 == pytest.approx(32 + text_edges(_text(["oi"])))
    assert c["leaders"] * 200 * 100 == pytest.approx(2 * (1 + 40))


def test_unbounded_problems_use_the_extent_of_marks_and_labels():
    prob = problem([item("A", 50, 50, r=2)])
    del prob["canvas"]
    c = _clutter(prob, [placed("A", 53, 45, w=10, h=10, side="right")])
    # marks from (48, 48) to (52, 52), the label from (53, 45) to (63, 55): 15 x 10 px
    assert c["edge_density"] == pytest.approx(40 / (15 * 10))
