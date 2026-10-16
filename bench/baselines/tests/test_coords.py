"""Coordinate conversion of the baseline adapters: canvas px (y down) <-> each tool's space.

The end-to-end tests place one isolated label, whose position each tool's
algorithm fixes exactly (its first candidate), so a flipped axis, a missing
offset or a wrong origin shows up as a wrong box.
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from bench.baselines import BASELINES
from bench.baselines.results import build_result, leader_for
from bench.baselines.scene import (RasterMask, build_scene, clip_start, nearest_on_box, ray_exit, segment_entry,
                                   side_of)
from bench.baselines.vega_label_baseline import box_from_label
from bench.common.geom import Box, Circle
from bench.eval import evaluate
from bench.eval.tests.helpers import item, problem

W, H, PAD = 200.0, 100.0, 4.0


def tiny(x=100.0, y=50.0, r=2.0, w=30.0, h=10.0, **kw):
    return problem([item("A", x, y, w=w, h=h, r=r)], width=W, height=H, padding=PAD, **kw)


def have(name: str) -> bool:
    return BASELINES[name].check() is None


# ---------------------------------------------------------------------------
# matplotlib canvas (textalloc, adjustText)
# ---------------------------------------------------------------------------
mpl = pytest.importorskip("matplotlib")


def test_matplotlib_canvas_maps_canvas_px_to_display_px():
    from bench.baselines.mpl import DPI, Canvas, px_to_pt

    area = Box(PAD, PAD, W - PAD, H - PAD)
    cv = Canvas(W, H, area)
    assert DPI == 72.0 and px_to_pt(12.0) == pytest.approx(12.0)
    assert cv.fig.bbox.width == pytest.approx(W) and cv.fig.bbox.height == pytest.approx(H)
    # axes = label area, display coordinates == data coordinates (y up)
    ext = cv.ax.patch.get_extents()
    assert (ext.x0, ext.y0, ext.x1, ext.y1) == pytest.approx((PAD, PAD, W - PAD, H - PAD))
    for x, y in [(10.0, 20.0), (150.0, 90.0), (4.0, 96.0)]:
        xd, yd = cv.to_data(x, y)
        assert yd == pytest.approx(H - y)
        disp = cv.ax.transData.transform((xd, yd))
        assert disp == pytest.approx((x, H - y))
        assert cv.to_canvas(xd, yd) == pytest.approx((x, y))
    # a box given by its lower-left display corner comes back with its top-left canvas corner
    b = cv.box_to_canvas(10.0, 20.0, 30.0, 10.0)
    assert (b.x0, b.y0, b.x1, b.y1) == pytest.approx((10.0, H - 30.0, 40.0, H - 20.0))
    assert cv.xlims() == (PAD, W - PAD) and cv.ylims() == (PAD, H - PAD)
    cv.close()


@pytest.mark.parametrize("ha,va,expect", [("center", "center", (35.0, 55.0, 65.0, 65.0)),
                                          ("left", "baseline", (50.0, 60.0, 80.0, 70.0)),
                                          ("right", "top", (20.0, 50.0, 50.0, 60.0))])
def test_text_extent_is_the_label_box(ha, va, expect):
    from bench.baselines.mpl import Canvas, fix_extent

    cv = Canvas(W, H, Box(0, 0, W, H))
    t = cv.ax.text(50.0, 60.0, "Label", fontsize=10, ha=ha, va=va)
    fix_extent(t, 30.0, 10.0)
    bb = t.get_window_extent()
    assert (bb.x0, bb.y0, bb.x1, bb.y1) == pytest.approx(expect)
    t.set_position((51.0, 60.0))      # follows the text when a tool moves it
    assert t.get_window_extent().x0 == pytest.approx(expect[0] + 1.0)
    cv.close()


def test_noto_sans_is_registered_for_matplotlib():
    from matplotlib import font_manager

    from bench.baselines.mpl import ensure_matplotlib

    ensure_matplotlib()
    f = font_manager.findfont("Noto Sans", fallback_to_default=False)
    assert f.endswith("NotoSans-Regular.ttf")


@pytest.mark.skipif(not have("textalloc"), reason="textalloc not installed")
def test_textalloc_isolated_label_takes_its_first_candidate():
    from bench.baselines import textalloc_baseline as ta

    prob = tiny()
    res = ta.solve(prob)
    p = res["placements"][0]
    assert p["placed"]
    b = Box.from_dict(p["box"])
    lab = build_scene(prob).labels[0]
    # first textalloc candidate ("upper right"): lower-left corner at anchor + (r + offset) in display space,
    # i.e. canvas x0 = x + r + o and y1 = y - (r + o)
    d = lab.mark_radius + lab.offset
    assert (b.x0, b.y1, b.w, b.h) == pytest.approx((100.0 + d, 50.0 - d, lab.w, lab.h), abs=1e-6)
    assert p["anchor_side"] == "top-right" and p["leader"] is None   # the stub to the box corner is no leader
    assert res["stats"]["implementation"].startswith("textalloc/")
    assert evaluate(prob, res)["result_check"]["schema_errors"] == []


@pytest.mark.skipif(not have("adjusttext"), reason="adjustText not installed")
def test_adjusttext_keeps_y_orientation_and_box_size():
    from bench.baselines import adjusttext_baseline as at

    prob = tiny(x=100.0, y=12.0)     # near the top edge: the label must stay near the top
    res = at.solve(prob)
    p = res["placements"][0]
    b = Box.from_dict(p["box"])
    lab = build_scene(prob).labels[0]
    assert (b.w, b.h) == pytest.approx((lab.w, lab.h))
    assert PAD - 1e-6 <= b.y0 and b.cy < H / 2          # stays inside the area, close to its anchor at the top
    assert abs(b.cx - 100.0) < 3 * lab.w
    assert evaluate(prob, res)["result_check"]["schema_errors"] == []


# ---------------------------------------------------------------------------
# vega-label
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("align,baseline,expect", [("left", "top", (10.0, 20.0)), ("center", "middle", (-5.0, 15.0)),
                                                   ("right", "bottom", (-20.0, 10.0))])
def test_vega_box_from_anchor_alignment(align, baseline, expect):
    b = box_from_label(10.0, 20.0, align, baseline, 30.0, 10.0)
    assert (b.x0, b.y0, b.w, b.h) == pytest.approx((*expect, 30.0, 10.0))
    b = box_from_label(10.0, 20.0, align, baseline, 30.0, 10.0, origin=(4.0, 4.0))
    assert (b.x0, b.y0) == pytest.approx((expect[0] + 4.0, expect[1] + 4.0))


@pytest.mark.skipif(not have("vega-label"), reason="node / vega / canvas not installed")
def test_vega_label_isolated_label_takes_the_first_anchor():
    from bench.baselines import vega_label_baseline as vl

    prob = tiny()                      # preset none: perceptual order, the first anchor is "top"
    res = vl.solve(prob)
    p = res["placements"][0]
    b = Box.from_dict(p["box"])
    lab = build_scene(prob).labels[0]
    # vega-label "top": centred on the mark's bounding box, bottom edge offset px above its top
    assert (b.cx, b.y1, b.w, b.h) == pytest.approx((100.0, 50.0 - lab.mark_radius - lab.offset, lab.w, lab.h),
                                                   abs=1e-6)
    assert p["anchor_side"] == "top" and p["leader"] is None
    assert res["stats"]["implementation"].startswith("vega-label/")


def _ink_png_above(x: float, y: float, w: int = 200, h: int = 100) -> str:
    """A white raster with a black block right above (x, y): it covers the "top" positions."""
    import base64
    import io

    from PIL import Image, ImageDraw

    im = Image.new("RGB", (w, h), (255, 255, 255))
    ImageDraw.Draw(im).rectangle([x - 30, y - 30, x + 30, y - 8], fill=(0, 0, 0))   # pixel rows y-30 … y-8
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


@pytest.mark.skipif(not have("vega-label"), reason="node / vega / canvas not installed")
def test_vega_label_avoids_raster_ink_and_lines():
    from bench.baselines import vega_label_baseline as vl

    ink = {"raster": {"source": _ink_png_above(100, 50), "mode": "ink", "class": "ink"}}
    res = vl.solve(tiny(obstacles=ink))
    p = res["placements"][0]
    assert p["placed"] and p["anchor_side"] == "right"        # "top" is inked: the next anchor wins
    b = Box.from_dict(p["box"])
    lab = build_scene(tiny()).labels[0]
    assert b.x0 == pytest.approx(100.0 + lab.mark_radius + lab.offset) and b.cy == pytest.approx(50.0)
    assert any("raster" in w["message"] for w in res["warnings"])
    # a horizontal line through the label's "top" and "right" positions pushes it to "bottom"
    line = {"vector": [{"class": "lines", "polylines": [[[80, 40], [200, 40]], [[100, 50], [200, 50]]],
                        "width": 2}]}
    p = vl.solve(tiny(obstacles=line))["placements"][0]
    assert p["anchor_side"] == "bottom"


@pytest.mark.skipif(not have("textalloc"), reason="textalloc not installed")
def test_textalloc_avoids_raster_ink():
    from bench.baselines import textalloc_baseline as ta

    prob = tiny(obstacles={"raster": {"source": _ink_png_above(100, 50, 200, 100), "mode": "ink", "class": "ink"}})
    p = ta.solve(prob)["placements"][0]
    b = Box.from_dict(p["box"])
    ink = Box(70.0, 20.0, 131.0, 43.0)                          # the inked pixels (x 70…130, y 20…42)
    assert p["placed"] and not b.overlaps(ink)
    assert p["anchor_side"] != "top-right"                      # its first candidate is inked


# ---------------------------------------------------------------------------
# ggrepel
# ---------------------------------------------------------------------------
@pytest.mark.skipif(not have("ggrepel"), reason="R / ggrepel not installed")
def test_ggrepel_label_near_its_anchor_with_y_orientation():
    from bench.baselines import ggrepel_baseline as gg

    prob = tiny(x=60.0, y=14.0)
    res = gg.solve(prob)
    p = res["placements"][0]
    assert p["placed"]
    b = Box.from_dict(p["box"])
    lab = build_scene(prob).labels[0]
    assert (b.w, b.h) == pytest.approx((lab.w, lab.h))
    assert b.cy < H / 2 and abs(b.cx - 60.0) < 2 * lab.w     # not mirrored to the bottom
    assert PAD - 0.5 <= b.y0 and b.x0 >= PAD - 0.5
    assert res["stats"]["implementation"].startswith("ggrepel/")


def test_ggrepel_composite_text_is_padded_to_the_box():
    from bench.baselines.ggrepel_baseline import _label_text

    prob = problem([{"id": "c", "anchor": {"type": "point", "x": 50, "y": 50},
                     "label": {"type": "composite", "padding": 2, "gap": 3,
                               "parts": [{"type": "icon", "width": 12, "height": 12},
                                         {"type": "text", "text": "Café"}]}}], width=W, height=H)
    lab = build_scene(prob).labels[0]
    t = _label_text(lab)
    assert t.endswith("Café") and t.startswith(" ") and len(t) - len("Café") >= 3


# ---------------------------------------------------------------------------
# scene and result helpers
# ---------------------------------------------------------------------------
def test_raster_mask_cells_and_runs_in_canvas_px():
    mask = np.zeros((4, 6), dtype=bool)
    mask[1, 2:5] = True              # one run of 3 raster px in row 1
    mask[3, 0] = True
    m = RasterMask("ink", mask, scale=2.0, offset=(10.0, 20.0), mode="ink")
    assert m.count == 4
    runs = m.runs()
    assert runs == [(11.0, 20.5, 1.5, 0.5), (10.0, 21.5, 0.5, 0.5)]
    cells = m.cells(1.0)             # pixel centres (11.25, 20.75) … -> 1-px cells
    assert (11.0, 20.0, 1.0) in cells and (10.0, 21.0, 1.0) in cells and len(cells) == 3


def test_scene_from_vector_and_raster_obstacles():
    import base64
    import io

    from PIL import Image

    im = Image.new("RGB", (20, 10), (255, 255, 255))
    for x in range(5, 8):
        im.putpixel((x, 4), (0, 0, 0))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    prob = tiny(obstacles={"vector": [{"class": "lines", "polylines": [[[0, 90], [200, 90]]], "width": 2},
                                      {"class": "bg", "points": [[5, 5]], "r": 1}],
                           "raster": {"source": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(),
                                      "mode": "ink", "class": "ink", "scale": 0.5, "offset": [100, 0]}},
                avoid={"label": {"bg": "ignore"}})
    sc = build_scene(prob)
    assert [c for c in sc.obstacles.classes()] == ["ink", "lines"]          # "bg" is ignored for labels
    assert sc.obstacles.polylines[0][1] == 2.0
    (m,) = sc.obstacles.masks
    assert m.count == 3 and m.scale == 0.5 and m.offset == (100.0, 0.0)
    assert m.runs() == [(110.0, 8.0, 6.0, 2.0)]                              # raster px 5..7 of row 4, x2
    assert any(n.feature == "raster:ink" and n.kind == "emulation" for n in sc.notes)


def test_geometry_helpers():
    c = Circle(0.0, 0.0, 2.0)
    assert clip_start(c, (0.0, 0.0), (10.0, 0.0)) == pytest.approx((2.0, 0.0), abs=1e-9)
    assert clip_start(c, (0.0, 0.0), (1.0, 0.0)) is None                     # the port lies inside the mark
    b = Box(10.0, 10.0, 20.0, 20.0)
    assert segment_entry(b, (0.0, 15.0), (30.0, 15.0)) == pytest.approx((10.0, 15.0))
    assert segment_entry(b, (0.0, 0.0), (5.0, 30.0)) is None
    assert ray_exit(b, (15.0, 15.0), (15.0, 40.0)) == pytest.approx((15.0, 20.0))
    assert nearest_on_box(b, (0.0, 15.0)) == (10.0, 15.0)
    assert side_of(Box(5, -10, 15, -2), 0.0, 0.0) == "top-right"
    assert side_of(Box(-5, 3, 5, 8), 0.0, 0.0) == "bottom"
    assert side_of(Box(-15, -2, -3, 2), 0.0, 0.0) == "left"
    assert side_of(Box(-1, -3, 5, 1), 0.0, 0.0) == "top-right"              # covers the anchor: by its centre


def test_result_is_schema_valid_and_short_stubs_are_not_leaders():
    prob = problem([item("A", 50, 50), item("B", 150, 50), item("C", 100, 80)], width=W, height=H)
    sc = build_scene(prob)
    a, b_ = sc.labels[0], sc.labels[1]
    near = Box(52.0 + 2.0, 50.0 - 2.0 - a.h - 2.0, 52.0 + 2.0 + a.w, 50.0 - 4.0)   # adjacent-ish
    far = Box(150.0 + 40.0 - b_.w, 10.0, 190.0, 10.0 + b_.h)
    assert leader_for(a, near, nearest_on_box(near, (50.0, 50.0))) is None
    lead = leader_for(b_, far, nearest_on_box(far, (150.0, 50.0)))
    assert lead is not None and math.dist(lead["points"][0], (150.0, 50.0)) == pytest.approx(b_.mark_radius)
    res = build_result(sc, {"A": near, "B": far}, {"B": nearest_on_box(far, (150.0, 50.0))}, 1.5, "test/0")
    m = evaluate(prob, res)
    assert m["result_check"]["schema_errors"] == []
    assert m["placement"]["placed"] == 2 and res["placements"][2]["reason"] == "no_feasible_candidate"
    assert res["placements"][1]["model"] == "distant" and res["placements"][1]["leader"]["style"] == "straight"
    assert m["leaders"]["count"] == 1
