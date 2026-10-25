# Regions

A problem may name the regions of its picture — the countries of a map, the bars of a
chart — and each label then keeps to its item's region or to open space: three cost terms
and one hard rule.

## Context
On a map a label reads as naming the region it lies in. In the Europe example of the home
page, countries' and capitals' names lay across borders or inside a neighbouring country,
and leaders ran across countries to their names; the example had hidden part of this with
abbreviated names and names left out by hand. Nothing in the engine could see the problem:
the countries of a background are `ignore`, as they must be for a name to lie on land, so
a label in its own country, across a border and inside a neighbour all cost the same.
Borders as a soft class of lines cost a label across a border as little as one across a
river; the countries as obstacles keep a name out of its own country too; the contrast term
(ADR obstacles/contrast) sees luma, and neighbouring countries are drawn in pastel colours
of similar luma.

## Decision
- **Sources.** SVG sources name regions by selector (`"regions": ".land path"`, or rules
  `{selector, region}`), vector layers by `region`. A fill belongs to the nearest element
  a rule matches; `region` is `"each"` (every element a region of its own, named by its
  `id`), `"open"` (open space, clearing what lies below), `"none"` or a name shared by all
  geometry of one region. The rest of the canvas is open space, where any label may lie.
- **The region map.** One region number per cell of the obstacle grid, painted fill by
  fill at the cells' centres with the rasterizer's scanline rule (later fills on top), and
  a summed-area table of the cells on a border: a box away from borders lies in one region
  in constant time; one across borders is split cell by cell, exact to the cell.
- **Home.** `item.region`, else the region under the item's reference point, else (a
  coastal city's dot in the sea) the region with most cells next to its mark.
- **Costs**, per em² of the box like coverage: `weights.straddle` (0.5) for a box across
  borders, `2 · (A² − Σ a_r²) / A`, the box's area when half in one region and half in
  another; `weights.foreign` (0.5) for its area in regions that are neither home nor open
  space; `weights.leader_borders` (1) per border a leader crosses, sampled once per cell.
- **One hard rule**, `placement.max_foreign` (0.25): a label that names a region by where
  it lies — an area item's label, internal ones aside, and any label on a leader — lies at
  most a quarter in other regions (hard class `regions`; the ladder does not relax it).
  Labels of points without leaders keep only the cost: a capital near a border has its
  name next to its dot, wherever that is.
- **Distant labels seek open space**: on a region map, free-space seeds (§4.7) treat region
  cells as occupied, so a name on a leader goes to the sea, not onto the next country.
- Painting, splitting and sampling are integer and fixed binary64 arithmetic, identical in
  Rust and TypeScript. The map is built only when a source has regions and a region weight
  is positive.

Measured on the Europe example (90 labels; from the drawn polygons, independently of the
engine's formulas; "in other countries": more than a quarter of the box):

| | placed | in other countries | leaders | borders crossed by leaders |
|---|---|---|---|---|
| no region map | 89 | 31 | 0 | 0 |
| costs only (`max_foreign` 1) | 88 | 11 | 8 | 10 |
| **costs and `max_foreign` 0.25** | 87 | 8 | 10 | 17 |
| `max_foreign` 0 | 83 | 8 | 7 | 9 |

With the defaults no country's name lies in another country; the eight labels counted are
capitals' names next to their dots, which the rule leaves to the cost.

## Consequences
Problems without regions are unchanged. On a map, small countries' names go out on leaders
to the nearest sea, and some of those leaders are long and cross a neighbour, which
`leader_borders` makes expensive but not impossible. A vector layer may have a `region`
without a `class`, adding no obstacles; a result warns about an `item.region` that no
region has (`unknown_region`). The benchmark's evaluator does not measure regions; its
scenarios have none.

## Alternatives
- **Costs alone**: strict priority places every item that has a feasible candidate,
  however expensive, so names that fit nowhere else stay in their neighbours (LUXEMBOURG
  wholly, KOSOVO by 69 %).
- **A hard rule for labels on leaders only**: names that find no place on a leader fall
  back to positions across borders.
- **No foreign share at all** (`max_foreign` 0): also leaves out SWITZERLAND, SLOVENIA,
  KOSOVO and LUXEMBOURG, whose names fit neither inside nor, on a leader, in the sea.
- **Clipping boxes against the region polygons**: exact, but its cost per candidate grows
  with the polygons' vertices.
- **Segmenting raster backgrounds by colour**: an SVG says which fill is which country; a
  raster needs thresholds for border lines, text and rivers, and merges neighbours of one
  colour. A raster mode producing the same region map is left open.
