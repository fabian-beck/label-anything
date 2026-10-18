"""Build scenario 05: airports on a world map (OpenFlights + Natural Earth).

Configs (canvas px, y down; equirectangular projection, 5 px/degree for the world):

* ``world-iata-300-none``   top 300 airports by routes, IATA labels, no background,
                            the other served airports as soft ``points`` (quick suite),
* ``world-iata-1000-vector`` top 1000, country outlines + graticule as ``lines`` vector layers,
* ``world-iata-3000-svg``   top 3000, SVG world map (countries = ``areas``, graticule =
                            ``lines``, title/credit = ``text``, other airports = ``points``),
* ``europe-names-400-svg``  Europe window at 30 px/degree, 400 airports labeled with city names,
* ``europe-hubs-svg``       hubs first: the same window, the 30 busiest airports a tier of their own
                            (set larger), the next 70 labeled where they leave the hubs room, every
                            other airport a soft ``points`` dot without a label (context),
* ``world-hubs-100-svg``    hubs first on a world map at 6 px/degree: the 100 busiest airports (IATA
                            codes, 8 px, the top 30 a tier of their own), all others as context dots.

Priority: traffic (number of routes, log1p, minmax). Preset ``map``.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.geo import Equirect, project_rings  # noqa: E402
from bench.common.geom import Box  # noqa: E402
from bench.common.scenario import (FONT_CLASSES_DENSE, Writer, base_problem, merge_avoid, png_bytes,  # noqa: E402
                                   svg_source)
from bench.common.scene import Scene  # noqa: E402
from bench.scenarios import load_module  # noqa: E402

A = load_module("05", "airports")
SCENARIO = "05-airports"
PRIORITY = {"terms": [{"attr": "routes", "transform": "log1p", "normalize": "minmax"}]}


def unique_ids(aps) -> dict[int, str]:
    seen: dict[str, int] = {}
    for a in aps:
        seen[a.code] = seen.get(a.code, 0) + 1
    return {a.id: (a.code if seen[a.code] == 1 else f"{a.code}-{a.id}") for a in aps}


def items_for(aps, proj, label_fn, ids) -> list[dict]:
    out = []
    for a in aps:
        x, y = proj(a.lon, a.lat)
        out.append({"id": ids[a.id],
                    "anchor": {"type": "point", "x": round(x, 3), "y": round(y, 3),
                               "mark": {"shape": "circle", "r": A.mark_radius(a.routes)}},
                    "label": {"type": "text", "text": label_fn(a)},
                    "attrs": {"routes": a.routes, "region": a.region, "country": a.country, "city": a.city,
                              "name": a.name}})
    return out


def in_window(a, proj, w, h, margin=2.0) -> bool:
    x, y = proj(a.lon, a.lat)
    return margin <= x <= w - margin and margin <= y <= h - margin


def outline_scene(proj, width, height, countries, tol=0.6) -> Scene:
    """Country outlines as unfilled polylines (class 'lines'), graticule as 'lines'."""
    sc = Scene(width, height, background=None)
    clip = Box(-2, -2, width + 2, height + 2)
    for _name, _cont, polys in countries:
        for poly in polys:
            for ring in project_rings(poly[:1], proj, tol, clip=clip, min_area=2.0):
                sc.polyline(ring + [ring[0]], "outline", "lines", stroke="#9aa6ad", width=0.6)
    for lon in range(-150, 180, 30):
        x, _ = proj(lon, 0)
        sc.polyline([(x, 0), (x, height)], "graticule", "lines", stroke="#c3d8e6", width=0.5)
    for lat in range(-30, 90, 30):
        _, y = proj(0, lat)
        if 0 <= y <= height:
            sc.polyline([(0, y), (width, y)], "graticule", "lines", stroke="#c3d8e6", width=0.5)
    return sc


def hub_radius(routes: int) -> float:
    """Marks of the hub maps: smaller than ``mark_radius``, so that neighbouring hubs stay apart."""
    return round(min(6.0, 1.8 + 0.1 * math.sqrt(routes)), 2)


def hubs_problem(proj, vis, n_hubs: int, n_items: int, label_fn, ids, font: float, title: str,
                 graticule: float, tol: float) -> tuple[dict, object]:
    """Hubs first: the ``n_hubs`` busiest airports of ``vis`` are a tier of their own (``attrs.hub``) and
    set 1.2 × larger, the next ones up to ``n_items`` are labeled where they leave the hubs room (0.9 ×),
    every other airport is a soft ``points`` dot without a label. ``n_hubs = 0``: no tier, one size."""
    sc = A.map_scene(proj, proj.width, proj.height, A.load_countries(), title=title, graticule=graticule, tol=tol)
    for a in vis[n_items:]:
        x, y = proj(a.lon, a.lat)
        sc.circle(x, y, 1.2, "airport", "points", fill="#8a8a8a")
    p = base_problem(proj.width, proj.height, "map", font_size=font)
    p["items"] = items_for(vis[:n_items], proj, label_fn, ids)
    for k, it in enumerate(p["items"]):
        it["anchor"]["mark"]["r"] = hub_radius(it["attrs"]["routes"])
        it["attrs"]["hub"] = k < n_hubs
    p["priority"] = dict(PRIORITY)
    if n_hubs:
        p["priority"].update(tiers=[{"where": "attrs.hub", "tier": 1}],
                             font_classes=[{"first": n_hubs, "scale": 1.2}, {"scale": 0.9}])
    merge_avoid(p, {"points": 0.3}, {"points": 0.2}, ignore_background=True)
    p["obstacles"] = {"svg": svg_source(sc)}
    return p, sc


def main() -> None:
    aps = [a for a in A.load_airports() if A.WORLD.lat1 + 0.5 <= a.lat <= A.WORLD.lat0 - 0.5]
    countries = A.load_countries()
    ids = unique_ids(aps)
    W, H = A.WORLD.width, A.WORLD.height
    wr = Writer(SCENARIO, "Airports on a world map", A.SOURCES,
                notes="OpenFlights airports with >= 1 route; traffic = route records touching the airport.")

    def world_problem(n, extra_obstacles=None):
        p = base_problem(W, H, "map", font_size=9.0)
        p["items"] = items_for(aps[:n], A.WORLD, lambda a: a.code, ids)
        p["priority"] = {**PRIORITY, "font_classes": FONT_CLASSES_DENSE}
        p["avoid"] = {"label": {"points": 0.3}, "leader": {"points": 0.2}}
        rest = [A.WORLD(a.lon, a.lat) for a in aps[n:]]
        layers = [{"class": "points", "points": [[round(x, 3), round(y, 3)] for x, y in rest], "r": 1.2}]
        p["obstacles"] = {"vector": layers + (extra_obstacles or [])}
        return p

    # 1. quick: top 300, no background
    wr.config("world-iata-300-none", world_problem(300), quick=True,
              description="Top 300 airports by routes, IATA codes, no background; other airports as soft points.")
    # 2. vector outlines
    osc = outline_scene(A.WORLD, W, H, countries)
    wr.config("world-iata-1000-vector", world_problem(1000, osc.vector_layers()),
              svg=osc.svg(), png=png_bytes(osc.png()),
              description="Top 1000 airports, country outlines and graticule as soft 'lines' vector layers.")
    # 3. SVG world map with 3000 anchors
    sc = A.map_scene(A.WORLD, W, H, countries, title="World airports by number of routes")
    for a in aps[3000:]:
        x, y = A.WORLD(a.lon, a.lat)
        sc.circle(x, y, 1.2, "airport", "points", fill="#8a8a8a")
    p = base_problem(W, H, "map", font_size=9.0)
    p["items"] = items_for(aps[:3000], A.WORLD, lambda a: a.code, ids)
    p["priority"] = {**PRIORITY, "font_classes": FONT_CLASSES_DENSE}
    merge_avoid(p, {"points": 0.3}, {"points": 0.2}, ignore_background=True)
    p["obstacles"] = {"svg": svg_source(sc)}
    wr.config("world-iata-3000-svg", p, truth=sc.truth(), svg=sc.svg(), png=png_bytes(sc.png()),
              description="Top 3000 airports on an SVG world map (countries, graticule, title, credit).")
    # 4. Europe with city names
    eu = Equirect(-12.0, 32.0, 61.0, 35.0, 1320.0, 780.0)
    eu_aps = [a for a in aps if in_window(a, eu, eu.width, eu.height)]
    cities: dict[str, int] = {}
    for a in eu_aps[:400]:
        cities[a.city] = cities.get(a.city, 0) + 1

    def city_label(a):
        return a.city if cities.get(a.city, 0) == 1 else f"{a.city} ({a.code})"

    sc = A.map_scene(eu, eu.width, eu.height, countries, title="European airports", graticule=10.0, tol=0.4)
    for a in eu_aps[400:]:
        x, y = eu(a.lon, a.lat)
        sc.circle(x, y, 1.2, "airport", "points", fill="#8a8a8a")
    p = base_problem(eu.width, eu.height, "map", font_size=10.0)
    p["items"] = items_for(eu_aps[:400], eu, city_label, ids)
    p["priority"] = {**PRIORITY, "font_classes": FONT_CLASSES_DENSE}
    merge_avoid(p, {"points": 0.3}, {"points": 0.2}, ignore_background=True)
    p["obstacles"] = {"svg": svg_source(sc)}
    wr.config("europe-names-400-svg", p, truth=sc.truth(), svg=sc.svg(), png=png_bytes(sc.png()),
              description="400 European airports labeled with city names on an SVG map (30 px/degree).")
    # 5. hubs first: Europe (city names) and the world (IATA codes)
    cities = {}
    for a in eu_aps[:100]:
        cities[a.city] = cities.get(a.city, 0) + 1
    p, sc = hubs_problem(eu, eu_aps, 30, 100, city_label, ids, 10.0, "Europe's busiest airports", 10.0, 0.4)
    wr.config("europe-hubs-svg", p, truth=sc.truth(), svg=sc.svg(), png=png_bytes(sc.png()),
              description="Hubs first: 30 hubs (tier 1, 1.2 ×), 70 more where they fit, other airports as dots.")
    world6 = Equirect(-180.0, 180.0, 84.0, -58.0, 2160.0, 852.0)
    vis = [a for a in aps if in_window(a, world6, world6.width, world6.height)]
    p, sc = hubs_problem(world6, vis, 30, 100, lambda a: a.code, ids, 8.0, "The world's busiest airports",
                         30.0, 0.35)
    wr.config("world-hubs-100-svg", p, truth=sc.truth(), svg=sc.svg(), png=png_bytes(sc.png()),
              description="Hubs first on a world map: the 100 busiest airports (top 30 a tier), others as dots.")
    wr.finish()


if __name__ == "__main__":
    main()
