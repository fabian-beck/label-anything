"""Unbiased point-sampling rasterizer for coverage measurements (evaluator).

A sample is set iff its center lies inside the primitive (discs, capsules of a
polyline's stroke width, polygons with nonzero / even-odd fill). Unlike PIL's
drawing functions there is no half-pixel outline bias, so covered areas
converge to the exact areas. The evaluator rasterizes per label box at 1/8 px
spacing (64 samples per px²), only the primitives that touch the box.
"""
from __future__ import annotations

import math

import numpy as np

from .geom import Box


class Raster:
    """Sample grid of ``nx × ny`` cells exactly covering ``extent``."""

    def __init__(self, extent: Box, nx: int, ny: int):
        self.ox, self.oy = extent.x0, extent.y0
        self.w, self.h = max(1, int(nx)), max(1, int(ny))
        self.sx = extent.w / self.w if extent.w > 0 else 1.0
        self.sy = extent.h / self.h if extent.h > 0 else 1.0
        self.mask = np.zeros((self.h, self.w), dtype=bool)

    @staticmethod
    def for_box(b: Box, density: float = 8.0) -> "Raster":
        return Raster(b, int(math.ceil(b.w * density)), int(math.ceil(b.h * density)))

    def cell_area(self) -> float:
        return self.sx * self.sy

    def covered_area(self) -> float:
        return float(self.mask.sum()) * self.cell_area()

    def _irange(self, a: float, b: float, origin: float, step: float, n: int) -> tuple[int, int]:
        lo = int(math.ceil((a - origin) / step - 0.5))
        hi = int(math.floor((b - origin) / step - 0.5))
        return max(lo, 0), min(hi, n - 1)

    def _centers(self, i0, i1, j0, j1):
        xs = self.ox + (np.arange(i0, i1 + 1) + 0.5) * self.sx
        ys = self.oy + (np.arange(j0, j1 + 1) + 0.5) * self.sy
        return xs, ys

    def disc(self, cx: float, cy: float, r: float) -> None:
        if r <= 0:
            return
        i0, i1 = self._irange(cx - r, cx + r, self.ox, self.sx, self.w)
        j0, j1 = self._irange(cy - r, cy + r, self.oy, self.sy, self.h)
        if i0 > i1 or j0 > j1:
            return
        xs, ys = self._centers(i0, i1, j0, j1)
        m = (xs[None, :] - cx) ** 2 + (ys[:, None] - cy) ** 2 <= r * r
        self.mask[j0:j1 + 1, i0:i1 + 1] |= m

    def capsule(self, a, b, r: float) -> None:
        if r <= 0:
            return
        i0, i1 = self._irange(min(a[0], b[0]) - r, max(a[0], b[0]) + r, self.ox, self.sx, self.w)
        j0, j1 = self._irange(min(a[1], b[1]) - r, max(a[1], b[1]) + r, self.oy, self.sy, self.h)
        if i0 > i1 or j0 > j1:
            return
        xs, ys = self._centers(i0, i1, j0, j1)
        X, Y = np.meshgrid(xs, ys)
        vx, vy = b[0] - a[0], b[1] - a[1]
        vv = vx * vx + vy * vy
        if vv <= 0:
            t = np.zeros_like(X)
        else:
            t = np.clip(((X - a[0]) * vx + (Y - a[1]) * vy) / vv, 0.0, 1.0)
        dx, dy = X - (a[0] + t * vx), Y - (a[1] + t * vy)
        self.mask[j0:j1 + 1, i0:i1 + 1] |= dx * dx + dy * dy <= r * r

    def polyline(self, pts, width: float) -> None:
        for k in range(len(pts) - 1):
            self.capsule(pts[k], pts[k + 1], width / 2)

    def polygon(self, rings, fill_rule: str = "nonzero") -> None:
        e = []
        for ring in rings:
            n = len(ring)
            for k in range(n):
                (x0, y0), (x1, y1) = ring[k], ring[(k + 1) % n]
                if y0 != y1:
                    e.append((x0, y0, x1, y1))
        if not e:
            return
        E = np.array(e, dtype=np.float64)
        x0, y0, x1, y1 = E[:, 0], E[:, 1], E[:, 2], E[:, 3]
        dirs = np.where(y1 > y0, 1, -1)
        ymin, ymax = np.minimum(y0, y1), np.maximum(y0, y1)
        slope = (x1 - x0) / (y1 - y0)
        j0, j1 = self._irange(float(ymin.min()), float(ymax.max()), self.oy, self.sy, self.h)
        # restrict to edges that can reach the grid rows
        ys_lo = self.oy + (j0 + 0.5) * self.sy
        ys_hi = self.oy + (j1 + 0.5) * self.sy
        keep = (ymax > ys_lo) & (ymin <= ys_hi)
        x0, y0, dirs, ymin, ymax, slope = x0[keep], y0[keep], dirs[keep], ymin[keep], ymax[keep], slope[keep]
        for j in range(j0, j1 + 1):
            y = self.oy + (j + 0.5) * self.sy
            act = (ymin <= y) & (ymax > y)
            if not act.any():
                continue
            xs = x0[act] + (y - y0[act]) * slope[act]
            ds = dirs[act]
            order = np.argsort(xs, kind="stable")
            xs, ds = xs[order], ds[order]
            if len(xs) < 2:
                continue
            if fill_rule == "evenodd":
                inside = (np.arange(len(xs) - 1) % 2) == 0
            else:
                inside = np.cumsum(ds)[:-1] != 0
            for k in np.nonzero(inside)[0]:
                i0, i1 = self._irange(xs[k], xs[k + 1], self.ox, self.sx, self.w)
                if i0 <= i1:
                    self.mask[j, i0:i1 + 1] = True
