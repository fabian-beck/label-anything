# Shapes

A label belongs next to its feature's *outline*, not next to a bounding box around it.
Every item has a **mark**, the true geometry of the labeled feature: adjacent labels touch
it (at `placement.offset`, 1 px), other labels keep a margin from it, and a mark large
enough holds its label inside.

```json
--8<-- "examples/tutorials/problems/shapes.json"
```

![Every mark shape, with internal and external labels](../assets/gallery/shapes.svg)

## Mark shapes

`anchor.mark` (default: a circle of radius 2) is one of:

| shape | geometry | the anchor `(x, y)` is |
|---|---|---|
| `circle` | `r` | the center |
| `ellipse` | `rx`, `ry`, `rotation` (degrees, clockwise on screen) | the center |
| `rect` | `w`, `h`, `corner_radius`, `rotation` | the center |
| `polygon` | `points` (+ `holes`), absolute coordinates or px offsets with `relative: true` | the anchor as given |
| `path` | SVG path data `d`, flattened to polygons (0.25 px), absolute or `relative` | the anchor as given |
| `icon` | a `w` × `h` box whose `tip` (default bottom center `[w/2, h]`, like a map pin's point) sits on the anchor; optional `silhouette` | the tip |
| `from_svg` | the outline of an SVG element (`svg_id` or `selector`) | the anchor as given |

Sizes and offsets are in pixels and never transformed by `transform`; absolute polygon and
path coordinates are.

**Touching the true shape.** The eight adjacent positions put the label's corner (diagonal
positions) or side midpoint (top, right, bottom, left) onto the outermost point of the mark
in that direction. For a circle, the top-right label touches the circle at 45°, not at the
corner of its bounding box. Concave shapes use their convex hull for this, and their true
outline for every overlap test. Sliding positions move the label along the mark between
two fixed positions.

## Internal labels

`placement.internal` decides whether labels may go inside their mark:

* `auto` (default) — *prefer* inside for rectangles, ellipses, polygons, paths and areas;
  *allow* it for circles with `r ≥ internal_circle_ratio` (1.5) × the label height;
  never for icons;
* `prefer` — inside first, outside only when inside does not fit;
* `allow` — inside after every outside position;
* `never`.

An internal label must fit inside the mark with `inner_padding` (0.2 em) to spare; its
candidates are the pole of inaccessibility (the point farthest from the outline) and the
reference point. In the example, the large circle's item sets
`"placement": {"internal": "prefer"}`. The ellipse, the card and the path take their labels
inside; the triangle is too narrow at its pole and gets an outside label.

Per item, `placement` overrides `models`, `offset`, `internal` and `position_order`.

## Area anchors

An item with an `area` anchor labels a region: its label goes inside the polygon if it
fits, where it has the most room around it, near the middle of the area (the pole of
inaccessibility) when there is room everywhere. The engine offers places all over the part
of the polygon the label fits in, so a label gives way to the marks and labels inside its
area without leaving it. If it does not fit ("Tiny region" in the example), the item
becomes a point at the pole with a small dot mark (`anchor.dot`, by default a circle of
radius 2) and gets an outside label, on a leader if needed. Areas are not obstacles for
other labels.

A label may be **turned** along a slanted area, as the names of lakes and valleys are on
a map ("Slanted lake" in the example): when the polygon is clearly longer one way (its main axis is at least 10° from the
horizontal), the engine also tries the label along that axis, by at most
`placement.area_rotation` (45° by default; `0` keeps every label upright). Turning costs
a little (45° as much as one more line of text), so a label that has room upright stays
upright. The placement of a turned label has a `rotation` in degrees, clockwise, and its
`box` is the label before it is turned about the box's center:

```js
for (const p of result.placements) {
  if (!p.placed) continue;
  const turn = p.rotation ? `rotate(${p.rotation} ${p.box.x + p.box.w / 2} ${p.box.y + p.box.h / 2})` : "";
  // draw the text in p.box as for any label, inside <g transform={turn}>
}
```

The renderers of the packages (`renderSvg`, the debug overlay) do this already.

## Covering one's own mark

By default a label never covers its own mark (`avoid.label.own_mark: "hard"`).
`"partial:0.3"` lets external labels cover up to 30 % of it, `"ignore"` any part — useful
for tiny marks under long labels.

## In Python

```python
--8<-- "examples/tutorials/python/shapes.py:shapes"
```

`output.item_shape` (`item_shape=True`) reports each item's resolved geometry in canvas
pixels, e.g. to draw the marks exactly where the engine saw them:

```python
--8<-- "examples/tutorials/python/shapes.py:item-shape"
```

## Shapes without labels

Unlabeled shapes go into `obstacles.vector` layers, one class per layer: `points` with a
radius `r`, `circles` (`[x, y, r]`), `rects` (`[x, y, w, h]`), `polygons`, `polylines`
with a stroke `width`, and `shapes`, any mark with a position (`{"shape": "ellipse",
"x": …, "y": …, "rx": …, "ry": …}`); see [the problem format](../concepts/problem.md#obstacles).

Labels have shapes too: besides text, a label can be an `icon` or `box` of fixed size
(`shape`: `rect`, `rounded:r`, `circle` or a `polygon` silhouette) or a `composite` of
text, icon and box parts in a row or column ([labels](../concepts/problem.md#labels)).
