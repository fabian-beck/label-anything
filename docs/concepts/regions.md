# Regions

A label reads as naming the region it lies in: a country's name inside that country, a
bar's value on that bar. **Regions** tell the engine which parts of the picture these are
— the countries of a map, the bars of a chart, the compartments of a diagram — so that it
keeps each label inside its own region or in **open space** (the sea, the plot's
background), and its leaders across few borders.

Regions are not obstacles: a label may lie anywhere in its own region, and the picture's
fills can stay `ignore`. (Not to be confused with `canvas.region`, the rectangle labels
must stay in.)

```json
{
  "obstacles": {
    "svg": {
      "path": "europe-map.svg",
      "classes": [{ "selector": ".seas text", "class": "seas" }, { "selector": "*", "class": "ignore" }],
      "regions": ".land path"
    }
  }
}
```

"Every country of the map (`<g class="land"><path id="FRA" …/>…</g>`) is a region; the
sea, which no rule matches, is open space." The [home page's map of
Europe](../index.md) is this problem: its countries' names stay at home or go out on a
leader into the sea.

## Where regions come from

* **SVG sources**: `regions` is a selector — every matching element is a region of its own,
  named by its `id` — or a list of rules `{selector, region}`, the first matching rule
  deciding. Only drawn fills count (not strokes, not text). A fill belongs to the nearest
  element, itself or an ancestor, that a rule matches, so `"g.country"` makes a country of
  all the paths in its group.
* **Vector layers**: `region` puts the layer's polygons, rects, circles and shapes on the
  region map. A layer with a `region` and no `class` adds no obstacles.

`region` says what the geometry is:

| `region` | |
|---|---|
| `"each"` (default of SVG rules) | every element (vector: every polygon, rect, circle, shape) is a region of its own |
| `"open"` | open space: clears the regions below it (a lake inside a country) |
| `"none"` | not a region (a rule that keeps later rules from matching) |
| any other name | that region: all geometry with the same name, in every source, is one region |

```json
{
  "obstacles": {
    "svg": {
      "path": "map.svg",
      "regions": [
        { "selector": ".lake", "region": "open" },
        { "selector": ".land path" }
      ]
    },
    "vector": [
      { "region": "island", "polygons": [[[600, 40], [700, 40], [700, 120], [600, 120]]] }
    ]
  }
}
```

Later sources lie on top of earlier ones: SVG sources first, then vector layers, in order.

## Home

Each item has a **home** region: the one named by `item.region`, else the region under its
reference point (a point's anchor, an area's pole); for a dot in open space — a coastal
city — the region with most cells next to its mark. A name no region has is a warning,
`unknown_region`.

## What regions change

| | | default |
|---|---|---|
| `weights.straddle` | a label across region borders, per em² of its box (the box's area when half in one region and half in another) | 0.5 |
| `weights.foreign` | a label's area in regions other than its home and open space, per em² | 0.5 |
| `weights.leader_borders` | each region border a leader crosses | 1.0 |
| `placement.max_foreign` | the largest share of a label that names a region by where it lies — an area item's label (internal ones aside), or any label on a leader — that may lie in other regions | 0.25 |

`max_foreign` is a hard rule: a country's name lies at home or in open space, at most a
quarter of it in other countries; with no such place it is smaller, on a leader into the
sea, or left out — the result's explanations then list `regions` among the hard classes
that rejected its candidates. Point labels without a leader keep only the cost: a capital
near a border has its name next to its dot, wherever that is. Set `max_foreign` to 1 to
leave everything to the weights.

Distant labels look for free space in open space too: on a region map, a name on a leader
goes to the sea rather than onto the next country.

The engine samples regions on the obstacle grid (`solver.grid_cell`, about ¼ em): exact to
the cell, and in constant time for a label away from borders. The definitions are in the
specification, [§4.8](../reference/spec.md); the reasons in
[ADR obstacles/regions](../adr/obstacles/regions.md).
