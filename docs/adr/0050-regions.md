# 0050 — Regions: a label stays in the region it names

* Status: accepted (spec §4.5, §4.8, §7, §8, §9.3; `obstacles.svg.regions`, `obstacles.vector[].region`,
  `items[].region`, `weights.straddle`, `weights.foreign`, `weights.leader_borders`,
  `placement.max_foreign`)
* Date: 2026-10-23

## Context
On a map, a label reads as naming the region it lies in. In the Europe example of the home
page the countries' names and their capitals' names often lay across borders or in a
neighbouring country, and leaders ran across countries to their names. The example hid
some of this with work done around the engine: abbreviated names for small countries,
names left out by hand.

Nothing in the engine could see the problem. The background's countries are `ignore`, as
they must be (a name has to lie on land), so a label in its own country, across a border
and in the neighbour's interior all cost the same. The other tools do not fit either:

* the borders as a soft class of lines cost a label across a border as little as one
  across a river, and keep no label out of a neighbour's interior;
* the countries as obstacles keep a name out of its own country as much as out of the
  others;
* the contrast term (ADR 0037) sees luma, and neighbouring countries are drawn in pastel
  colours of similar luma; it does not know which side is the label's.

What is missing is what the picture means: which parts belong together (a country, a bar,
a compartment of a diagram), which is each label's, and what lies between them (the sea,
the plot's background).

## Decision
* **Regions.** A problem may say which fills of its background are regions: SVG sources
  by selector (`"regions": ".land path"`, or rules `{selector, region}`), vector layers
  by `region`. A fill belongs to the nearest element a rule matches; `region` names it
  (`"each"`: every element is a region of its own, named by its `id`; `"open"`: open space
  that clears what lies below; `"none"`; or a name shared by all geometry of one region).
  The rest of the canvas is **open space**, where any label may lie.
* **The region map.** One region number per cell of the obstacle grid, painted fill by
  fill at the cells' centres with the rasterizer's scanline rule (later fills on top), and
  a summed-area table of the cells on a border. A box away from borders lies in one region
  (constant time); one across borders is split cell by cell, exactly up to the cell.
* **Home.** Each item has a home region: `item.region`, else the region under its
  reference point, else (a coastal city's dot in the sea) the region with most cells next
  to its mark, else open space.
* **Three costs** (per em² of the box, like coverage): `straddle` (0.5) for a box across
  borders — `2 · (A² − Σ a_r²) / A`, the box's area when it lies half in one region and half
  in another, nothing when in one; `foreign` (0.5) for its area in regions that are neither
  home nor open space; `leader_borders` (1 per border) for the borders a leader crosses,
  sampled once per cell along it.
* **One hard rule**, `placement.max_foreign` (0.25): a label that names a region by where
  it lies — an area item's label, internal ones aside, and any label on a leader — may lie
  at most a quarter in other regions. Its hard class is `regions`; the ladder does not
  relax it. Labels of points without leaders keep only the cost: a capital near a border
  has its name next to its dot, wherever that is.
* **Distant labels seek open space.** On a region map, the free space that seeds distant
  candidates (§4.7) treats region cells as occupied: a name on a leader goes to the sea,
  where the rule wants it, not onto the next country.
* **Exactness.** Painting, splitting and sampling are integer and fixed binary64
  arithmetic, identical in Rust and TypeScript (`conformance/svg/regions.json`, the
  `regions-*` place cases and their parity fixtures). The map is built only when a source
  has regions and a weight is positive: problems without regions are unchanged.

Considered and rejected:

* *Costs alone.* Strict priority places every item that has a feasible candidate, however
  expensive: the names that fit nowhere else stayed in their neighbours (LUXEMBOURG
  wholly, KOSOVO by 69 %).
* *A hard rule for labels on leaders only.* Names that found no place on a leader fell
  back to positions across borders.
* *No foreign share at all* (`max_foreign` 0). It also leaves out SWITZERLAND, SLOVENIA,
  KOSOVO and LUXEMBOURG, whose names fit neither inside nor, on a leader, in the sea
  without touching a neighbour.
* *Exact clipping of boxes against the region polygons.* Its cost per candidate grows
  with the polygons' vertices; the grid is constant-time away from borders and exact to
  the cell, as coverage is.
* *Segmenting raster backgrounds into regions by colour.* An SVG says exactly which fill
  is which country; a raster needs thresholds for border lines, text and rivers, and
  merges neighbours of one colour. A raster `regions` mode producing the same region map
  is left for a later decision.

Measured on the Europe example (90 labels: 45 countries, 45 capitals; Rust engine) from
the drawn country polygons, independently of the engine's formulas: "across" — less than
80 % of the box in any one region, the sea included; "in other countries" — more than a
quarter of the box in countries other than the item's:

| | placed | across | in other countries | leaders | borders crossed by leaders |
|---|---|---|---|---|---|
| no region map | 89 of 90 | 40 | 31 | 0 | 0 |
| region costs only (`max_foreign` 1) | 88 | 12 | 11 | 8 | 10 |
| **costs and `max_foreign` 0.25** | 87 | 11 | 8 | 10 | 17 |
| `max_foreign` 0 | 83 | 9 | 8 | 7 | 9 |

With the defaults, no country's name lies in another country; the eight labels counted
are capitals' names next to their dots (Luxembourg, Chișinău, Pristina, Skopje, …), which
the rule leaves to the cost. Left out: MONTENEGRO, Bratislava and Podgorica. Solve times
stay within the noise of the machine (40–80 ms for all four).

## Consequences
* The Europe example shows the engine as it is: full names, no abbreviations, nothing
  left out by hand. Small countries' names go out on leaders to the nearest sea; some of
  those leaders are long and cross a neighbour (LUXEMBOURG to the North Sea, NORTH
  MACEDONIA to the Ionian Sea), which `leader_borders` makes expensive but not impossible.
* A vector layer may have a `region` without a `class` (it adds no obstacles); the
  validator warns about an `item.region` that no region has (`unknown_region`).
* Charts and diagrams get the same: bars, sectors or compartments as regions keep their
  labels in or next to the right shape.
* The evaluator of the benchmark does not count region measures yet; its scenarios have
  no regions.
