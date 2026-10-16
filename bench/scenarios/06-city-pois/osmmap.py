"""Render an OSM-style raster map of Monaco and extract named POIs (scenario 06).

Tile servers are not reachable, so the "tiles" are rendered here from the
OpenStreetMap extract (© OpenStreetMap contributors, ODbL): Web Mercator,
zoom 16 (≈ 1.7 m/px), Pillow with 2× supersampling. Draw order: land, land use,
sea (flood-filled from a seed point inside the coastline-bounded water area),
water, buildings, roads (casing + fill by class), railways. No map text.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common import fetch, osmpbf  # noqa: E402
from bench.common.geo import WebMercator  # noqa: E402

SOURCES = ["osm-monaco"]
VIEW = WebMercator(lon=7.4225, lat=43.7365, zoom=16.0, width=1400.0, height=1000.0)
SEA_SEED_PX = (1392, 992)  # canvas px of a point in the Mediterranean (bottom-right corner)

LANDUSE = {
    ("landuse", "residential"): "#e0dfdf", ("landuse", "commercial"): "#f2dad9", ("landuse", "retail"): "#ffd6d1",
    ("landuse", "construction"): "#c7c7b4", ("landuse", "grass"): "#cdebb0", ("landuse", "forest"): "#add19e",
    ("landuse", "cemetery"): "#aacbaf", ("leisure", "park"): "#c8facc", ("leisure", "garden"): "#cdebb0",
    ("leisure", "pitch"): "#aae0cb", ("leisure", "stadium"): "#dffce2", ("leisure", "sports_centre"): "#dffce2",
    ("leisure", "playground"): "#dffce2", ("natural", "wood"): "#add19e", ("natural", "beach"): "#fff1ba",
    ("natural", "scrub"): "#c8d7ab", ("amenity", "hospital"): "#ffffe5", ("amenity", "school"): "#ffffe5",
    ("amenity", "parking"): "#eeeeee",
}
WATER = {("natural", "water"), ("leisure", "swimming_pool"), ("leisure", "marina"), ("amenity", "fountain")}
ROADS = {  # (casing, fill, width px at z16)
    "motorway": ("#c24e6b", "#e892a2", 7.0), "trunk": ("#c84e2f", "#f9b29c", 7.0),
    "primary": ("#a06b00", "#fcd6a4", 6.0), "primary_link": ("#a06b00", "#fcd6a4", 4.5),
    "secondary": ("#707d05", "#f7fabf", 5.5), "secondary_link": ("#707d05", "#f7fabf", 4.0),
    "tertiary": ("#8f8f8f", "#ffffff", 5.0), "residential": ("#b0b0b0", "#ffffff", 4.0),
    "unclassified": ("#b0b0b0", "#ffffff", 4.0), "living_street": ("#b0b0b0", "#ededed", 4.0),
    "service": ("#b0b0b0", "#ffffff", 2.5), "pedestrian": ("#a0a0a0", "#dddde8", 3.5),
}
PATHS = {"footway": "#fa8072", "steps": "#fa8072", "path": "#fa8072", "corridor": "#fa8072",
         "cycleway": "#0000ff", "track": "#996600"}

CATEGORIES = {  # category: (color, importance)
    "sights": ("#4e79a7", 5), "culture": ("#4e79a7", 4), "hotel": ("#76b7b2", 3), "food": ("#f28e2b", 2),
    "shop": ("#b07aa1", 1), "service": ("#e15759", 2), "leisure": ("#59a14f", 3), "artwork": ("#9c755f", 1),
}


def category(t: dict) -> str | None:
    am, to, sh, le, hi = t.get("amenity"), t.get("tourism"), t.get("shop"), t.get("leisure"), t.get("historic")
    if to in ("attraction", "viewpoint", "zoo", "aquarium") or am in ("casino",) or hi in ("castle", "monument"):
        return "sights"
    if to in ("museum", "gallery") or am in ("theatre", "cinema", "arts_centre", "library", "place_of_worship"):
        return "culture"
    if to in ("hotel", "hostel", "guest_house", "apartment"):
        return "hotel"
    if am in ("restaurant", "cafe", "bar", "pub", "fast_food", "ice_cream", "biergarten", "nightclub"):
        return "food"
    if sh:
        return "shop"
    if am in ("bank", "pharmacy", "post_office", "police", "hospital", "school", "townhall", "fuel", "courthouse",
              "embassy", "clinic", "doctors", "university", "college", "marketplace", "bus_station"):
        return "service"
    if le in ("park", "garden", "stadium", "sports_centre", "marina", "beach_resort") or to == "information" and False:
        return "leisure"
    if to == "artwork" or hi in ("memorial", "monument"):
        return "artwork"
    return None


def load():
    return osmpbf.read(str(fetch.ensure("osm-monaco", verbose=False)))


def _proj(d, refs, view):
    pts = []
    for r in refs:
        ll = d.nodes.get(r)
        if ll is not None:
            pts.append(view(*ll))
    return pts


def _rings_of_relation(d, members, view):
    """Assemble outer/inner rings of a multipolygon relation from member ways (by node ids)."""
    out = {"outer": [], "inner": []}
    for role in ("outer", "inner"):
        segs = [list(d.ways[m][0]) for t, m, r in members if t == "way" and (r or "outer") == role and m in d.ways]
        rings = []
        while segs:
            cur = segs.pop(0)
            changed = True
            while cur[0] != cur[-1] and changed:
                changed = False
                for k, s in enumerate(segs):
                    if s[0] == cur[-1]:
                        cur += s[1:]
                    elif s[-1] == cur[-1]:
                        cur += s[::-1][1:]
                    elif s[-1] == cur[0]:
                        cur = s + cur[1:]
                    elif s[0] == cur[0]:
                        cur = s[::-1] + cur[1:]
                    else:
                        continue
                    segs.pop(k)
                    changed = True
                    break
            if cur[0] == cur[-1] and len(cur) >= 4:
                rings.append(_proj(d, cur, view))
        out[role] = rings
    return out


def render(d, view=VIEW, supersample: int = 2) -> Image.Image:
    s = supersample
    W, H = int(view.width * s), int(view.height * s)
    img = Image.new("RGB", (W, H), "#f2efe9")
    dr = ImageDraw.Draw(img)

    def P(pts):
        return [(x * s, y * s) for x, y in pts]

    def poly(pts, fill, outline=None):
        if len(pts) >= 3:
            dr.polygon(P(pts), fill=fill, outline=outline)

    ways = sorted(d.ways.items())
    rels = sorted(d.relations.items())
    # land use / leisure areas (ways and multipolygons)
    for _wid, (refs, t) in ways:
        if refs and refs[0] == refs[-1]:
            for (k, v), col in LANDUSE.items():
                if t.get(k) == v:
                    poly(_proj(d, refs, view), col)
                    break
    for _rid, (members, t) in rels:
        if t.get("type") == "multipolygon":
            for (k, v), col in LANDUSE.items():
                if t.get(k) == v:
                    rr = _rings_of_relation(d, members, view)
                    for r in rr["outer"]:
                        poly(r, col)
                    for r in rr["inner"]:
                        poly(r, "#f2efe9")
                    break
    # sea: draw coastlines into a mask and flood fill from the sea seed
    mask = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(mask)
    for _wid, (refs, t) in ways:
        if t.get("natural") == "coastline":
            pts = P(_proj(d, refs, view))
            if len(pts) >= 2:
                md.line(pts, fill=255, width=max(2, 2 * s))
    sx, sy = SEA_SEED_PX
    ImageDraw.floodfill(mask, (int(sx * s), int(sy * s)), 128, thresh=0)
    sea = mask.point(lambda v: 255 if v in (128, 255) else 0)
    img.paste(Image.new("RGB", (W, H), "#aad3df"), (0, 0), sea)
    dr = ImageDraw.Draw(img)
    # inland water
    for _wid, (refs, t) in ways:
        if refs and refs[0] == refs[-1] and any(t.get(k) == v for k, v in WATER):
            poly(_proj(d, refs, view), "#aad3df")
    for _rid, (members, t) in rels:
        if t.get("type") == "multipolygon" and (t.get("leisure") == "marina" or t.get("natural") == "water"):
            for r in _rings_of_relation(d, members, view)["outer"]:
                poly(r, "#aad3df")
    # buildings
    for _wid, (refs, t) in ways:
        if "building" in t and refs and refs[0] == refs[-1]:
            poly(_proj(d, refs, view), "#d9d0c9", "#c4b6ab")
    for _rid, (members, t) in rels:
        if t.get("type") == "multipolygon" and "building" in t:
            rr = _rings_of_relation(d, members, view)
            for r in rr["outer"]:
                poly(r, "#d9d0c9", "#c4b6ab")
            for r in rr["inner"]:
                poly(r, "#f2efe9")
    # roads: casings first, then fills (minor to major)
    order = ["service", "living_street", "unclassified", "residential", "pedestrian", "tertiary",
             "secondary_link", "secondary", "primary_link", "primary", "trunk", "motorway"]
    road_ways = [(w, refs, t) for w, (refs, t) in ways if t.get("highway") in ROADS]
    road_ways.sort(key=lambda r: (order.index(r[2]["highway"]), r[0]))
    for _w, refs, t in road_ways:
        cas, _fill, wd = ROADS[t["highway"]]
        pts = P(_proj(d, refs, view))
        if len(pts) >= 2:
            dr.line(pts, fill=cas, width=int(round((wd + 1.5) * s)), joint="curve")
    for _w, refs, t in road_ways:
        _cas, fill, wd = ROADS[t["highway"]]
        pts = P(_proj(d, refs, view))
        if len(pts) >= 2:
            dr.line(pts, fill=fill, width=int(round(wd * s)), joint="curve")
    for _wid, (refs, t) in ways:
        col = PATHS.get(t.get("highway", ""))
        if col:
            pts = P(_proj(d, refs, view))
            if len(pts) >= 2:
                dr.line(pts, fill=col, width=max(1, int(round(1.0 * s))))
        if t.get("railway") == "rail":
            pts = P(_proj(d, refs, view))
            if len(pts) >= 2:
                dr.line(pts, fill="#707070", width=int(round(2.5 * s)))
                dr.line(pts, fill="#ffffff", width=max(1, int(round(1.0 * s))))
    if s > 1:
        img = img.resize((int(view.width), int(view.height)), Image.LANCZOS)
    return img


def pois(d, view=VIEW, margin: float = 12.0) -> list[dict]:
    """Named POIs inside the viewport: tagged nodes and the centroids of named POI areas."""
    out = []
    for nid, t in sorted(d.node_tags.items()):
        name = t.get("name")
        cat = category(t)
        if not name or not cat:
            continue
        x, y = view(*d.nodes[nid])
        out.append({"osm": f"n{nid}", "name": name, "cat": cat, "x": x, "y": y})
    for wid, (refs, t) in sorted(d.ways.items()):
        name = t.get("name")
        cat = category(t)
        if not name or not cat or not refs or refs[0] != refs[-1]:
            continue
        pts = _proj(d, refs[:-1], view)
        if len(pts) < 3:
            continue
        x = sum(p[0] for p in pts) / len(pts)
        y = sum(p[1] for p in pts) / len(pts)
        out.append({"osm": f"w{wid}", "name": name, "cat": cat, "x": x, "y": y})
    out = [p for p in out if margin <= p["x"] <= view.width - margin and margin <= p["y"] <= view.height - margin]
    out.sort(key=lambda p: (-CATEGORIES[p["cat"]][1], p["name"], p["osm"]))
    return out
