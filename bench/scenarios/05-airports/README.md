# 05 — Airports on an SVG world map

**What.** The world's served airports (OpenFlights; 3,221 airports with at least one
route) labeled by IATA code (or by city name in the Europe view) over a world map rendered
here from Natural Earth country outlines. City names are the place's usual English name
(`airports.CITY_NAMES` corrects OpenFlights' "Milano" next to "Milan", "Minsk 2",
"Kerkyra/corfu", "Villafranca" for Verona, …). Priority = traffic (number of route records
touching the airport, log1p, min–max normalized); font classes: the top 5 % at
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
| `world-iata-1000-lower-vector` | top 1000; labels may cover the marks of less important airports (`avoid.label.lower_items` 10, leaders 2.5), whose labels then go | as `world-iata-1000-vector` |
| `world-iata-3000-svg` | top 3000 | SVG: countries (`areas`, ignored by `map`), graticule (`lines`), title + credit (`text`, hard), other airports (`points`) |
| `europe-names-400-svg` | 400 European airports, city names ("City (IATA)" when a city has several), 10 px | SVG Europe map, graticule every 10° |
| `europe-hubs-svg` | hubs first: the 30 busiest airports of the Europe view (`attrs.hub`, tier 1 by `priority.tiers`, 1.2 × by `font_classes`) and the next 70 (0.9 ×), city names, 10 px | the Europe map; the other 327 airports of the view are dots of class `points` (r 1.2, soft 0.3 / leaders 0.2) without labels |
| `world-hubs-100-svg` | hubs first on a world map at 6 px/degree (2160 × 852): the 30 busiest airports (tier 1, 1.2 ×) and the next 70, IATA, 8 px | SVG world map; the other 3,120 airports as `points` dots |

The hub maps answer "which airports must be labeled". By default a label keeps clear of every
item's mark, whatever its priority, so making all 1,000 airports items lets small airports' dots
block the hubs in dense regions (in `world-iata-1000-vector` ATL, ORD, LHR, CDG and FRA find no
position). `avoid.label.lower_items` lifts that: a label may cover the mark of a less important
item, which then stays unlabeled (spec §4.4, ADR 0040) — `world-iata-1000-lower-vector` labels
those hubs. The hub maps use it too (`lower_items` 10, leaders 2.5), and make only the airports
worth a label items; the others are context that a label may cover at a small cost. Their marks
are smaller: r = min(6, 1.8 + 0.1·sqrt(routes)).

**Rendering recipe.** Ocean `#d7e7f1` (class `background`, ignored), land `#ebe7df` with
0.6 px white borders, graticule `#c3d8e6` 0.5 px, title 14 px.
