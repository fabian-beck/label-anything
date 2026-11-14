"""Derive data/world.json (the map and scatter scenes) from Natural Earth's countries.

    bench/.venv/bin/python ts/packages/playground/tools/make_world.py

Source: ``ne_50m_admin_0_countries.geojson`` (Natural Earth, public domain), the pinned and
checksummed file of the benchmark (bench/common/sources.py, fetched into bench/data/), with the
internationally recognized borders instead of Natural Earth's de facto ones (Crimea is part of
Ukraine, the Golan Heights of Syria, Northern Cyprus of Cyprus and Somaliland of Somalia; see
bench/common/borders.py). Each country keeps its names (written out: Natural Earth's short name,
or its English name where the short one abbreviates, "Bosnia and Herz."), its abbreviation,
population, GDP, Natural Earth's label point and label rank, its land area (computed from the full
outline) and its outline, simplified (Douglas–Peucker, 0.05°) with islands below 0.01 deg²
dropped unless they are all the country has.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))

from bench.common import borders  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "data" / "world.json"
TOLERANCE = 0.05
MIN_PART = 0.01
R_KM = 6371.0088


def simplify(points: list[list[float]], tol: float) -> list[list[float]]:
    """Douglas–Peucker on an open polyline (iterative)."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = points[i]
            d = abs(dy * (px - ax) - dx * (py - ay)) / norm if norm > 0 else math.hypot(px - ax, py - ay)
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [p for p, k in zip(points, keep) if k]


def simplify_ring(ring: list[list[float]], tol: float) -> list[list[float]]:
    pts = ring[:-1] if ring[0] == ring[-1] else ring
    if len(pts) < 4:
        return pts
    # split at the point farthest from the first so that both halves are open polylines
    far = max(range(len(pts)), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2)
    a = simplify(pts[: far + 1], tol)
    b = simplify(pts[far:] + [pts[0]], tol)
    return a[:-1] + b[:-1]


def planar_area(ring: list[list[float]]) -> float:
    s = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def spherical_area_km2(ring: list[list[float]]) -> float:
    """Area of a lon/lat ring on the sphere (Chamberlain & Duquette)."""
    s = 0.0
    for (l1, p1), (l2, p2) in zip(ring, ring[1:] + ring[:1]):
        s += math.radians(l2 - l1) * (2 + math.sin(math.radians(p1)) + math.sin(math.radians(p2)))
    return abs(s) * R_KM * R_KM / 2


def rounded(ring: list[list[float]]) -> list[list[float]]:
    out: list[list[float]] = []
    for x, y in ring:
        p = [round(x, 2), round(y, 2)]
        if not out or out[-1] != p:
            out.append(p)
    return out


def main() -> None:
    countries = []
    vertices = 0
    for f in borders.countries():
        pr = f["properties"]
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        area = sum(spherical_area_km2(p[0]) - sum(spherical_area_km2(h) for h in p[1:]) for p in polys)
        parts = []
        for poly in polys:
            rings = [rounded(simplify_ring(r, TOLERANCE)) for r in poly]
            rings = [r for r in rings if len(r) >= 3]
            if not rings:
                continue
            parts.append((planar_area(rings[0]), rings))
        if not parts:
            # too small to simplify (Monaco, Nauru, ...): the largest outline as it is
            ring = max((p[0] for p in polys), key=lambda r: planar_area(r[:-1]))
            fine = [[round(x, 3), round(y, 3)] for x, y in ring[:-1]]
            parts = [(planar_area(fine), [fine])]
        parts.sort(key=lambda t: -t[0])
        kept = [rings for a, rings in parts if a >= MIN_PART] or [parts[0][1]]
        vertices += sum(len(r) for rings in kept for r in rings)
        name = pr["NAME"] if "." not in pr["NAME"] else pr["NAME_EN"]
        abbrev = pr.get("ABBREV") or name
        countries.append({
            "id": pr["ADM0_A3"],
            "name": name,
            "abbrev": abbrev if abbrev != name else None,
            "continent": pr["CONTINENT"],
            "region": pr["SUBREGION"],
            "pop": pr["POP_EST"],
            "gdp": pr["GDP_MD"],
            "area": round(area),
            "rank": pr["LABELRANK"],
            "label": [round(pr["LABEL_X"], 3), round(pr["LABEL_Y"], 3)],
            "parts": kept,
        })
    countries.sort(key=lambda c: c["id"])
    out = {
        "source": "Natural Earth 1:50m admin 0 countries (public domain), naturalearthdata.com; "
                  "internationally recognized borders; simplified",
        "countries": countries,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"{OUT}: {len(countries)} countries, {vertices} vertices, {OUT.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
