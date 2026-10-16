"""Geometry kernel of the benchmark tools (independent of the engine).

Implements the item shapes of spec §3.2 with the operations of the shape kernel
(§3.3) that the evaluator, renderer and baseline solvers need:

* ``bbox``, ``contains``, signed ``sdist`` (negative inside), ``support`` (with
  the flat-side rule: the point of a flat side closest to the projection of the
  reference point), ``intersects_box``, ``dist_box`` / ``sdist_box``,
  ``intersects_segment``, ``area`` and ``clip_area`` (area inside a box).

Circles and the support functions of circles, ellipses and (rounded, rotated)
rectangles are exact. Curved outlines are flattened into polygons with a chord
error of at most ``FLATTEN_TOL`` (0.02 px), far below the evaluator's 0.5 px
tolerance; SVG path data is flattened with the spec's 0.25 px tolerance.

Coordinates are canvas pixels, y down. Rotations are degrees clockwise on
screen (SVG ``rotate``).
"""
from __future__ import annotations

import heapq
import math
import re
from dataclasses import dataclass
from typing import Iterable, Sequence

import numpy as np

Point = tuple[float, float]
EPS = 1e-9
FLATTEN_TOL = 0.02


# ---------------------------------------------------------------------------
# Boxes
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Box:
    x0: float
    y0: float
    x1: float
    y1: float

    @staticmethod
    def xywh(x: float, y: float, w: float, h: float) -> "Box":
        return Box(x, y, x + w, y + h)

    @staticmethod
    def from_dict(d: dict) -> "Box":
        return Box(d["x"], d["y"], d["x"] + d["w"], d["y"] + d["h"])

    @property
    def w(self) -> float:
        return self.x1 - self.x0

    @property
    def h(self) -> float:
        return self.y1 - self.y0

    @property
    def cx(self) -> float:
        return 0.5 * (self.x0 + self.x1)

    @property
    def cy(self) -> float:
        return 0.5 * (self.y0 + self.y1)

    @property
    def area(self) -> float:
        return max(0.0, self.w) * max(0.0, self.h)

    def shrink(self, t: float) -> "Box":
        """Erode by ``t`` on every side (an empty box collapses to its center line)."""
        x0, x1 = self.x0 + t, self.x1 - t
        y0, y1 = self.y0 + t, self.y1 - t
        if x0 > x1:
            x0 = x1 = self.cx
        if y0 > y1:
            y0 = y1 = self.cy
        return Box(x0, y0, x1, y1)

    def grow(self, t: float) -> "Box":
        return Box(self.x0 - t, self.y0 - t, self.x1 + t, self.y1 + t)

    def overlaps(self, o: "Box") -> bool:
        """Open-interior overlap (touching boxes do not overlap)."""
        return self.x0 < o.x1 and o.x0 < self.x1 and self.y0 < o.y1 and o.y0 < self.y1

    def overlap_extent(self, o: "Box") -> tuple[float, float]:
        return (min(self.x1, o.x1) - max(self.x0, o.x0), min(self.y1, o.y1) - max(self.y0, o.y0))

    def intersection_area(self, o: "Box") -> float:
        ox, oy = self.overlap_extent(o)
        return ox * oy if ox > 0 and oy > 0 else 0.0

    def contains_point(self, p: Point) -> bool:
        return self.x0 <= p[0] <= self.x1 and self.y0 <= p[1] <= self.y1

    def contains_box(self, o: "Box", tol: float = 0.0) -> bool:
        return (o.x0 >= self.x0 - tol and o.y0 >= self.y0 - tol and o.x1 <= self.x1 + tol
                and o.y1 <= self.y1 + tol)

    def corners(self) -> list[Point]:
        return [(self.x0, self.y0), (self.x1, self.y0), (self.x1, self.y1), (self.x0, self.y1)]

    def union(self, o: "Box") -> "Box":
        return Box(min(self.x0, o.x0), min(self.y0, o.y0), max(self.x1, o.x1), max(self.y1, o.y1))

    def as_dict(self) -> dict:
        return {"x": self.x0, "y": self.y0, "w": self.w, "h": self.h}


def point_box_dist(p: Point, b: Box) -> float:
    dx = max(b.x0 - p[0], 0.0, p[0] - b.x1)
    dy = max(b.y0 - p[1], 0.0, p[1] - b.y1)
    return math.sqrt(dx * dx + dy * dy)


def box_box_dist(a: Box, b: Box) -> float:
    dx = max(a.x0 - b.x1, 0.0, b.x0 - a.x1)
    dy = max(a.y0 - b.y1, 0.0, b.y0 - a.y1)
    return math.sqrt(dx * dx + dy * dy)


# ---------------------------------------------------------------------------
# Segments
# ---------------------------------------------------------------------------
def _cross(o: Point, a: Point, b: Point) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def point_seg_dist(p: Point, a: Point, b: Point) -> float:
    vx, vy = b[0] - a[0], b[1] - a[1]
    wx, wy = p[0] - a[0], p[1] - a[1]
    vv = vx * vx + vy * vy
    t = 0.0 if vv <= 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / vv))
    dx, dy = wx - t * vx, wy - t * vy
    return math.sqrt(dx * dx + dy * dy)


def segments_intersect(p1: Point, p2: Point, q1: Point, q2: Point) -> bool:
    """Closed segments share at least one point."""
    d1 = _cross(q1, q2, p1)
    d2 = _cross(q1, q2, p2)
    d3 = _cross(p1, p2, q1)
    d4 = _cross(p1, p2, q2)
    if ((d1 > 0 > d2) or (d1 < 0 < d2)) and ((d3 > 0 > d4) or (d3 < 0 < d4)):
        return True
    return (point_seg_dist(p1, q1, q2) <= EPS or point_seg_dist(p2, q1, q2) <= EPS
            or point_seg_dist(q1, p1, p2) <= EPS or point_seg_dist(q2, p1, p2) <= EPS)


def seg_seg_dist(a: Point, b: Point, c: Point, d: Point) -> float:
    if segments_intersect(a, b, c, d):
        return 0.0
    return min(point_seg_dist(a, c, d), point_seg_dist(b, c, d),
               point_seg_dist(c, a, b), point_seg_dist(d, a, b))


def segments_cross(p1: Point, p2: Point, q1: Point, q2: Point, tol: float = 0.5) -> bool:
    """Proper crossing of two segments, ignoring contacts within ``tol`` of an endpoint.

    Used for leader–leader crossings: leaders that merely touch (e.g. share an
    attachment point or meet end-to-side within the tolerance) do not count.
    """
    d1 = _cross(q1, q2, p1)
    d2 = _cross(q1, q2, p2)
    d3 = _cross(p1, p2, q1)
    d4 = _cross(p1, p2, q2)
    if not (((d1 > 0 > d2) or (d1 < 0 < d2)) and ((d3 > 0 > d4) or (d3 < 0 < d4))):
        return False
    # intersection point
    t = d1 / (d1 - d2)
    ix = p1[0] + t * (p2[0] - p1[0])
    iy = p1[1] + t * (p2[1] - p1[1])
    for e in (p1, p2, q1, q2):
        if math.hypot(ix - e[0], iy - e[1]) <= tol:
            return False
    return True


def seg_box_intersects(a: Point, b: Point, box: Box) -> bool:
    """Liang–Barsky: does the closed segment meet the open interior of the box?"""
    if box.x1 - box.x0 <= 0 or box.y1 - box.y0 <= 0:
        return False
    t0, t1 = 0.0, 1.0
    dx, dy = b[0] - a[0], b[1] - a[1]
    for p, q in ((-dx, a[0] - box.x0), (dx, box.x1 - a[0]), (-dy, a[1] - box.y0), (dy, box.y1 - a[1])):
        if abs(p) < 1e-15:
            if q <= 0:
                return False
        else:
            r = q / p
            if p < 0:
                if r > t1:
                    return False
                t0 = max(t0, r)
            else:
                if r < t0:
                    return False
                t1 = min(t1, r)
    if t0 > t1:
        return False
    # require a positive-length piece strictly inside (not just touching an edge)
    mx = a[0] + 0.5 * (t0 + t1) * dx
    my = a[1] + 0.5 * (t0 + t1) * dy
    return box.x0 < mx < box.x1 and box.y0 < my < box.y1


def seg_box_dist(a: Point, b: Point, box: Box) -> float:
    if box.contains_point(a) or box.contains_point(b) or seg_box_intersects(a, b, box):
        return 0.0
    c = box.corners()
    best = min(point_box_dist(a, box), point_box_dist(b, box))
    for i in range(4):
        best = min(best, seg_seg_dist(a, b, c[i], c[(i + 1) % 4]))
    return best


def polyline_length(pts: Sequence[Point]) -> float:
    return sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1))


# ---------------------------------------------------------------------------
# Rings / polygons helpers
# ---------------------------------------------------------------------------
def ring_area(r: Sequence[Point]) -> float:
    """Signed area (positive = clockwise on screen with y down = CCW in math coords)."""
    s = 0.0
    n = len(r)
    for i in range(n):
        x0, y0 = r[i]
        x1, y1 = r[(i + 1) % n]
        s += x0 * y1 - x1 * y0
    return 0.5 * s


def winding_number(p: Point, ring: Sequence[Point]) -> int:
    wn = 0
    n = len(ring)
    px, py = p
    for i in range(n):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % n]
        if y0 <= py:
            if y1 > py and (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) > 0:
                wn += 1
        elif y1 <= py and (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) < 0:
            wn -= 1
    return wn


def crossings(p: Point, ring: Sequence[Point]) -> int:
    c = 0
    n = len(ring)
    px, py = p
    for i in range(n):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % n]
        if (y0 > py) != (y1 > py):
            xi = x0 + (py - y0) * (x1 - x0) / (y1 - y0)
            if px < xi:
                c += 1
    return c


def convex_hull(points: Iterable[Point]) -> list[Point]:
    pts = sorted(set((float(x), float(y)) for x, y in points))
    if len(pts) <= 2:
        return pts
    lower: list[Point] = []
    for p in pts:
        while len(lower) >= 2 and _cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list[Point] = []
    for p in reversed(pts):
        while len(upper) >= 2 and _cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def clip_ring_to_box(ring: Sequence[Point], b: Box) -> list[Point]:
    """Sutherland–Hodgman clip of a ring against an axis-aligned box."""
    out = list(ring)

    def clip(pts, inside, inter):
        res = []
        n = len(pts)
        for i in range(n):
            cur, prev = pts[i], pts[i - 1]
            ci, pi = inside(cur), inside(prev)
            if ci:
                if not pi:
                    res.append(inter(prev, cur))
                res.append(cur)
            elif pi:
                res.append(inter(prev, cur))
        return res

    def ix(x):
        return lambda p, q: (x, p[1] + (q[1] - p[1]) * (x - p[0]) / (q[0] - p[0]))

    def iy(y):
        return lambda p, q: (p[0] + (q[0] - p[0]) * (y - p[1]) / (q[1] - p[1]), y)

    for inside, inter in ((lambda p: p[0] >= b.x0, ix(b.x0)), (lambda p: p[0] <= b.x1, ix(b.x1)),
                          (lambda p: p[1] >= b.y0, iy(b.y0)), (lambda p: p[1] <= b.y1, iy(b.y1))):
        if not out:
            break
        out = clip(out, inside, inter)
    return out


def _rot(theta_deg: float) -> tuple[float, float]:
    t = math.radians(theta_deg)
    return math.cos(t), math.sin(t)


def _apply_rot(p: Point, cs: tuple[float, float]) -> Point:
    c, s = cs
    return (c * p[0] - s * p[1], s * p[0] + c * p[1])


def _unit(d: Point) -> Point:
    n = math.hypot(d[0], d[1])
    if n == 0:
        raise ValueError("zero direction")
    return (d[0] / n, d[1] / n)


def _arc_segments(r: float, sweep: float, tol: float = FLATTEN_TOL) -> int:
    if r <= tol:
        return 1
    step = 2.0 * math.acos(max(-1.0, 1.0 - tol / r))
    return max(2, int(math.ceil(sweep / max(step, 1e-6))))


# ---------------------------------------------------------------------------
# Shapes
# ---------------------------------------------------------------------------
class Shape:
    """Base class. ``ref`` is the reference point (spec §3.2)."""

    ref: Point
    kind: str = "shape"

    def bbox(self) -> Box:  # pragma: no cover - abstract
        raise NotImplementedError

    def contains(self, p: Point) -> bool:  # pragma: no cover
        raise NotImplementedError

    def sdist(self, p: Point) -> float:  # pragma: no cover
        raise NotImplementedError

    def intersects_box(self, b: Box) -> bool:  # pragma: no cover
        raise NotImplementedError

    def dist_box(self, b: Box) -> float:  # pragma: no cover
        raise NotImplementedError

    def support(self, d: Point) -> Point:  # pragma: no cover
        raise NotImplementedError

    def area(self) -> float:  # pragma: no cover
        raise NotImplementedError

    def clip_area(self, b: Box) -> float:  # pragma: no cover
        raise NotImplementedError

    def intersects_segment(self, a: Point, b: Point, radius: float = 0.0) -> bool:  # pragma: no cover
        raise NotImplementedError

    def rings(self) -> list[list[Point]]:  # pragma: no cover
        raise NotImplementedError

    def sdist_box(self, b: Box) -> float:
        """min over points p of the box of sdist(p): distance when disjoint, ≤ 0 when overlapping."""
        if not self.intersects_box(b):
            return self.dist_box(b)
        best = 0.0
        n = 6
        for i in range(n + 1):
            for j in range(n + 1):
                p = (b.x0 + b.w * i / n, b.y0 + b.h * j / n)
                v = self.sdist(p)
                if v < best:
                    best = v
        v = self.sdist(self.ref) if b.contains_point(self.ref) else 0.0
        return min(best, v)

    def support_inflated(self, d: Point, offset: float) -> Point:
        """Support point of S ⊕ disc(offset): support_S(d) + offset·d̂ (exact)."""
        s = self.support(d)
        u = _unit(d)
        return (s[0] + offset * u[0], s[1] + offset * u[1])

    def fits_box(self, w: float, h: float, pad: float) -> bool:
        """Can a w×h box grown by ``pad`` lie inside the shape (centered at its pole)?"""
        c = self.inner_center()
        b = Box(c[0] - w / 2 - pad, c[1] - h / 2 - pad, c[0] + w / 2 + pad, c[1] + h / 2 + pad)
        return self.contains_box(b)

    def inner_center(self) -> Point:
        return self.ref

    def contains_box(self, b: Box) -> bool:
        if not all(self.contains(p) for p in b.corners()):
            return False
        # every boundary edge must stay outside the box interior
        for ring in self.rings():
            n = len(ring)
            for i in range(n):
                if seg_box_intersects(ring[i], ring[(i + 1) % n], b.shrink(1e-7)):
                    return False
        return True


class Circle(Shape):
    kind = "circle"

    def __init__(self, cx: float, cy: float, r: float):
        self.cx, self.cy, self.r = float(cx), float(cy), max(0.0, float(r))
        self.ref = (self.cx, self.cy)

    def bbox(self) -> Box:
        return Box(self.cx - self.r, self.cy - self.r, self.cx + self.r, self.cy + self.r)

    def contains(self, p: Point) -> bool:
        return math.hypot(p[0] - self.cx, p[1] - self.cy) <= self.r

    def sdist(self, p: Point) -> float:
        return math.hypot(p[0] - self.cx, p[1] - self.cy) - self.r

    def intersects_box(self, b: Box) -> bool:
        if b.w <= 0 or b.h <= 0:
            return False
        return point_box_dist(self.ref, b) < self.r

    def dist_box(self, b: Box) -> float:
        return max(0.0, point_box_dist(self.ref, b) - self.r)

    def sdist_box(self, b: Box) -> float:
        return point_box_dist(self.ref, b) - self.r

    def support(self, d: Point) -> Point:
        u = _unit(d)
        return (self.cx + self.r * u[0], self.cy + self.r * u[1])

    def area(self) -> float:
        return math.pi * self.r * self.r

    def polygon(self, tol: float = FLATTEN_TOL) -> list[Point]:
        n = max(16, _arc_segments(self.r, 2 * math.pi, tol))
        return [(self.cx + self.r * math.cos(2 * math.pi * i / n), self.cy + self.r * math.sin(2 * math.pi * i / n))
                for i in range(n)]

    def rings(self) -> list[list[Point]]:
        return [self.polygon()]

    def clip_area(self, b: Box) -> float:
        if not self.intersects_box(b):
            return 0.0
        if b.contains_box(self.bbox()):
            return self.area()
        return abs(ring_area(clip_ring_to_box(self.polygon(0.005), b)))

    def intersects_segment(self, a: Point, b: Point, radius: float = 0.0) -> bool:
        return point_seg_dist(self.ref, a, b) < self.r + radius

    def fits_box(self, w: float, h: float, pad: float) -> bool:
        return math.hypot(w / 2 + pad, h / 2 + pad) <= self.r + 1e-9

    def contains_box(self, b: Box) -> bool:
        return all(self.contains(p) for p in b.corners())


class Polygon(Shape):
    """Polygon with holes (list of rings), fill rule nonzero or evenodd."""

    kind = "polygon"

    def __init__(self, rings: Sequence[Sequence[Point]], ref: Point | None = None, fill_rule: str = "nonzero",
                 holes: bool = True):
        """``holes=True``: rings[0] is the outer ring, the others are holes (polygon
        marks, area anchors). ``holes=False``: independent rings (path subpaths)."""
        rs = []
        for r in rings:
            pts = [(float(x), float(y)) for x, y in r]
            if len(pts) >= 2 and pts[0] == pts[-1]:
                pts = pts[:-1]
            if len(pts) >= 3:
                rs.append(pts)
        if not rs:
            raise ValueError("polygon without rings")
        if holes and fill_rule == "nonzero" and len(rs) > 1:
            # orient the outer ring positive and holes negative so nonzero winding cuts holes
            rs = [r if (ring_area(r) >= 0) == (k == 0) else r[::-1] for k, r in enumerate(rs)]
        self._rings = rs
        self.has_holes = holes and len(rs) > 1
        self.fill_rule = fill_rule
        xs = [p[0] for r in rs for p in r]
        ys = [p[1] for r in rs for p in r]
        self._bbox = Box(min(xs), min(ys), max(xs), max(ys))
        self.hull = convex_hull(rs[0] if len(rs) == 1 else [p for r in rs for p in r])
        self.ref = ref if ref is not None else self.centroid()
        self._pole: Point | None = None

    def rings(self) -> list[list[Point]]:
        return self._rings

    def bbox(self) -> Box:
        return self._bbox

    def centroid(self) -> Point:
        a = cx = cy = 0.0
        for r in self._rings:
            n = len(r)
            for i in range(n):
                x0, y0 = r[i]
                x1, y1 = r[(i + 1) % n]
                f = x0 * y1 - x1 * y0
                a += f
                cx += (x0 + x1) * f
                cy += (y0 + y1) * f
        if abs(a) < 1e-12:
            b = self._bbox
            return (b.cx, b.cy)
        return (cx / (3 * a), cy / (3 * a))

    # -- vectorized edge tests (numpy) ---------------------------------------
    def _E(self) -> np.ndarray:
        if getattr(self, "_edges", None) is None:
            rows = []
            for r in self._rings:
                n = len(r)
                for i in range(n):
                    (x0, y0), (x1, y1) = r[i], r[(i + 1) % n]
                    rows.append((x0, y0, x1, y1))
            E = np.array(rows, dtype=np.float64)
            self._edges = E
            self._emin = np.minimum(E[:, 0:2], E[:, 2:4])
            self._emax = np.maximum(E[:, 0:2], E[:, 2:4])
        return self._edges

    def _near(self, x0: float, y0: float, x1: float, y1: float) -> np.ndarray:
        """Indices of edges whose bounding boxes meet the closed rectangle."""
        self._E()
        m = ((self._emin[:, 0] <= x1) & (self._emax[:, 0] >= x0) & (self._emin[:, 1] <= y1)
             & (self._emax[:, 1] >= y0))
        return np.nonzero(m)[0]

    def contains(self, p: Point) -> bool:
        b = self._bbox
        if not (b.x0 <= p[0] <= b.x1 and b.y0 <= p[1] <= b.y1):
            return False
        E = self._E()
        ax, ay, bx, by = E[:, 0], E[:, 1], E[:, 2], E[:, 3]
        px, py = p
        if self.fill_rule == "evenodd":
            cond = (ay > py) != (by > py)
            den = np.where(cond, by - ay, 1.0)
            xi = ax + (py - ay) * (bx - ax) / den
            return int(np.count_nonzero(cond & (px < xi))) % 2 == 1
        cr = (bx - ax) * (py - ay) - (px - ax) * (by - ay)
        up = np.count_nonzero((ay <= py) & (by > py) & (cr > 0))
        dn = np.count_nonzero((ay > py) & (by <= py) & (cr < 0))
        return (up - dn) != 0

    def edges(self) -> Iterable[tuple[Point, Point]]:
        for r in self._rings:
            n = len(r)
            for i in range(n):
                yield r[i], r[(i + 1) % n]

    def boundary_dist(self, p: Point) -> float:
        E = self._E()
        ax, ay, bx, by = E[:, 0], E[:, 1], E[:, 2], E[:, 3]
        vx, vy = bx - ax, by - ay
        vv = vx * vx + vy * vy
        t = np.clip(((p[0] - ax) * vx + (p[1] - ay) * vy) / np.where(vv > 0, vv, 1.0), 0.0, 1.0)
        dx, dy = p[0] - (ax + t * vx), p[1] - (ay + t * vy)
        return float(np.sqrt((dx * dx + dy * dy).min()))

    def sdist(self, p: Point) -> float:
        d = self.boundary_dist(p)
        return -d if self.contains(p) else d

    def intersects_box(self, b: Box) -> bool:
        if b.w <= 0 or b.h <= 0:
            return False
        bb = self._bbox
        if not (bb.x0 < b.x1 and b.x0 < bb.x1 and bb.y0 < b.y1 and b.y0 < bb.y1):
            return False
        E = self._E()
        for i in self._near(b.x0, b.y0, b.x1, b.y1):
            e = E[i]
            if seg_box_intersects((e[0], e[1]), (e[2], e[3]), b):
                return True
        # no edge crosses the interior: box entirely inside or entirely outside
        return self.contains((b.cx, b.cy))

    def dist_box(self, b: Box) -> float:
        if self.intersects_box(b):
            return 0.0
        E = self._E()
        ax, ay, bx, by = E[:, 0], E[:, 1], E[:, 2], E[:, 3]
        best = np.inf
        for px, py in ((ax, ay), (bx, by)):  # segment endpoints to the box
            dx = np.maximum(np.maximum(b.x0 - px, 0.0), px - b.x1)
            dy = np.maximum(np.maximum(b.y0 - py, 0.0), py - b.y1)
            best = min(best, float(np.sqrt(dx * dx + dy * dy).min()))
        vx, vy = bx - ax, by - ay
        vv = np.where(vx * vx + vy * vy > 0, vx * vx + vy * vy, 1.0)
        for cx, cy in b.corners():  # box corners to the segments
            t = np.clip(((cx - ax) * vx + (cy - ay) * vy) / vv, 0.0, 1.0)
            dx, dy = cx - (ax + t * vx), cy - (ay + t * vy)
            best = min(best, float(np.sqrt(dx * dx + dy * dy).min()))
        return best

    def contains_box(self, b: Box) -> bool:
        if not all(self.contains(p) for p in b.corners()):
            return False
        sb = b.shrink(1e-7)
        E = self._E()
        for i in self._near(b.x0, b.y0, b.x1, b.y1):
            e = E[i]
            if seg_box_intersects((e[0], e[1]), (e[2], e[3]), sb):
                return False
        return True

    def support(self, d: Point) -> Point:
        u = _unit(d)
        vals = [p[0] * u[0] + p[1] * u[1] for p in self.hull]
        m = max(vals)
        ties = [p for p, v in zip(self.hull, vals) if v >= m - 1e-9]
        if len(ties) == 1:
            return ties[0]
        # flat side: the point of that side closest to the reference point's projection
        tx, ty = -u[1], u[0]
        ts = [p[0] * tx + p[1] * ty for p in ties]
        lo, hi = min(ts), max(ts)
        tr = self.ref[0] * tx + self.ref[1] * ty
        tc = min(max(tr, lo), hi)
        return (m * u[0] + tc * tx, m * u[1] + tc * ty)

    def area(self) -> float:
        if self.has_holes:
            outer = abs(ring_area(self._rings[0]))
            return max(0.0, outer - sum(abs(ring_area(r)) for r in self._rings[1:]))
        return sum(abs(ring_area(r)) for r in self._rings)

    def clip_area(self, b: Box) -> float:
        if not self.intersects_box(b):
            return 0.0
        bb = self._bbox
        if b.contains_box(bb):
            return self.area()
        if len(self._E()) > 400:
            # large outlines: unbiased point sampling at 1/8 px inside the box
            from .rasterize import Raster
            ras = Raster.for_box(b, 8.0)
            ras.polygon(self._rings, self.fill_rule)
            return ras.covered_area()
        parts = [abs(ring_area(clip_ring_to_box(r, b))) for r in self._rings]
        if self.has_holes:
            return max(0.0, parts[0] - sum(parts[1:]))
        return sum(parts)

    def intersects_segment(self, a: Point, b: Point, radius: float = 0.0) -> bool:
        if self.contains(a) or self.contains(b):
            return True
        E = self._E()
        r = max(radius, 0.0)
        for i in self._near(min(a[0], b[0]) - r, min(a[1], b[1]) - r, max(a[0], b[0]) + r, max(a[1], b[1]) + r):
            e = E[i]
            p, q = (e[0], e[1]), (e[2], e[3])
            if radius > 0:
                if seg_seg_dist(a, b, p, q) < radius:
                    return True
            elif segments_intersect(a, b, p, q):
                return True
        return False

    def inner_center(self) -> Point:
        if self._pole is None:
            self._pole = polylabel(self, 0.5)
        return self._pole


class Ellipse(Polygon):
    kind = "ellipse"

    def __init__(self, cx: float, cy: float, rx: float, ry: float, rotation: float = 0.0):
        self.cx, self.cy = float(cx), float(cy)
        self.rx, self.ry = max(0.0, float(rx)), max(0.0, float(ry))
        self.rotation = float(rotation or 0.0)
        self._cs = _rot(self.rotation)
        n = max(32, _arc_segments(max(self.rx, self.ry, 1e-6), 2 * math.pi))
        pts = []
        for i in range(n):
            t = 2 * math.pi * i / n
            q = _apply_rot((self.rx * math.cos(t), self.ry * math.sin(t)), self._cs)
            pts.append((self.cx + q[0], self.cy + q[1]))
        super().__init__([pts], ref=(self.cx, self.cy))

    def support(self, d: Point) -> Point:
        c, s = self._cs
        u = _unit(d)
        lx, ly = c * u[0] + s * u[1], -s * u[0] + c * u[1]  # rotate by -θ
        den = math.sqrt((self.rx * lx) ** 2 + (self.ry * ly) ** 2)
        if den == 0:
            return (self.cx, self.cy)
        px, py = self.rx * self.rx * lx / den, self.ry * self.ry * ly / den
        q = _apply_rot((px, py), self._cs)
        return (self.cx + q[0], self.cy + q[1])

    def area(self) -> float:
        return math.pi * self.rx * self.ry

    def inner_center(self) -> Point:
        return (self.cx, self.cy)

    def fits_box(self, w: float, h: float, pad: float) -> bool:
        c, s = self._cs
        for sx in (-1, 1):
            for sy in (-1, 1):
                x, y = sx * (w / 2 + pad), sy * (h / 2 + pad)
                lx, ly = c * x + s * y, -s * x + c * y
                if self.rx <= 0 or self.ry <= 0 or (lx / self.rx) ** 2 + (ly / self.ry) ** 2 > 1 + 1e-9:
                    return False
        return True


class RoundedRect(Polygon):
    kind = "rect"

    def __init__(self, cx: float, cy: float, w: float, h: float, corner_radius: float = 0.0,
                 rotation: float = 0.0, ref: Point | None = None):
        self.cx, self.cy = float(cx), float(cy)
        self.w, self.h = max(0.0, float(w)), max(0.0, float(h))
        self.cr = max(0.0, min(float(corner_radius or 0.0), self.w / 2, self.h / 2))
        self.rotation = float(rotation or 0.0)
        self._cs = _rot(self.rotation)
        hw, hh, cr = self.w / 2, self.h / 2, self.cr
        local: list[Point] = []
        if cr <= 0:
            local = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]
        else:
            n = _arc_segments(cr, math.pi / 2)
            for (ccx, ccy, a0) in ((hw - cr, -hh + cr, -90.0), (hw - cr, hh - cr, 0.0),
                                   (-hw + cr, hh - cr, 90.0), (-hw + cr, -hh + cr, 180.0)):
                for i in range(n + 1):
                    a = math.radians(a0 + 90.0 * i / n)
                    local.append((ccx + cr * math.cos(a), ccy + cr * math.sin(a)))
        pts = []
        for p in local:
            q = _apply_rot(p, self._cs)
            pts.append((self.cx + q[0], self.cy + q[1]))
        super().__init__([pts], ref=ref if ref is not None else (self.cx, self.cy))

    def support(self, d: Point) -> Point:
        c, s = self._cs
        u = _unit(d)
        lx, ly = c * u[0] + s * u[1], -s * u[0] + c * u[1]
        hw, hh, cr = self.w / 2 - self.cr, self.h / 2 - self.cr, self.cr
        # reference point in local coordinates
        rx, ry = self.ref[0] - self.cx, self.ref[1] - self.cy
        rlx, rly = c * rx + s * ry, -s * rx + c * ry
        if abs(lx) < 1e-9:
            px = min(max(rlx, -hw), hw)
        else:
            px = math.copysign(hw, lx)
        if abs(ly) < 1e-9:
            py = min(max(rly, -hh), hh)
        else:
            py = math.copysign(hh, ly)
        px += cr * lx
        py += cr * ly
        q = _apply_rot((px, py), self._cs)
        return (self.cx + q[0], self.cy + q[1])

    def area(self) -> float:
        return self.w * self.h - (4 - math.pi) * self.cr * self.cr

    def inner_center(self) -> Point:
        return (self.cx, self.cy)

    def fits_box(self, w: float, h: float, pad: float) -> bool:
        if abs(self.rotation) % 180 < 1e-9:
            hw, hh = w / 2 + pad, h / 2 + pad
            if hw > self.w / 2 + 1e-9 or hh > self.h / 2 + 1e-9:
                return False
            if self.cr <= 0:
                return True
            # corner of the box must be inside the rounded corner
            ex = max(0.0, hw - (self.w / 2 - self.cr))
            ey = max(0.0, hh - (self.h / 2 - self.cr))
            return ex * ex + ey * ey <= self.cr * self.cr + 1e-9
        return super().fits_box(w, h, pad)


# ---------------------------------------------------------------------------
# Pole of inaccessibility (polylabel, Mapbox algorithm)
# ---------------------------------------------------------------------------
def polylabel(poly: Polygon, precision: float = 0.5) -> Point:
    b = poly.bbox()
    w, h = b.w, b.h
    cell = min(w, h)
    if cell <= 0:
        return (b.x0, b.y0)
    half = cell / 2

    def cell_d(x, y):
        return -poly.sdist((x, y))

    heap: list[tuple[float, float, float, float, float]] = []
    x = b.x0
    while x < b.x1:
        y = b.y0
        while y < b.y1:
            cx, cy = x + half, y + half
            d = cell_d(cx, cy)
            heapq.heappush(heap, (-(d + half * math.sqrt(2)), cx, cy, half, d))
            y += cell
        x += cell
    c = poly.centroid()
    best = (cell_d(*c), c[0], c[1])
    bc = (b.cx, b.cy)
    dbc = cell_d(*bc)
    if dbc > best[0]:
        best = (dbc, bc[0], bc[1])
    iters = 0
    while heap and iters < 20000:
        iters += 1
        _, cx, cy, hh, d = heapq.heappop(heap)
        if d > best[0]:
            best = (d, cx, cy)
        if d + hh * math.sqrt(2) - best[0] <= precision:
            continue
        hh2 = hh / 2
        for sx in (-1, 1):
            for sy in (-1, 1):
                nx, ny = cx + sx * hh2, cy + sy * hh2
                nd = cell_d(nx, ny)
                heapq.heappush(heap, (-(nd + hh2 * math.sqrt(2)), nx, ny, hh2, nd))
    return (best[1], best[2])


# ---------------------------------------------------------------------------
# SVG path data flattening (subset sufficient for marks: M L H V C S Q T A Z)
# ---------------------------------------------------------------------------
_PATH_TOKEN = re.compile(r"[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


def _flatten_cubic(p0, p1, p2, p3, tol, out):
    # adaptive subdivision by control polygon flatness
    stack = [(p0, p1, p2, p3, 0)]
    while stack:
        a, b, c, d, depth = stack.pop()
        dd = max(point_seg_dist(b, a, d), point_seg_dist(c, a, d))
        if dd <= tol or depth > 16:
            out.append(d)
            continue
        ab = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        bc = ((b[0] + c[0]) / 2, (b[1] + c[1]) / 2)
        cd = ((c[0] + d[0]) / 2, (c[1] + d[1]) / 2)
        abc = ((ab[0] + bc[0]) / 2, (ab[1] + bc[1]) / 2)
        bcd = ((bc[0] + cd[0]) / 2, (bc[1] + cd[1]) / 2)
        m = ((abc[0] + bcd[0]) / 2, (abc[1] + bcd[1]) / 2)
        stack.append((m, bcd, cd, d, depth + 1))
        stack.append((a, ab, abc, m, depth + 1))


def _arc_to_points(p0, rx, ry, phi, large, sweep, p1, tol, out):
    # SVG implementation notes F.6.5
    if rx == 0 or ry == 0:
        out.append(p1)
        return
    rx, ry = abs(rx), abs(ry)
    c, s = math.cos(math.radians(phi)), math.sin(math.radians(phi))
    dx2, dy2 = (p0[0] - p1[0]) / 2, (p0[1] - p1[1]) / 2
    x1p, y1p = c * dx2 + s * dy2, -s * dx2 + c * dy2
    lam = (x1p / rx) ** 2 + (y1p / ry) ** 2
    if lam > 1:
        rx *= math.sqrt(lam)
        ry *= math.sqrt(lam)
    num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    co = math.sqrt(max(0.0, num / den)) if den else 0.0
    if large == sweep:
        co = -co
    cxp, cyp = co * rx * y1p / ry, -co * ry * x1p / rx
    cx = c * cxp - s * cyp + (p0[0] + p1[0]) / 2
    cy = s * cxp + c * cyp + (p0[1] + p1[1]) / 2

    def ang(ux, uy, vx, vy):
        a = math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        return a

    t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not sweep and dt > 0:
        dt -= 2 * math.pi
    elif sweep and dt < 0:
        dt += 2 * math.pi
    n = _arc_segments(max(rx, ry), abs(dt), tol)
    for i in range(1, n + 1):
        t = t1 + dt * i / n
        x, y = rx * math.cos(t), ry * math.sin(t)
        out.append((c * x - s * y + cx, s * x + c * y + cy))


def flatten_path(d: str, tol: float = 0.25) -> list[list[Point]]:
    """Flatten SVG path data into subpaths (lists of points)."""
    toks = _PATH_TOKEN.findall(d)
    i = 0
    subpaths: list[list[Point]] = []
    cur: list[Point] = []
    pos = (0.0, 0.0)
    start = (0.0, 0.0)
    cmd = None
    last_ctrl = None
    last_cmd = None

    def num():
        nonlocal i
        v = float(toks[i])
        i += 1
        return v

    while i < len(toks):
        t = toks[i]
        if re.match(r"[A-Za-z]", t):
            cmd = t
            i += 1
        elif cmd is None:
            raise ValueError("path data must start with a command")
        rel = cmd.islower()
        C = cmd.upper()
        if C == "Z":
            if cur:
                subpaths.append(cur)
            cur = []
            pos = start
            last_ctrl = None
            last_cmd = "Z"
            continue
        ox, oy = (pos if rel else (0.0, 0.0))
        if C == "M":
            x, y = num() + ox, num() + oy
            if cur:
                subpaths.append(cur)
            cur = [(x, y)]
            pos = start = (x, y)
            cmd = "l" if rel else "L"
            last_ctrl = None
        elif C == "L":
            x, y = num() + ox, num() + oy
            cur.append((x, y))
            pos = (x, y)
            last_ctrl = None
        elif C == "H":
            x = num() + (pos[0] if rel else 0.0)
            pos = (x, pos[1])
            cur.append(pos)
            last_ctrl = None
        elif C == "V":
            y = num() + (pos[1] if rel else 0.0)
            pos = (pos[0], y)
            cur.append(pos)
            last_ctrl = None
        elif C in "CS":
            if C == "C":
                c1 = (num() + ox, num() + oy)
            else:
                c1 = (2 * pos[0] - last_ctrl[0], 2 * pos[1] - last_ctrl[1]) if last_ctrl and last_cmd in "CS" else pos
            c2 = (num() + ox, num() + oy)
            p = (num() + ox, num() + oy)
            if not cur:
                cur = [pos]
            _flatten_cubic(pos, c1, c2, p, tol, cur)
            last_ctrl = c2
            pos = p
        elif C in "QT":
            if C == "Q":
                q = (num() + ox, num() + oy)
            else:
                q = (2 * pos[0] - last_ctrl[0], 2 * pos[1] - last_ctrl[1]) if last_ctrl and last_cmd in "QT" else pos
            p = (num() + ox, num() + oy)
            c1 = (pos[0] + 2 / 3 * (q[0] - pos[0]), pos[1] + 2 / 3 * (q[1] - pos[1]))
            c2 = (p[0] + 2 / 3 * (q[0] - p[0]), p[1] + 2 / 3 * (q[1] - p[1]))
            if not cur:
                cur = [pos]
            _flatten_cubic(pos, c1, c2, p, tol, cur)
            last_ctrl = q
            pos = p
        elif C == "A":
            rx, ry, phi = num(), num(), num()
            large, sweep = int(num()), int(num())
            p = (num() + ox, num() + oy)
            if not cur:
                cur = [pos]
            _arc_to_points(pos, rx, ry, phi, large, sweep, p, tol, cur)
            pos = p
            last_ctrl = None
        else:
            raise ValueError(f"unsupported path command {cmd}")
        last_cmd = C
    if cur:
        subpaths.append(cur)
    return [sp for sp in subpaths if len(sp) >= 2]


# ---------------------------------------------------------------------------
# Uniform-grid spatial index
# ---------------------------------------------------------------------------
class GridIndex:
    def __init__(self, cell: float = 32.0):
        self.cell = float(cell)
        self.buckets: dict[tuple[int, int], list[int]] = {}
        self.boxes: dict[int, Box] = {}

    def _range(self, b: Box):
        c = self.cell
        return (int(math.floor(b.x0 / c)), int(math.floor(b.x1 / c)),
                int(math.floor(b.y0 / c)), int(math.floor(b.y1 / c)))

    def insert(self, key: int, b: Box) -> None:
        self.boxes[key] = b
        i0, i1, j0, j1 = self._range(b)
        if (i1 - i0 + 1) * (j1 - j0 + 1) > 4096:  # huge object: coarse bucket
            self.buckets.setdefault(("big",), []).append(key)  # type: ignore[arg-type]
            return
        for i in range(i0, i1 + 1):
            for j in range(j0, j1 + 1):
                self.buckets.setdefault((i, j), []).append(key)

    def query(self, b: Box) -> list[int]:
        """Keys whose boxes meet ``b`` (closed test), in ascending key order."""
        i0, i1, j0, j1 = self._range(b)
        if (i1 - i0 + 1) * (j1 - j0 + 1) > 4096:
            cand: Iterable[int] = self.boxes.keys()
        else:
            out: set[int] = set(self.buckets.get(("big",), []))  # type: ignore[arg-type]
            for i in range(i0, i1 + 1):
                for j in range(j0, j1 + 1):
                    out.update(self.buckets.get((i, j), ()))
            cand = out
        res = []
        for k in cand:
            bb = self.boxes[k]
            if bb.x0 <= b.x1 and b.x0 <= bb.x1 and bb.y0 <= b.y1 and b.y0 <= bb.y1:
                res.append(k)
        return sorted(res)
