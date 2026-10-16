"""Build scenario 06: city POIs on a raster map (Monaco, OpenStreetMap).

The raster "tiles" are rendered locally from the OSM extract (osmmap.py) and
embedded as a PNG data URL (``obstacles.raster``). Named POIs (food, shops,
sights, culture, hotels, services, leisure, artworks) are labeled with
composite labels: a 9 px category icon + the name. Priority: category
importance (sights 5 … shops/artworks 1), ties by name.

Configs:
* ``monaco-ink`` (quick)  raster mode ``ink`` (soft 0.5 under preset ``map``), circle marks r = 3,
* ``monaco-saliency``     raster mode ``saliency`` (soft), same items,
* ``monaco-pins-ink``     POIs as map pins: ``icon`` marks with a pin silhouette, tip on the location.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.scenario import Writer, base_problem, data_url, png_bytes  # noqa: E402
from bench.scenarios import load_module  # noqa: E402

O = load_module("06", "osmmap")
SCENARIO = "06-city-pois"
PIN = {"shape": "icon", "w": 10, "h": 14, "tip": [5, 14],
       "silhouette": [[5, 14], [1.5, 8], [0, 4.5], [1.5, 1.3], [5, 0], [8.5, 1.3], [10, 4.5], [8.5, 8]]}


def items_for(pois, pins: bool) -> list[dict]:
    out = []
    seen: dict[str, int] = {}
    for p in pois:
        imp = O.CATEGORIES[p["cat"]][1]
        seen[p["name"]] = seen.get(p["name"], 0) + 1
        iid = p["osm"]
        mark = dict(PIN) if pins else {"shape": "circle", "r": 3.0}
        out.append({"id": iid,
                    "anchor": {"type": "point", "x": round(p["x"], 3), "y": round(p["y"], 3), "mark": mark},
                    "label": {"type": "composite", "direction": "row", "gap": 2, "padding": 1.5, "align": "center",
                              "parts": [{"type": "icon", "width": 9, "height": 9, "shape": "circle", "padding": 0},
                                        {"type": "text", "text": p["name"], "padding": 0}]},
                    "attrs": {"category": p["cat"], "importance": imp, "name": p["name"], "osm": p["osm"]}})
    return out


def problem(items, png: bytes, mode: str) -> dict:
    p = base_problem(O.VIEW.width, O.VIEW.height, "map", font_size=10.0)
    p["items"] = items
    p["priority"] = {"terms": [{"attr": "importance", "normalize": "none"}]}
    p["obstacles"] = {"raster": {"source": data_url(png), "mode": mode, "class": "ink"}}
    return p


def main() -> None:
    d = O.load()
    img = O.render(d)
    png = png_bytes(img, palette=True)
    pois = O.pois(d)
    wr = Writer(SCENARIO, "City POIs on a raster map", O.SOURCES,
                notes=f"Monaco, Web Mercator z16; {len(pois)} named POIs in the viewport.")
    wr.config("monaco-ink", problem(items_for(pois, False), png, "ink"), png=png, quick=True,
              description="Composite icon+name labels over a locally rendered OSM raster, raster mode ink.")
    wr.config("monaco-saliency", problem(items_for(pois, False), png, "saliency"), png=png,
              description="Same items, raster mode saliency (Sobel + local contrast).")
    wr.config("monaco-pins-ink", problem(items_for(pois, True), png, "ink"), png=png,
              description="POIs as pin icons (icon marks with silhouette, tip on the location), raster mode ink.")
    wr.finish()


if __name__ == "__main__":
    main()
