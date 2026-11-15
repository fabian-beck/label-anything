"""Natural Earth's countries with the internationally recognized borders.

Natural Earth's default edition draws de facto borders: Crimea as part of Russia, the Golan
Heights as part of Israel, Northern Cyprus and Somaliland as countries of their own. The maps
of this project draw the borders the United Nations recognize instead, as Natural Earth's own
point-of-view editions do: an occupied area goes back to the country it belongs to and a
breakaway unit merges into its country, which keeps its own record (names, figures, label point).
The outlines of the moved areas come from Natural Earth's breakaway and disputed areas.

Kosovo stays a country of its own (recognized by more than a hundred UN members, Germany among
them); Western Sahara stays a territory of its own (a non-self-governing territory for the UN).
"""
from __future__ import annotations

import json
import math

from . import fetch

MERGE = {
    "CYN": "CYP",  # Northern Cyprus is part of Cyprus (UN Security Council resolution 541)
    "SOL": "SOM",  # Somaliland is part of Somalia
}
"""Breakaway units (``ADM0_A3``) merged into the country they belong to."""

MOVE = [
    ("Crimea", "RUS", "UKR"),  # part of Ukraine (UN General Assembly resolution 68/262)
    ("Golan Heights", "ISR", "SYR"),  # part of Syria (UN Security Council resolution 497)
]
"""Areas (``BRK_NAME`` in the breakaway layer) moved from a country to the one they belong to."""

SNAP = 0.003
"""Degrees: the two layers' vertices of one border differ by up to this much."""

SLIVER = 1e-4
"""Square degrees: rings this small left over where the two layers' borders differ are dropped."""

Pt = tuple[float, float]
Ring = list[Pt]  # open: the first vertex is not repeated
Polygon = list[Ring]  # outer ring (clockwise), then holes (counter-clockwise)


def _signed_area(ring: Ring) -> float:
    """Shoelace area in lon/lat, positive for counter-clockwise rings."""
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1])) / 2


def _polygons(geometry: dict) -> list[Polygon]:
    polys = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
    out = []
    for poly in polys:
        rings = []
        for k, r in enumerate(poly):
            ring = [(p[0], p[1]) for p in (r[:-1] if r[0] == r[-1] else r)]
            if (_signed_area(ring) > 0) == (k == 0):  # outer rings clockwise, holes counter-clockwise
                ring = ring[:1] + ring[:0:-1]
            rings.append(ring)
        out.append(rings)
    return out


def _geometry(polys: list[Polygon]) -> dict:
    return {"type": "MultiPolygon",
            "coordinates": [[[list(p) for p in ring + ring[:1]] for ring in poly] for poly in polys]}


def _snap(poly: Polygon, polys: list[Polygon]) -> Polygon:
    """``poly`` with every vertex moved onto the nearest vertex of ``polys`` within SNAP."""
    near: dict[tuple[int, int], list[Pt]] = {}
    for p in (p for q in polys for ring in q for p in ring):
        near.setdefault((math.floor(p[0] / SNAP), math.floor(p[1] / SNAP)), []).append(p)

    def snap(p: Pt) -> Pt:
        cx, cy = math.floor(p[0] / SNAP), math.floor(p[1] / SNAP)
        best, d = p, SNAP
        for i in (cx - 1, cx, cx + 1):
            for j in (cy - 1, cy, cy + 1):
                for q in near.get((i, j), ()):
                    if math.dist(p, q) <= d:
                        best, d = q, math.dist(p, q)
        return best

    out = []
    for ring in poly:
        r: Ring = []
        for p in map(snap, ring):
            if not r or r[-1] != p:
                r.append(p)
        out.append(r[:-1] if len(r) > 1 and r[0] == r[-1] else r)
    return out


def _edges(poly: Polygon, reverse: bool = False) -> list[tuple[Pt, Pt]]:
    out = []
    for ring in poly:
        out.extend((b, a) if reverse else (a, b) for a, b in zip(ring, ring[1:] + ring[:1]))
    return out


def _inside(p: Pt, ring: Ring) -> bool:
    x, y = p
    c = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            c = not c
    return c


def _dissolve(edges: list[tuple[Pt, Pt]]) -> list[Polygon]:
    """The polygons bounded by ``edges`` once every edge run both ways has cancelled out.

    Polygons that share a border list its edges in opposite directions, so the edges of two
    neighbours dissolve into their union and those of a polygon plus the reversed ones of a
    part of it into the difference.
    """
    count: dict[tuple[Pt, Pt], int] = {}
    for e in edges:
        count[e] = count.get(e, 0) + 1
    for (a, b), n in list(count.items()):
        m = min(n, count.get((b, a), 0))
        if m:
            count[(a, b)] -= m
            count[(b, a)] -= m
    left = []
    for e in edges:
        if count[e] > 0:
            count[e] -= 1
            left.append(e)
    outgoing: dict[Pt, list[int]] = {}
    for k, (a, _) in enumerate(left):
        outgoing.setdefault(a, []).append(k)
    used = [False] * len(left)
    rings: list[Ring] = []
    for k in range(len(left)):
        if used[k]:
            continue
        ring = []
        while not used[k]:
            used[k] = True
            a, b = left[k]
            ring.append(a)
            nxt = [j for j in outgoing.get(b, []) if not used[j]]
            if not nxt:
                if b != ring[0]:
                    raise ValueError(f"open ring at {b}")
                break
            k = nxt[0]
        if abs(_signed_area(ring)) >= SLIVER:
            rings.append(ring)
    outer = [r for r in rings if _signed_area(r) < 0]
    polys: list[Polygon] = [[r] for r in outer]
    for hole in (r for r in rings if _signed_area(r) > 0):
        around = [k for k, r in enumerate(outer) if _inside(hole[0], r)]
        if not around:
            raise ValueError("a hole outside every outer ring")
        polys[min(around, key=lambda k: -_signed_area(outer[k]))].append(hole)
    return polys


def _shares(poly: Polygon, edges: set[tuple[Pt, Pt]]) -> bool:
    return any(e in edges for e in _edges(poly))


def _add(polys: list[Polygon], area: Polygon) -> list[Polygon]:
    """The union of ``polys`` and ``area``: the polygons along its border dissolve with it."""
    area = _snap(area, polys)
    back = set(_edges(area, reverse=True))
    touching = [p for p in polys if _shares(p, back)]
    edges = [e for p in touching for e in _edges(p)] + _edges(area)
    return [p for p in polys if not any(p is t for t in touching)] + _dissolve(edges)


def _remove(polys: list[Polygon], area: Polygon) -> list[Polygon]:
    """``polys`` without ``area``, a part of them."""
    area = _snap(area, polys)
    along = set(_edges(area))
    within = [p for p in polys if _shares(p, along)]
    if not within:
        raise ValueError("the area does not lie along the country's border")
    edges = [e for p in within for e in _edges(p)] + _edges(area, reverse=True)
    return [p for p in polys if not any(p is w for w in within)] + _dissolve(edges)


def _area(polys: list[Polygon]) -> float:
    return -sum(_signed_area(r) for poly in polys for r in poly)


def countries() -> list[dict]:
    """The features of Natural Earth's 1:50m admin-0 countries with the recognized borders.

    Geometries become MultiPolygons (outer rings clockwise); every other property is Natural
    Earth's own.
    """
    data = json.loads(fetch.ensure("ne-50m-countries", verbose=False).read_text(encoding="utf-8"))
    disputed = json.loads(fetch.ensure("ne-50m-disputed", verbose=False).read_text(encoding="utf-8"))
    features = data["features"]
    by_id = {f["properties"]["ADM0_A3"]: f for f in features}
    shapes = {k: _polygons(f["geometry"]) for k, f in by_id.items()}
    areas = {f["properties"]["BRK_NAME"]: _polygons(f["geometry"]) for f in disputed["features"]}
    for name, src, dst in MOVE:
        for area in areas[name]:
            size = _area([area])
            before = _area(shapes[src]), _area(shapes[dst])
            shapes[src] = _remove(shapes[src], area)
            shapes[dst] = _add(shapes[dst], area)
            after = _area(shapes[src]), _area(shapes[dst])
            if abs(before[0] - size - after[0]) > 0.01 * size or abs(before[1] + size - after[1]) > 0.01 * size:
                raise ValueError(f"moving {name} from {src} to {dst} does not add up")
    for unit, dst in MERGE.items():
        size = _area(shapes[unit]) + _area(shapes[dst])
        for area in shapes.pop(unit):
            shapes[dst] = _add(shapes[dst], area)
        if abs(_area(shapes[dst]) - size) > 1e-6 * size:
            raise ValueError(f"merging {unit} into {dst} does not add up")
    out = []
    for f in features:
        key = f["properties"]["ADM0_A3"]
        if key in shapes:
            out.append({**f, "geometry": _geometry(shapes[key])})
    return out
