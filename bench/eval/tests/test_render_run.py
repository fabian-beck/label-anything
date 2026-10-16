"""Renderer and runner smoke tests."""
from __future__ import annotations

import xml.etree.ElementTree as ET

from bench import render
from bench.eval.tests.helpers import item, omitted, placed, problem, result
from bench.run import pct, shifted_warm_start
from bench.solvers import naive


def test_render_svg_and_png():
    prob = problem([item("A", 50, 50), item("B", 120, 50, r=6),
                    {"id": "E", "anchor": {"type": "point", "x": 160, "y": 70,
                                           "mark": {"shape": "ellipse", "rx": 9, "ry": 4, "rotation": 30}},
                     "label": {"type": "text", "text": "Ellipse & <co>"}}],
                   obstacles={"vector": [{"class": "lines", "polylines": [[[0, 90], [200, 90]]]}]})
    res = naive.solve(prob)
    res["placements"][1] = omitted("B")
    svg = render.render_svg(prob, res, font_href="fonts/NotoSans-Regular.ttf")
    root = ET.fromstring(svg)                       # well-formed XML
    texts = [t.text for t in root.iter("{http://www.w3.org/2000/svg}text")]
    assert "Ellipse & <co>" in texts and "A" in texts
    img = render.render_png(prob, res, scale=1.0)
    assert img.size == (200, 100)
    # the unplaced item is drawn as a red cross at its anchor
    r, g, b = img.getpixel((120, 50))
    assert r > 150 and g < 120


def test_warm_start_shift_and_percentile():
    p0 = problem([item("A", 50, 50), item("B", 100, 50)])
    p1 = problem([item("A", 80, 60), item("C", 10, 10)])
    r0 = result([placed("A", 55, 30), placed("B", 105, 30)])
    ws = shifted_warm_start(p0, r0, p1)
    assert ws == {"placements": [{"id": "A", "placed": True, "box": {"x": 85.0, "y": 40.0, "w": 30, "h": 10}}]}
    assert pct([5, 1, 3, 2, 4], 0.95) == 5 and pct([5, 1, 3, 2, 4], 0.5) == 3
