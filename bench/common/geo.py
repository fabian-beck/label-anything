"""Map projections, line simplification and clipping for the map scenarios."""
from __future__ import annotations

import math
from dataclasses import dataclass

from .geom import Box, clip_ring_to_box, ring_area


@dataclass
class Equirect:
    """Equirectangular projection of a lon/lat window onto a canvas (y down)."""

    lon0: float
    lon1: float
    lat0: float  # top (north)
    lat1: float  # bottom (south)
    width: float
    height: float

    def __call__(self, lon: float, lat: float) -> tuple[float, float]:
        x = (lon - self.lon0) / (self.lon1 - self.lon0) * self.width
        y = (self.lat0 - lat) / (self.lat0 - self.lat1) * self.height
        return (x, y)

    @property
    def px_per_deg(self) -> float:
        return self.width / (self.lon1 - self.lon0)


@dataclass
class WebMercator:
    """Web Mercator at zoom ``z`` (256 px tiles), viewport centered at (lon, lat)."""

    lon: float
    lat: float
    zoom: float
    width: float
    height: float

    @staticmethod
    def world(lon: float, lat: float, zoom: float) -> tuple[float, float]:
        n = 256.0 * 2.0 ** zoom
        x = (lon + 180.0) / 360.0 * n
        s = math.sin(math.radians(lat))
        y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
        return x, y

    def __call__(self, lon: float, lat: float) -> tuple[float, float]:
        cx, cy = self.world(self.lon, self.lat, self.zoom)
        x, y = self.world(lon, lat, self.zoom)
        return (x - cx + self.width / 2, y - cy + self.height / 2)

    def meters_per_px(self) -> float:
        return 156543.03392 * math.cos(math.radians(self.lat)) / 2.0 ** self.zoom


def simplify(pts: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    """Douglas–Peucker (iterative); keeps the endpoints."""
    n = len(pts)
    if n <= 2 or tol <= 0:
        return list(pts)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    tol2 = tol * tol
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        dd = dx * dx + dy * dy
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if dd == 0:
                d2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / dd
                t = max(0.0, min(1.0, t))
                d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d2 > best:
                best, bi = d2, i
        if best > tol2:
            keep[bi] = True
            stack.append((a, bi))
            stack.append((bi, b))
    return [p for p, k in zip(pts, keep) if k]


def simplify_ring(ring: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    if len(ring) < 4:
        return list(ring)
    # split at the farthest point from the first vertex so closed rings simplify well
    x0, y0 = ring[0]
    far = max(range(len(ring)), key=lambda i: (ring[i][0] - x0) ** 2 + (ring[i][1] - y0) ** 2)
    a = simplify(ring[:far + 1], tol)
    b = simplify(ring[far:] + [ring[0]], tol)
    out = a[:-1] + b[:-1]
    return out


def project_rings(rings, proj, tol: float, clip: Box | None = None, min_area: float = 0.5):
    """Project lon/lat rings, simplify in px and clip to ``clip``; drops tiny rings."""
    out = []
    for r in rings:
        pr = [proj(lon, lat) for lon, lat in r]
        if pr and pr[0] == pr[-1]:
            pr = pr[:-1]
        pr = simplify_ring(pr, tol)
        if clip is not None:
            xs = [p[0] for p in pr]
            ys = [p[1] for p in pr]
            if max(xs) < clip.x0 or min(xs) > clip.x1 or max(ys) < clip.y0 or min(ys) > clip.y1:
                continue
            pr = clip_ring_to_box(pr, clip)
        if len(pr) >= 3 and abs(ring_area(pr)) >= min_area:
            out.append([(round(x, 2), round(y, 2)) for x, y in pr])
    return out


def geojson_polygons(geom: dict) -> list[list[list[tuple[float, float]]]]:
    """GeoJSON Polygon / MultiPolygon → list of polygons, each a list of rings (lon, lat)."""
    t = geom.get("type")
    if t == "Polygon":
        return [[[tuple(p[:2]) for p in r] for r in geom["coordinates"]]]
    if t == "MultiPolygon":
        return [[[tuple(p[:2]) for p in r] for r in poly] for poly in geom["coordinates"]]
    return []
