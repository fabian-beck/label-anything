"""Data access for scenario 05 (also used by scenarios 10, 11 and 12).

* OpenFlights ``airports.dat`` + ``routes.dat``: traffic = number of route
  records that start or end at the airport (all airlines, both directions),
* Natural Earth 1:50m admin-0 countries for the background map.
"""
from __future__ import annotations

import csv
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common import fetch  # noqa: E402
from bench.common.geo import Equirect, geojson_polygons, project_rings  # noqa: E402
from bench.common.geom import Box  # noqa: E402
from bench.common.scene import Scene  # noqa: E402

SOURCES = ["openflights-airports", "openflights-routes", "ne-50m-countries"]

CITY_NAMES = {
    "Algier": "Algiers", "Biarritz-bayonne": "Biarritz", "Cluj-napoca": "Cluj-Napoca", "Connaught": "Knock",
    "Doncaster, Sheffield": "Doncaster", "Duesseldorf": "Düsseldorf", "Gerona": "Girona", "Gothenborg": "Gothenburg",
    "Isle Of Man": "Isle of Man", "Kerkyra/corfu": "Corfu", "Kiev": "Kyiv", "La Coruna": "A Coruña",
    "Luxemburg": "Luxembourg", "Lvov": "Lviv", "Malmoe": "Malmö", "Milano": "Milan", "Minsk 2": "Minsk",
    "Munster": "Münster", "Nuernberg": "Nuremberg", "Rhodos": "Rhodes", "Ronchi De Legionari": "Trieste",
    "Saarbruecken": "Saarbrücken", "Sevilla": "Seville", "Tallinn-ulemiste International": "Tallinn",
    "Tanger": "Tangier", "Thira": "Santorini", "Torino": "Turin", "Vaxjo": "Växjö", "Villafranca": "Verona",
}
"""OpenFlights city names that are not the place's usual English name (airport names, transliterations,
two spellings of one city), as labels show them."""

REGIONS = {"Europe": "Europe", "America": "Americas", "Asia": "Asia", "Africa": "Africa",
           "Australia": "Oceania", "Pacific": "Oceania", "Atlantic": "Atlantic", "Indian": "Indian Ocean",
           "Antarctica": "Antarctica", "Arctic": "Europe"}


@dataclass(frozen=True)
class Airport:
    id: int
    name: str
    city: str
    country: str
    iata: str
    icao: str
    lat: float
    lon: float
    region: str
    routes: int

    @property
    def code(self) -> str:
        return self.iata or self.icao


def _null(s: str) -> str:
    return "" if s in ("\\N", "") else s


def load_airports(min_routes: int = 1) -> list[Airport]:
    """Airports with at least ``min_routes`` routes, sorted by traffic (desc), then id."""
    ap_path = fetch.ensure("openflights-airports", verbose=False)
    rt_path = fetch.ensure("openflights-routes", verbose=False)
    counts: dict[int, int] = {}
    with open(rt_path, encoding="utf-8", newline="") as f:
        for row in csv.reader(f):
            for col in (3, 5):
                v = row[col]
                if v.isdigit():
                    counts[int(v)] = counts.get(int(v), 0) + 1
    out = []
    with open(ap_path, encoding="utf-8", newline="") as f:
        for row in csv.reader(f):
            aid = int(row[0])
            n = counts.get(aid, 0)
            if n < min_routes:
                continue
            tz = _null(row[11])
            region = REGIONS.get(tz.split("/")[0], "Unknown") if tz else "Unknown"
            iata, icao = _null(row[4]), _null(row[5])
            if not (iata or icao):
                continue
            city = _null(row[2]) or row[1]
            out.append(Airport(aid, row[1], CITY_NAMES.get(city, city), row[3], iata, icao, float(row[6]),
                               float(row[7]), region, n))
    out.sort(key=lambda a: (-a.routes, a.id))
    return out


def load_countries() -> list[tuple[str, str, list]]:
    path = fetch.ensure("ne-50m-countries", verbose=False)
    with open(path, encoding="utf-8") as f:
        gj = json.load(f)
    out = []
    for feat in gj["features"]:
        p = feat["properties"]
        out.append((p["NAME"], p["CONTINENT"], geojson_polygons(feat["geometry"])))
    out.sort(key=lambda t: t[0])
    return out


WORLD = Equirect(-180.0, 180.0, 84.0, -58.0, 1800.0, 710.0)


def mark_radius(routes: int) -> float:
    return round(min(7.0, 1.2 + 0.3 * math.sqrt(routes)), 2)


def map_scene(proj, width: float, height: float, countries, *, title: str | None = None,
              graticule: float = 30.0, tol: float = 0.35, credit: bool = True) -> Scene:
    """Countries (class 'areas'), graticule ('lines'), title/credit text ('text'); ocean = ignored background."""
    sc = Scene(width, height, background="#d7e7f1")
    clip = Box(-2, -2, width + 2, height + 2)
    for name, _cont, polys in countries:
        for poly in polys:
            rings = project_rings(poly, proj, tol, clip=clip, min_area=0.8)
            if rings:
                sc.polygon(rings, "country", "areas", fill="#ebe7df", stroke="#ffffff", stroke_width=0.6)
    lon = -180.0
    while lon <= 180.0 + 1e-9:
        x, _ = proj(lon, 0.0)
        if 0 < x < width:  # equirectangular meridians are vertical lines
            sc.polyline([(x, 0.0), (x, height)], "graticule", "lines", stroke="#c3d8e6", width=0.5)
        lon += graticule
    lat = -90.0
    while lat <= 90.0 + 1e-9:
        x0, y = proj(-180.0, lat)
        x1, _ = proj(180.0, lat)
        if 0 <= y <= height:
            sc.polyline([(max(x0, 0.0), y), (min(x1, width), y)], "graticule", "lines", stroke="#c3d8e6",
                        width=0.5)
        lat += graticule
    if title:
        sc.text(12, 22, title, "title", "text", size=14, fill="#24425c")
    if credit:
        sc.text(width - 8, height - 8, "Data: OpenFlights (ODbL) · Natural Earth", "credit", "text", size=9,
                anchor="end", fill="#4d6577")
    return sc
