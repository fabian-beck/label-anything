"""A map: the countries and capitals of Europe.

The countries of Natural Earth (public domain; the playground's ``world.json``, with the
internationally recognized borders) in a Lambert azimuthal equal-area projection centred on
Europe, drawn as an SVG (``europe-map.svg``) with the seas named in it. The problem labels
the country of every capital as an area and every capital as a point, the countries first
(each group by population), and tells the engine nothing but what the map shows:

* the countries' paths are the **regions** of the map, the sea is open space: a label
  keeps inside one region — its own country, or the sea — and a leader crosses as few
  borders as it can (spec §4.8);
* a country's name goes inside the country, wrapped into two lines if need be, or out on
  a leader; a capital's name goes next to its dot (the `map` preset);
* a country's name is the larger the larger the country: its type size grows with the
  logarithm of the area, from 6 px (10,000 km² and less) to 18 px (1,000,000 km² and
  more); capitals' names are 9.5 px;
* the seas' names are hard obstacles for labels and leaders.

The names are Natural Earth's, written out and uppercase for countries; no name is
shortened by hand.
"""

from __future__ import annotations

import json
import math
from xml.sax.saxutils import escape

from common import FIGURES, HERE, PLAYGROUND_DATA, compose, f, report, solve, write_problem

NAME = "europe"
LON0, LAT0 = 10.0, 52.0  # the projection's centre
FRAME = (-1780.0, -2280.0, 2330.0, 1880.0)  # x0, y0, x1, y1 in km (y down)
W = 880
SCALE = W / (FRAME[2] - FRAME[0])  # px per km
H = round((FRAME[3] - FRAME[1]) * SCALE)
R_EARTH = 6371.0

SEA = "#d3e3f1"
LAND_OTHER = "#ebe7df"
PALETTE = ["#f1dfba", "#d8e6c3", "#f0cfc2", "#ddd4ea", "#cfe3e5"]
BORDER = "#8c8273"
COUNTRY_TEXT = "#6e5f4f"
CITY_TEXT = "#1f2328"
SEA_TEXT = "#5a7fa8"

# the seas' names, drawn in the map: (lines, lon, lat)
SEAS = [
    (["Atlantic", "Ocean"], -11.8, 48.6),
    (["Norwegian", "Sea"], 2.5, 67.0),
    (["North", "Sea"], 3.2, 56.2),
    (["Baltic", "Sea"], 19.6, 56.4),
    (["Mediterranean Sea"], 4.6, 38.2),
    (["Black Sea"], 34.2, 43.3),
]
# capitals: name, lon, lat, country
CAPITALS = [
    ("Reykjavík", -21.94, 64.15, "ISL"), ("Dublin", -6.26, 53.35, "IRL"), ("London", -0.13, 51.51, "GBR"),
    ("Lisbon", -9.14, 38.72, "PRT"), ("Madrid", -3.70, 40.42, "ESP"), ("Paris", 2.35, 48.86, "FRA"),
    ("Brussels", 4.35, 50.85, "BEL"), ("Amsterdam", 4.90, 52.37, "NLD"), ("Luxembourg", 6.13, 49.61, "LUX"),
    ("Bern", 7.45, 46.95, "CHE"), ("Rome", 12.50, 41.90, "ITA"), ("Valletta", 14.51, 35.90, "MLT"),
    ("Berlin", 13.40, 52.52, "DEU"), ("Copenhagen", 12.57, 55.68, "DNK"), ("Oslo", 10.75, 59.91, "NOR"),
    ("Stockholm", 18.07, 59.33, "SWE"), ("Helsinki", 24.94, 60.17, "FIN"), ("Tallinn", 24.75, 59.44, "EST"),
    ("Riga", 24.11, 56.95, "LVA"), ("Vilnius", 25.28, 54.69, "LTU"), ("Warsaw", 21.01, 52.23, "POL"),
    ("Prague", 14.42, 50.08, "CZE"), ("Vienna", 16.37, 48.21, "AUT"), ("Bratislava", 17.11, 48.15, "SVK"),
    ("Budapest", 19.04, 47.50, "HUN"), ("Ljubljana", 14.51, 46.06, "SVN"), ("Zagreb", 15.98, 45.81, "HRV"),
    ("Sarajevo", 18.41, 43.86, "BIH"), ("Belgrade", 20.46, 44.79, "SRB"), ("Podgorica", 19.26, 42.43, "MNE"),
    ("Pristina", 21.17, 42.66, "KOS"), ("Skopje", 21.43, 42.00, "MKD"), ("Tirana", 19.82, 41.33, "ALB"),
    ("Athens", 23.73, 37.98, "GRC"), ("Sofia", 23.32, 42.70, "BGR"), ("Bucharest", 26.10, 44.43, "ROU"),
    ("Chișinău", 28.86, 47.01, "MDA"), ("Kyiv", 30.52, 50.45, "UKR"), ("Minsk", 27.56, 53.90, "BLR"),
    ("Moscow", 37.62, 55.76, "RUS"), ("Ankara", 32.85, 39.93, "TUR"), ("Nicosia", 33.38, 35.17, "CYP"),
    ("Rabat", -6.84, 34.02, "MAR"), ("Algiers", 3.06, 36.75, "DZA"), ("Tunis", 10.18, 36.81, "TUN"),
    ("Tbilisi", 44.79, 41.72, "GEO"),
]


def project(lon: float, lat: float) -> tuple[float, float]:
    """Lambert azimuthal equal-area (sphere), in px of the map."""
    l, p, l0, p0 = map(math.radians, (lon, lat, LON0, LAT0))
    k = math.sqrt(2 / (1 + math.sin(p0) * math.sin(p) + math.cos(p0) * math.cos(p) * math.cos(l - l0)))
    x = R_EARTH * k * math.cos(p) * math.sin(l - l0)
    y = -R_EARTH * k * (math.cos(p0) * math.sin(p) - math.sin(p0) * math.cos(p) * math.cos(l - l0))
    return (x - FRAME[0]) * SCALE, (y - FRAME[1]) * SCALE


def clip(ring: list[tuple[float, float]], x0: float, y0: float, x1: float, y1: float) -> list[tuple[float, float]]:
    """A ring cut to a rectangle (Sutherland–Hodgman)."""
    def cut(pts, inside, cross):
        out = []
        for i, q in enumerate(pts):
            p = pts[i - 1]
            if inside(q):
                if not inside(p):
                    out.append(cross(p, q))
                out.append(q)
            elif inside(p):
                out.append(cross(p, q))
        return out

    def at_x(x):
        return lambda p, q: (x, p[1] + (q[1] - p[1]) * (x - p[0]) / (q[0] - p[0]))

    def at_y(y):
        return lambda p, q: (p[0] + (q[0] - p[0]) * (y - p[1]) / (q[1] - p[1]), y)

    pts = ring
    for inside, cross in ((lambda p: p[0] >= x0, at_x(x0)), (lambda p: p[0] <= x1, at_x(x1)),
                          (lambda p: p[1] >= y0, at_y(y0)), (lambda p: p[1] <= y1, at_y(y1))):
        pts = cut(pts, inside, cross) if pts else pts
    return pts


def area(ring) -> float:
    return abs(sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(ring, ring[1:] + ring[:1]))) / 2


def path(rings) -> str:
    return "".join("M" + "L".join(f"{f(x)} {f(y)}" for x, y in r) + "Z" for r in rings if len(r) >= 3)


def countries() -> list[dict]:
    data = json.loads((PLAYGROUND_DATA / "world.json").read_text(encoding="utf-8"))["countries"]
    out = []
    pad = 40
    for c in data:
        lons = [p[0] for part in c["parts"] for p in part[0]]
        lats = [p[1] for part in c["parts"] for p in part[0]]
        if max(lons) < -40 or min(lons) > 65 or max(lats) < 25 or min(lats) > 80:
            continue
        parts = []
        for part in c["parts"]:
            rings = [clip([project(*p) for p in ring], -pad, -pad, W + pad, H + pad) for ring in part]
            if rings and len(rings[0]) >= 3:
                parts.append(rings)
        if not parts:
            continue
        c["shapes"] = parts
        # the part that carries the label: the largest within the map
        inner = [[clip([project(*p) for p in ring], 3, 3, W - 3, H - 3) for ring in part] for part in c["parts"]]
        inner = [rs for rs in inner if rs and len(rs[0]) >= 3]
        c["main"] = max(inner, key=lambda rs: area(rs[0])) if inner else None
        out.append(c)
    return out


def colours(cs: list[dict]) -> dict[str, str]:
    """Neighbours in different colours (greedy, largest first): countries that share border points."""
    pts = {c["id"]: {(round(p[0], 2), round(p[1], 2)) for part in c["parts"] for p in part[0]} for c in cs}
    order = sorted((c for c in cs if c["continent"] == "Europe" or c["id"] in ("TUR", "CYP", "GEO")),
                   key=lambda c: -len(pts[c["id"]]))
    col: dict[str, str] = {}
    for c in order:
        used = {col[d] for d in col if len(pts[c["id"]] & pts[d]) >= 2}
        col[c["id"]] = next((p for p in PALETTE if p not in used), PALETTE[0])
    return col


def graticule() -> list[str]:
    lines = []
    for lon in range(-40, 70, 10):
        lines.append([project(lon, lat / 2) for lat in range(40, 166)])
    for lat in range(30, 90, 10):
        lines.append([project(lon / 2, lat) for lon in range(-90, 141)])
    return ["M" + "L".join(f"{f(x)} {f(y)}" for x, y in ln) for ln in lines]


def map_svg(cs: list[dict], col: dict[str, str]) -> str:
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
         f'<rect id="sea" width="{W}" height="{H}" fill="{SEA}"/>',
         '<path class="graticule" fill="none" stroke="#ffffff" stroke-opacity="0.6" stroke-width="0.6" d="'
         + "".join(graticule()) + '"/>',
         # water lining: a soft darker band along the coasts, under the land
         '<filter id="soft" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="2.2"/></filter>',
         '<g class="coast" fill="none" stroke="#a7c4de" stroke-width="6" stroke-linejoin="round" filter="url(#soft)">'
         + "".join(f'<path d="{"".join(path(rings) for rings in c["shapes"])}"/>' for c in cs) + "</g>",
         f'<g class="land" stroke="{BORDER}" stroke-width="0.45" stroke-linejoin="round">']
    for c in cs:
        d = "".join(path(rings) for rings in c["shapes"])
        o.append(f'<path id="{c["id"]}" fill="{col.get(c["id"], LAND_OTHER)}" fill-rule="evenodd" d="{d}"/>')
    o.append("</g>")
    o.append(f'<g class="seas" fill="{SEA_TEXT}" font-size="12.5" font-style="italic" text-anchor="middle">')
    for lines, lon, lat in SEAS:
        x, y = project(lon, lat)
        for i, line in enumerate(lines):
            o.append(f'<text x="{f(x)}" y="{f(y + (i - (len(lines) - 1) / 2) * 15 + 4)}">{escape(line)}</text>')
    o.append("</g>")
    o.append("</svg>")
    return "\n".join(o) + "\n"


def type_size(km2: float) -> float:
    """A country name's type size in px: 6 up to 10,000 km², 18 from 1,000,000 km², the
    logarithm of the area in between."""
    return round(min(18.0, max(6.0, 6.0 + 6.0 * math.log10(km2 / 10_000))), 2)


def problem(cs: list[dict]) -> dict:
    by_id = {c["id"]: c for c in cs}
    # the countries of the capitals, the most populous first
    states = {iso for *_, iso in CAPITALS}
    labeled = sorted((c for c in cs if c["main"] and c["id"] in states), key=lambda c: -(c["pop"] or 0))
    items = []
    for c in labeled:
        rings = [[[round(x, 1), round(y, 1)] for x, y in r] for r in c["main"]]
        items.append({
            "id": c["id"],
            "anchor": {"type": "area", "polygon": rings[0], **({"holes": rings[1:]} if len(rings) > 1 else {})},
            "label": {"type": "text", "text": c["name"].upper(), "font": {"size": type_size(c["area"])}},
            # countries before capitals, by population
            "tier": 1,
            "priority": c["pop"] or 0,
            # a country's name may go out on a leader (into the sea, where the regions want it)
            "placement": {"models": ["adjacent", "slider", "distant"]},
        })
    for name, lon, lat, iso in CAPITALS:
        x, y = project(lon, lat)
        if not (4 < x < W - 4 and 4 < y < H - 4):
            continue
        items.append({
            "id": f"capital-{iso}",
            "anchor": {"type": "point", "x": round(x, 1), "y": round(y, 1), "mark": {"shape": "circle", "r": 2.6}},
            "label": {"type": "text", "text": name, "font": {"size": 9.5}},
            "priority": (by_id[iso]["pop"] or 0) if iso in by_id else 0,
        })
    return {
        "version": "1",
        "preset": "map",
        "canvas": {"width": W, "height": H},
        "defaults": {"wrap": {"max_lines": 2}},
        "obstacles": {
            "svg": {
                "path": f"{NAME}-map.svg",
                # nothing in the picture is an obstacle but the seas' names; the countries
                # are the regions
                "classes": [{"selector": ".seas text", "class": "seas"}, {"selector": "*", "class": "ignore"}],
                "regions": ".land path",
            }
        },
        "items": items,
        "avoid": {"label": {"seas": "hard"}, "leader": {"seas": "hard"}},
    }


def make(cli: str) -> str:
    cs = countries()
    picture = map_svg(cs, colours(cs))
    (HERE / f"{NAME}-map.svg").write_text(picture, encoding="utf-8")
    prob = problem(cs)
    result = solve(cli, write_problem(NAME, prob))
    city = lambda p: p["id"].startswith("capital-")  # noqa: E731
    # every capital's dot, labeled or not
    dots = "".join(
        f'<circle cx="{f(it["anchor"]["x"])}" cy="{f(it["anchor"]["y"])}" r="2.6"/>'
        for it in prob["items"] if it["id"].startswith("capital-"))
    svg = compose(W, H, "The countries and capitals of Europe, labeled by Label Anything",
                  picture.split(">", 1)[1].rsplit("</svg>", 1)[0], result,
                  style=".labels text{stroke:#ffffff;stroke-opacity:0.75;stroke-width:2.4px;stroke-linejoin:round;"
                        "paint-order:stroke}.labels .country text{stroke:none}",
                  label_class=lambda p: "" if city(p) else "country",
                  label_color=lambda p: CITY_TEXT if city(p) else COUNTRY_TEXT,
                  leaders='fill="none" stroke="#5f5a52" stroke-width="0.7"',
                  extra=f'<g class="capitals" fill="#ffffff" stroke="{CITY_TEXT}" stroke-width="1.2">{dots}</g>')
    (FIGURES / f"{NAME}.svg").write_text(svg, encoding="utf-8")
    return report(NAME, result)
