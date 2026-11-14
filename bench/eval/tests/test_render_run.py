"""Renderer and runner smoke tests."""
from __future__ import annotations

import xml.etree.ElementTree as ET

from bench import render
from bench.eval import evaluate
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


def test_standalone_svg_vector_background_font_and_colors(tmp_path):
    prob = problem([item("A", 50, 50, attrs={"color": "#e15759"}), item("B", 120, 50, r=6)],
                   obstacles={"vector": [{"class": "lines", "polylines": [[[0, 90], [200, 90]]]}]})
    res = naive.solve(prob)
    res["placements"][0]["text"] = {"lines": ["Ab V"], "baseline_offsets": [9.0], "font_size": 10.0,
                                    "font_weight": 400, "x_offset": 0.0}
    res["placements"][1] = omitted("B")
    bg = tmp_path / "p.bg.svg"
    bg.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">'
                  '<rect class="bg" width="200" height="100" fill="#d7e7f1"/>'
                  '<text x="5" y="20" font-size="9">Map &amp; title</text></svg>\n', encoding="utf-8")
    svg = render.standalone_svg(prob, res, bg, title="Tiny")
    root = ET.fromstring(svg)                       # well-formed XML
    ns = "{http://www.w3.org/2000/svg}"
    assert root.get("viewBox") == "0 0 200 100" and root.find(ns + "title").text == "Tiny"
    # the background is inlined as vectors (no grey obstacle layer), the font subset is embedded
    assert root.find(f"{ns}svg") is not None and root.find(f"{ns}g[@class='obstacles']") is None
    assert "@font-face" in svg and "data:font/woff;base64," in svg
    # every glyph of a label at its pen position: one x per character
    t = next(e for e in root.iter(ns + "text") if e.text == "Ab V")
    xs = [float(v) for v in t.get("x").split()]
    assert len(xs) == 4 and xs[0] == round(res["placements"][0]["box"]["x"], 2) and xs == sorted(xs)
    # the item's data color, a darker outline; the omitted item as a red cross
    marks = list(root.find(f"{ns}g[@class='marks']"))
    assert marks[0].get("fill") == "#e15759" and marks[0].get("stroke") == render._darker("#e15759")
    assert marks[1].get("fill") == render.MARK_FILL
    assert len(list(root.find(f"{ns}g[@class='unplaced']"))) == 1
    # without a background, the vector layers are drawn in grey
    root = ET.fromstring(render.standalone_svg(prob, res))
    assert root.find(f"{ns}g[@class='obstacles']") is not None


def test_violations_are_drawn_over_the_result():
    # E's and F's labels overlap; A's label is about as near to B's mark as to its own
    prob = problem([item("A", 30, 50), item("B", 67, 50), item("E", 120, 80), item("F", 170, 80)])
    res = result([placed("A", 33, 45, side="right"), placed("B", 70, 20, side="top-right"),
                  placed("E", 123, 65), placed("F", 140, 68, side="top-left")])
    marks = evaluate(prob, res, removal_test=False, marks=True)["marks"]
    assert marks["overlaps"] == [[140, 68, 153, 75]] and marks["labels"] == ["E", "F"]
    assert marks["ambiguous"] == [{"label": "A", "level": "unclear", "point": [67, 50]}]
    ns = "{http://www.w3.org/2000/svg}"
    for svg in (render.render_svg(prob, res, marks=marks), render.standalone_svg(prob, res, marks=marks)):
        g = ET.fromstring(svg).find(f"{ns}g[@class='violations']")
        shared = [e for e in g if e.tag == ns + "rect" and e.get("fill") == render.CONFLICT]
        assert [(e.get("x"), e.get("width")) for e in shared] == [("140", "13")]
        assert sum(1 for e in g if e.tag == ns + "rect" and e.get("stroke") == render.CONFLICT) == 2
        assert any(e.tag == ns + "line" and e.get("stroke") == render.AMBIGUOUS and e.get("stroke-dasharray")
                   for e in g)
    assert ET.fromstring(render.render_svg(prob, res)).find(f"{ns}g[@class='violations']") is None
    plain = render.render_png(prob, res)
    img = render.render_png(prob, res, marks=marks)
    # the area the two labels share is tinted red; the ambiguous label's line runs to B's mark
    r, g, b = img.getpixel((146, 71))
    assert r > 200 and g < 170 and (r, g, b) != plain.getpixel((146, 71))
    r, g, b = img.getpixel((65, 50))
    assert r > 200 and 90 < g < 200 and b < 120
    assert all(render.violation_icon(k).startswith("<svg") for k, _c, _t in render.VIOLATIONS)


def test_warm_start_shift_and_percentile():
    p0 = problem([item("A", 50, 50), item("B", 100, 50)])
    p1 = problem([item("A", 80, 60), item("C", 10, 10)])
    r0 = result([placed("A", 55, 30), placed("B", 105, 30)])
    ws = shifted_warm_start(p0, r0, p1)
    assert ws == {"placements": [{"id": "A", "placed": True, "box": {"x": 85.0, "y": 40.0, "w": 30, "h": 10}}]}
    assert pct([5, 1, 3, 2, 4], 0.95) == 5 and pct([5, 1, 3, 2, 4], 0.5) == 3
