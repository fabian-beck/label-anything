# 05 — Airports on an SVG world map

**What.** The world's served airports (OpenFlights; 3,221 airports with at least one
route) labeled by IATA code (or by city name in the Europe view) over a world map rendered
here from Natural Earth country outlines. Priority = traffic (number of route records
touching the airport, log1p, min–max normalized); font classes: the top 5 % bold at
1.25 ×, the rest at 0.9 × (spec §9.4).

**Why.** Thousands of anchors with strongly clustered density (Europe, US east coast)
over a real SVG map: tests SVG background classification (`areas` ignored, `lines` soft,
`text` hard), priority-driven omission, and cartographic position order (preset `map`).

**Projection.** Equirectangular, 5 px per degree: lon −180…180 → x 0…1800, lat 84…−58 →
y 0…710 (Antarctica excluded). Europe view: lon −12…32, lat 61…35 at 30 px/degree on
1320 × 780. Outlines are simplified in pixel space (Douglas–Peucker, 0.35–0.6 px) and
clipped to the canvas; rings < 0.8 px² are dropped.

**Configs** (preset `map`, marks: circle r = min(7, 1.2 + 0.3·sqrt(routes))):

| config | labels | background |
|---|---|---|
| `world-iata-300-none` (quick) | top 300, IATA, 9 px | none; all other served airports as soft `points` (r 1.2, weight 0.3) |
| `world-iata-1000-vector` | top 1000 | country outlines + graticule as `lines` vector layers (soft 0.8) |
| `world-iata-3000-svg` | top 3000 | SVG: countries (`areas`, ignored by `map`), graticule (`lines`), title + credit (`text`, hard), other airports (`points`) |
| `europe-names-400-svg` | 400 European airports, city names ("City (IATA)" when a city has several), 10 px | SVG Europe map, graticule every 10° |

**Rendering recipe.** Ocean `#d7e7f1` (class `background`, ignored), land `#ebe7df` with
0.6 px white borders, graticule `#c3d8e6` 0.5 px, title 14 px bold.
