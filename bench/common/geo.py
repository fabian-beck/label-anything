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


def simplify_shared(rings: list[list[tuple[float, float]]], tol: float) -> list[list[tuple[float, float]]]:
    """Douglas–Peucker on many open rings at once, so that neighbours keep meeting.

    Simplified one by one, the two outlines of a border lose different vertices and no longer
    meet: they leave gaps and overlaps between the countries. Here a stretch that rings share
    (the same vertices, in either direction) is simplified once and both rings get the same
    result, as TopoJSON does. The rings are cut into arcs at their junctions, the vertices
    with more than two distinct neighbours (where a border meets the coast or a third
    country); a ring without a junction is simplified as a whole, the same for every ring
    with the same vertices (an enclave and the hole it fills). Returns the rings in their
    order and direction (one may start at another vertex); a ring may come back with fewer
    than three vertices.
    """
    Pt = tuple[float, float]
    rings = [[(p[0], p[1]) for p in r] for r in rings]
    rings = [r[:-1] if len(r) > 1 and r[0] == r[-1] else r for r in rings]
    near: dict[Pt, set[Pt]] = {}
    for r in rings:
        n = len(r)
        for i, p in enumerate(r):
            s = near.setdefault(p, set())
            s.add(r[i - 1])
            s.add(r[(i + 1) % n])
    junction = {p for p, s in near.items() if len(s) > 2}
    done: dict[tuple[Pt, ...], list[Pt]] = {}

    def arc(pts: list[Pt]) -> list[Pt]:
        fwd, rev = tuple(pts), tuple(reversed(pts))
        key = min(fwd, rev)
        if key not in done:
            done[key] = simplify(list(key), tol)
        return done[key] if key == fwd else done[key][::-1]

    out = []
    for r in rings:
        if len(r) < 4:
            out.append(list(r))
            continue
        cuts = [i for i, p in enumerate(r) if p in junction]
        if not cuts:
            # the same ring whatever vertex it starts at and whichever way it runs
            k = min(range(len(r)), key=lambda i: r[i])
            fwd = r[k:] + r[:k]
            rev = fwd[:1] + fwd[:0:-1]
            key = min(tuple(fwd), tuple(rev))
            if key not in done:
                done[key] = simplify_ring(list(key), tol)
            s = done[key]
            out.append(s if key == tuple(fwd) else s[:1] + s[:0:-1])
            continue
        ring = r[cuts[0]:] + r[:cuts[0]] + [r[cuts[0]]]
        idx = [i - cuts[0] for i in cuts] + [len(r)]
        res: list[Pt] = []
        for a, b in zip(idx, idx[1:]):
            res.extend(arc(ring[a:b + 1])[:-1])
        out.append(res)
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
