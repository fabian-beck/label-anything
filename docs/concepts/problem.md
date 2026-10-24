# The problem format

A problem is one JSON object (`problem.v1`, schema
[`problem.v1.json`](../reference/schemas.md)). Only `items` is required; every option has
a [default](../reference/defaults.md), and a [preset](presets-defaults.md) sets several at
once. The bindings build the same object from Python keywords, the Java builder or plain
JavaScript objects.

| Key | What it holds |
|---|---|
| `version` | `"1"` (optional) |
| [`canvas`](#canvas) | size, padding, label region; optional |
| [`y_axis`, `transform`](#coordinates) | how input coordinates map to canvas pixels |
| [`preset`](presets-defaults.md) | `auto` (default), `scatter`, `map`, `graph`, `illustration`, `none` |
| [`defaults`](#label-defaults-and-fonts), `text` | label defaults: font, padding, buffer, mark, wrap, truncate; text shaping |
| [`items`](#items) | what to label: anchor, label, attributes, priority |
| [`obstacles`](#obstacles) | what to avoid besides the items: vector layers, SVG, raster images |
| [`avoid`](avoidance.md) | how hard to avoid each obstacle class, for labels and leaders |
| [`placement`](candidates.md) | candidate models and their options |
| [`leaders`](../tutorials/leaders.md#leader-options) | leader style and geometry |
| [`priority`](../tutorials/priority.md) | priority terms, tiers, coverage, omission mode, budget |
| [`solver`](solver.md) | strategy, time budget, seed, grid cell |
| [`degrade`, `degrade_options`](candidates.md#the-degradation-ladder) | the degradation ladder |
| [`weights`](candidates.md#costs) | weights of the cost terms |
| [`warm_start`](../tutorials/interactive-maps.md) | a previous result to stay close to |
| [`output`](#output) | extras in the result: debug SVG, cost breakdown, candidates, item shapes |

## Lengths

A length is a number of pixels or a string with a unit: `"3px"`, `"9pt"` (1 pt = 4/3 px)
or `"0.5em"` (relative to the font size of the label it belongs to, or to the default font
size for lengths outside a label, such as `canvas.padding`). An invalid unit is a
validation error (`unit`).

## Coordinates

Output is always in **canvas pixels, origin top-left, y down**. Input coordinates
(anchors, absolute polygons and paths, area polygons, vector obstacles, `priority.focus`)
are mapped by

1. `transform` `[a, b, c, d, e, f]` (SVG matrix order): `x' = a·x + c·y + e`,
   `y' = b·x + d·y + f`;
2. then, with `y_axis: "up"`, `y'' = canvas.height − y'`.

Radii, widths, sizes and offsets are pixel lengths and are never transformed. SVG and
raster backgrounds are in canvas pixels already.

```json
{
  "canvas": { "width": 400, "height": 300 },
  "transform": [40, 0, 0, 30, 0, 0],
  "y_axis": "up",
  "items": [
    { "id": "v1", "anchor": { "type": "point", "x": 1, "y": 1.5 }, "label": { "type": "text", "text": "(1, 1.5)" } }
  ]
}
```

Data point (1, 1.5) lands at canvas (40, 300 − 45) = (40, 255).

Mark rotations are degrees **clockwise** on screen (as in SVG); leader angles are degrees
**counter-clockwise from +x** as seen on screen (0 = right, 90 = up).

## Canvas

```json
{
  "canvas": { "width": 800, "height": 600, "padding": 4, "region": [50, 20, 700, 540], "allow_outside": false }
}
```

* `padding` keeps labels this far inside the canvas (or `region`): the outside is the
  obstacle class `canvas_edge`, hard by default. Leaders may leave the region, not the
  canvas.
* `region` `[x, y, w, h]`: labels must stay inside this sub-rectangle, e.g. a chart's plot
  area.
* `allow_outside: true` drops the `canvas_edge` class.
* `background` (`"#rrggbb"`, default white): the colour of the canvas where no raster
  lies. Labels avoid straddling the edge between it and a raster of another lightness
  ([the contrast cost](../tutorials/raster-backgrounds.md#contrast-borders)).

Without `canvas`, the canvas is the first raster background's size (divided by its
`scale`), else the first SVG's viewport, else the problem is **unbounded**: there is no
canvas edge, and the working area is the bounding box of everything plus a margin.

## Items

```json
{
  "items": [
    {
      "id": "nbg",
      "anchor": { "type": "point", "x": 320, "y": 210, "mark": { "shape": "circle", "r": 4 } },
      "label": { "type": "text", "text": "Nuremberg" },
      "attrs": { "pop": 518000, "region": "Franconia" },
      "priority": 518000
    }
  ]
}
```

| Key | |
|---|---|
| `id` | unique; default the index as a string (`"0"`, `"1"`, …) |
| `anchor` | `{"type": "point", "x", "y", "mark"}` or `{"type": "area", "polygon", "holes", "dot"}` — see [shapes](../tutorials/shapes.md) |
| `label` | text, icon, box or composite — see [labels](#labels) |
| `attrs` | free data for priority terms and expressions |
| `priority`, `tier`, `required` | an explicit score, tier, or "never omit while a non-required label is placed" |
| `group` | items with the same group share one label with fan leaders (e.g. coincident points) |
| `keep_with` | all-or-none: a set name shared by the members, or a list of item ids |
| `svg_id` | the SVG element that draws the item (with `obstacles.svg.auto_mark_items`) |
| `placement` | per-item `models`, `offset`, `internal`, `position_order` |

Placements in the result come in input order.

## Labels

**Text** is measured with the bundled Noto Sans (Latin, Greek, Cyrillic) or a font you
supply; the label box is the text block plus `padding` (0.15 em) on every side.

```json
{
  "items": [
    {
      "anchor": { "type": "point", "x": 320, "y": 200 },
      "label": {
        "type": "text",
        "text": "org.example.very.long.ClassName",
        "alternatives": ["ClassName", "CN"],
        "wrap": { "max_width": "12em", "max_lines": 2 },
        "truncate": "middle",
        "font": { "size": 11, "weight": "bold" }
      }
    }
  ]
}
```

* `text`: a line feed (`"Paris\n2.1M"`) breaks the line, and such a label keeps its lines:
  it is never rewrapped or truncated.
* `alternatives`: shorter fallbacks, tried in order by the `alternatives` ladder step.
* `wrap`: `max_width` (a length) and `max_lines`. Lines break at spaces, after punctuation
  (`/ \ . _ - , ; : |`), at camelCase and acronym boundaries and between CJK characters;
  `balance` (default true) evens out the line lengths.
* `truncate`, for text that needs more than `max_lines`: `end` (`org.exa…`), `middle`
  (`org…Name`) or `none` (keep it all).
* `width`, `height`, `lines`: the host's measurement (e.g. in a browser), which the engine
  then uses instead of its own.
* `align`: `start`, `center` or `end` for wrapped lines (only reported: you draw the
  text).

**Icons and boxes** have a fixed `width` × `height` and a `shape` for the collision test:
`rect`, `rounded:4`, `circle`, or `polygon` with a `polygon` silhouette.

**Composites** lay out text, icon and box parts in a `row` (default) or `column`, with a
`gap` and an `align`ment across the main axis; the composite's `padding` surrounds the
whole:

```json
{
  "items": [
    {
      "anchor": { "type": "point", "x": 300, "y": 150 },
      "label": {
        "type": "composite",
        "direction": "row",
        "gap": 3,
        "parts": [ { "type": "icon", "width": 12, "height": 12 }, { "type": "text", "text": "Server A" } ]
      }
    }
  ]
}
```

The result reports the box of each part (`parts`), so you can draw the icon and the text.

## Label defaults and fonts

`defaults` applies to every label that does not set its own values:

```json
{
  "defaults": {
    "font": { "family": "default", "size": 12, "weight": 400, "style": "normal", "line_height": 1.2 },
    "padding": "0.15em",
    "buffer": "0.3em",
    "mark": { "shape": "circle", "r": 2 },
    "wrap": null,
    "truncate": "none"
  },
  "text": { "shaping": "auto" }
}
```

* `font.family` `"default"` is the bundled Noto Sans (weights 400 and 700; italic falls
  back to upright). Other fonts: `font.file` with a TTF/OTF path or `data:` URL; the
  nearest available weight is used.
* `buffer` is a soft ring around each label that keeps other items' marks and leaders at
  a distance, so the label is not read as theirs.
* `margin` (0.2 em) is the space a label keeps from other labels and other items' marks,
  as a hard rule; its own mark it touches at `placement.offset` (1 px), so each label sits
  clearly closer to its own mark than to anything else
  ([ADR placement/margin](../adr/placement/margin.md)).
* `text.shaping`: `simple` (kerning only; identical in every implementation), `full`
  (HarfBuzz-compatible shaping in the Rust core, for complex scripts) or `auto` (full for
  scripts that need it, where available).

## Obstacles

Everything to avoid besides the items is in `obstacles`, sorted into **classes** that
[`avoid`](avoidance.md) weighs.

```json
{
  "obstacles": {
    "vector": [
      { "class": "points", "points": [[120, 80], [130, 95]], "r": 2 },
      { "class": "lines", "polylines": [[[0, 300], [400, 120], [800, 90]]], "width": 1.5 },
      { "class": "legend", "rects": [[620, 40, 150, 46]] },
      { "class": "areas", "polygons": [[[10, 10], [60, 10], [60, 50]]], "fill_rule": "nonzero" },
      { "class": "nodes", "circles": [[400, 300, 12]], "shapes": [ { "shape": "ellipse", "x": 500, "y": 200, "rx": 20, "ry": 8 } ] }
    ],
    "svg": { "path": "chart.svg", "classes": [ { "selector": "text", "class": "text" } ] },
    "raster": { "source": "map.png", "mode": "ink" }
  }
}
```

* `vector`: layers of one class each, with `points` (radius `r`, 2), `circles`
  (`[x, y, r]`), `rects` (`[x, y, w, h]`), `polygons` (+ `fill_rule`), `polylines`
  (stroke `width`, 1) and `shapes` (any [mark](../tutorials/shapes.md) with `x`, `y`).
* `svg`: SVG markup (`source`) or a file (`path`), with class rules
  ([SVG backgrounds](../tutorials/svg-background.md)).
* `raster`: an image (`source`: path, `data:` URL or base64; or `rgba` pixels) in one of
  five modes ([raster backgrounds](../tutorials/raster-backgrounds.md)).

`svg` and `raster` also take a list of sources. The host reads the files: relative paths
resolve against the problem file in the CLI and the working directory in C and Java;
JavaScript reads them through `readFile`.

## Output

```json
{
  "output": { "debug_svg": true, "cost_breakdown": true, "candidates": false, "item_shape": false }
}
```

* `debug_svg`: the [debug overlay](debug-overlay.md) with cost heatmaps, in
  `result.debug_svg`.
* `cost_breakdown`: each placed label's cost per term (`cost_breakdown`).
* `candidates`: every generated candidate (box, model, cost, feasibility) in
  `result.candidates` (large).
* `item_shape`: each item's resolved geometry in canvas pixels (`item_shape`).

The other sections have pages of their own: [avoidance](avoidance.md),
[candidates and the ladder](candidates.md), [priority](../tutorials/priority.md),
[leaders](../tutorials/leaders.md), [the solver](solver.md).
