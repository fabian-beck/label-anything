"""Obstacle classes for the evaluator.

Geometry sources, in canvas px:

* the problem's ``obstacles.vector`` layers (exact primitives),
* ``truth.json`` classes (exact geometry of SVG / generated backgrounds),
* the problem's raster sources, converted per spec §4.6 at pixel resolution.

Hard tests against vector geometry are exact; raster classes "touch" a box iff
their integral over the box is > 0. Soft coverage (covered px² / label px²) of
vector classes is the union area inside the box: exact polygon clipping for a
single primitive, else unbiased point sampling at 1/8 px; raster classes add the
integral of their value maps.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from ..common import raster as rmod
from ..common.geom import Box, Circle, GridIndex, Point, Polygon, RoundedRect
from ..common.model import Primitive, Problem
from ..common.rasterize import Raster

DENSITY = 8.0  # samples per px along each axis for coverage of overlapping primitives
THIN = 3.0     # strokes up to this width count as thin
FEW = 6        # up to this many thin strokes in a box: length × width coverage, else union raster
DENSITY_LINES = 4.0


def clip_len(a: Point, c: Point, b: Box) -> float:
    """Length of the part of segment a–c inside box b (Liang–Barsky)."""
    t0, t1 = 0.0, 1.0
    dx, dy = c[0] - a[0], c[1] - a[1]
    for p, q in ((-dx, a[0] - b.x0), (dx, b.x1 - a[0]), (-dy, a[1] - b.y0), (dy, b.y1 - a[1])):
        if abs(p) < 1e-15:
            if q < 0:
                return 0.0
        else:
            r = q / p
            if p < 0:
                t0 = max(t0, r)
            else:
                t1 = min(t1, r)
    if t1 <= t0:
        return 0.0
    return (t1 - t0) * float(np.hypot(dx, dy))


def primitives_from_truth(entry: dict) -> list[Primitive]:
    prims: list[Primitive] = []
    for x, y, r in entry.get("circles", []):
        prims.append(Primitive("circle", Circle(x, y, r)))
    for x, y, w, h in entry.get("rects", []):
        prims.append(Primitive("rect", RoundedRect(x + w / 2, y + h / 2, w, h)))
    for pl in entry.get("polylines", []):
        pts = [tuple(p) for p in pl["points"]]
        if len(pts) >= 2:
            prims.append(Primitive("polyline", points=pts, width=float(pl.get("width", 1.0))))
    for pg in entry.get("polygons", []):
        rings = pg["rings"] if isinstance(pg, dict) else [pg]
        fr = pg.get("fill_rule", "nonzero") if isinstance(pg, dict) else "nonzero"
        try:
            prims.append(Primitive("polygon", Polygon([[tuple(p) for p in r] for r in rings], fill_rule=fr)))
        except ValueError:
            continue
    return prims


@dataclass
class ObstacleClass:
    name: str
    prims: list[Primitive] = field(default_factory=list)
    rasters: list[rmod.Integrator] = field(default_factory=list)
    _index: GridIndex | None = None

    def index(self) -> GridIndex:
        if self._index is None:
            idx = GridIndex(32.0)
            for k, p in enumerate(self.prims):
                idx.insert(k, p.bbox())
            self._index = idx
        return self._index

    def box_hits(self, b: Box) -> bool:
        """Does the (already tolerance-shrunk) box touch this class?"""
        if b.w <= 0 or b.h <= 0:
            return False
        if self.prims:
            for k in self.index().query(b):
                if self.prims[k].intersects_box(b):
                    return True
        for r in self.rasters:
            if r.integral(b.x0, b.y0, b.x1, b.y1) > 1e-9:
                return True
        return False

    def segment_hits(self, a: Point, c: Point, radius: float = 0.0) -> bool:
        if self.prims:
            q = Box(min(a[0], c[0]) - radius, min(a[1], c[1]) - radius,
                    max(a[0], c[0]) + radius, max(a[1], c[1]) + radius)
            for k in self.index().query(q):
                if self.prims[k].intersects_segment(a, c, radius):
                    return True
        for r in self.rasters:
            # sample the segment every 0.5 px; a 1×1 px probe must be ink-free
            n = max(1, int(np.hypot(c[0] - a[0], c[1] - a[1]) / 0.5))
            for i in range(n + 1):
                x = a[0] + (c[0] - a[0]) * i / n
                y = a[1] + (c[1] - a[1]) * i / n
                if r.integral(x - 0.25, y - 0.25, x + 0.25, y + 0.25) > 1e-9:
                    return True
        return False

    def vector_covered(self, b: Box) -> float:
        """Area of the union of this class's vector primitives inside the box (px²)."""
        if not self.prims or b.area <= 0:
            return 0.0
        hits = [self.prims[k] for k in self.index().query(b) if self.prims[k].intersects_box(b)]
        if not hits:
            return 0.0
        if len(hits) == 1 and hits[0].kind in ("circle", "polygon", "rect", "shape"):
            return hits[0].shape.clip_area(b)  # exact for a single primitive
        thin = all(p.kind == "polyline" and p.width <= THIN for p in hits)
        if thin and len(hits) <= FEW:
            # a few thin strokes: clipped centerline length × stroke width (crossings are rare)
            return sum(p.width * sum(clip_len(a, c, b) for a, c in zip(p.points, p.points[1:])) for p in hits)
        ras = Raster.for_box(b, DENSITY_LINES if thin else DENSITY)
        for p in hits:
            if p.kind == "polyline":
                ras.polyline(p.points, p.width)
            elif isinstance(p.shape, Circle):
                ras.disc(p.shape.cx, p.shape.cy, p.shape.r)
            else:
                ras.polygon(p.shape.rings(), getattr(p.shape, "fill_rule", "nonzero"))
        return ras.covered_area()

    def covered(self, b: Box) -> float:
        """Covered area of the box (px², union of vector primitives + raster values, capped)."""
        a = self.vector_covered(b)
        for r in self.rasters:
            a += r.integral(b.x0, b.y0, b.x1, b.y1)
        return min(a, b.area)


def build_classes(prob: Problem, truth: dict | None) -> dict[str, ObstacleClass]:
    classes: dict[str, ObstacleClass] = {}
    for cls, prims in prob.vectors.items():
        classes.setdefault(cls, ObstacleClass(cls)).prims.extend(prims)
    if truth:
        for cls, entry in (truth.get("classes") or {}).items():
            classes.setdefault(cls, ObstacleClass(cls)).prims.extend(primitives_from_truth(entry))
    obs = prob.raw.get("obstacles") or {}
    rasters = obs.get("raster")
    if rasters:
        rlist = rasters if isinstance(rasters, list) else [rasters]
        for src in rlist:
            maps = rmod.source_maps(src)
            scale = float(src.get("scale", 1))
            off = src.get("offset", [0, 0])
            for cls, vals in maps.items():
                integ = rmod.Integrator(vals.astype(np.float64), cell=1.0 / scale, origin=(off[0], off[1]))
                classes.setdefault(cls, ObstacleClass(cls)).rasters.append(integ)
    return classes
