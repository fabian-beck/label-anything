import math

import pytest

from bench.common import geom, text
from bench.common.geom import Box, Circle, Ellipse, Polygon, RoundedRect
from bench.common.model import adjacent_box
from bench.common.rasterize import Raster

R2 = 1 / math.sqrt(2)


def test_support_functions_and_adjacent_positions():
    c = Circle(10, 10, 3)
    assert c.support((1, -1)) == pytest.approx((10 + 3 * R2, 10 - 3 * R2))
    b = adjacent_box(c, 2, 20, 10, "top-right")
    assert (b.x0, b.y1) == pytest.approx((10 + 5 * R2, 10 - 5 * R2))     # corner on the inflated circle
    r = RoundedRect(0, 0, 40, 20, 0)
    assert r.support((0, -1)) == pytest.approx((0, -10))                # flat side: centered
    assert r.support((1, -1)) == pytest.approx((20, -10))               # classic corner position
    rr = RoundedRect(0, 0, 40, 20, 5)
    assert rr.support((1, -1)) == pytest.approx((15 + 5 * R2, -5 - 5 * R2))
    e = Ellipse(0, 0, 20, 10, 90)                                        # rotated: long axis vertical
    assert e.support((0, 1)) == pytest.approx((0, 20))
    tri = Polygon([[(0, 0), (10, 0), (5, 10)]], ref=(5, 3))
    assert tri.support((0, -1)) == pytest.approx((5, 0))                # flat top edge, projection of ref


def test_distances_containment_and_clipping():
    sq = Polygon([[(0, 0), (10, 0), (10, 10), (0, 10)]])
    assert sq.sdist((5, 5)) == pytest.approx(-5) and sq.sdist((13, 14)) == pytest.approx(5)
    assert sq.intersects_box(Box(9, 9, 20, 20)) and not sq.intersects_box(Box(10.5, 0, 20, 20))
    assert sq.clip_area(Box(5, 5, 20, 20)) == pytest.approx(25)
    assert sq.dist_box(Box(13, 0, 20, 10)) == pytest.approx(3)
    c = Circle(0, 0, 10)
    assert c.clip_area(Box(0, 0, 20, 20)) == pytest.approx(math.pi * 25, rel=1e-3)
    holed = Polygon([[(0, 0), (30, 0), (30, 30), (0, 30)], [(10, 10), (20, 10), (20, 20), (10, 20)]])
    assert not holed.contains((15, 15)) and holed.contains((5, 5))
    assert holed.area() == pytest.approx(800)
    assert not holed.intersects_box(Box(12, 12, 18, 18))


def test_segment_predicates():
    assert geom.segments_cross((0, 0), (10, 10), (0, 10), (10, 0))
    assert not geom.segments_cross((0, 0), (10, 0), (10, 0), (20, 5))           # shared endpoint
    assert not geom.segments_cross((0, 0), (10, 0), (9.8, 0.3), (9.8, -5))     # contact within 0.5 px of an end
    assert geom.seg_box_intersects((0, 5), (20, 5), Box(5, 0, 10, 10))
    assert not geom.seg_box_intersects((0, 10), (20, 10), Box(5, 0, 10, 10))   # runs along the edge


def test_polylabel_and_path_flattening():
    l_shape = Polygon([[(0, 0), (40, 0), (40, 10), (10, 10), (10, 40), (0, 40)]])
    p = geom.polylabel(l_shape, 0.1)
    # the junction admits a circle of radius x = (10 - x)·√2, i.e. 10√2 / (1 + √2)
    assert l_shape.contains(p) and -l_shape.sdist(p) == pytest.approx(10 * math.sqrt(2) / (1 + math.sqrt(2)), abs=0.1)
    subs = geom.flatten_path("M0 0 H10 V10 H0 Z M20 20 C20 30 30 30 30 20 Z")
    assert len(subs) == 2 and subs[0][:4] == [(0, 0), (10, 0), (10, 10), (0, 10)]


def test_rasterizer_is_unbiased():
    b = Box(0, 0, 20, 20)
    r = Raster.for_box(b, 8)
    r.disc(10, 10, 5)
    assert r.covered_area() == pytest.approx(math.pi * 25, rel=0.01)
    r = Raster.for_box(b, 8)
    r.polygon([[(2, 2), (12, 2), (12, 12), (2, 12)], [(4, 4), (4, 6), (6, 6), (6, 4)]])
    assert r.covered_area() == pytest.approx(96, rel=0.01)


def test_text_measurement_kerning_and_wrapping():
    f = text.font(400)
    # GPOS pair kerning makes "AV"-like pairs narrower than the sum of advances
    plain = sum(f.adv[g] for g in f.glyphs("AVATAR"))
    assert f.units("AVATAR") < plain
    assert f.width("Hello", 12) == pytest.approx(f.units("Hello") * 12 / 1000)
    meas = text.measure_fn(12, 400)
    s = "com.facebook.react.uimanager.UIManagerModule"
    assert text.break_opportunities("a::b") == [3]
    lines = text.greedy(s, 120, meas)
    assert "".join(lines) == s and all(meas(l) <= 120 for l in lines)
    bal = text.balanced(s, 2, meas)
    assert len(bal) == 2 and "".join(bal) == s
    tr = text.truncate_end(s, 60, 1, meas)
    assert len(tr) == 1 and tr[0].endswith(text.ELLIPSIS) and meas(tr[0]) <= 60
