# Lines

The label of a line — an edge of a node-link diagram, a street, a river — is a straight
box along a stretch of the line, on it or beside it, turned to the stretch's direction.

## Context
Lines were obstacles only: the problem format reserved the anchor type `line` and the
validators rejected it. A host that wanted a name on an edge or a street passed the
line's midpoint as a point, and got a horizontal label beside a dot that is not there,
on whichever side the position order named first, across the line as often as along it.
Area anchors had shown what such an anchor needs: places of its own, a cost that says
how well a place suits the shape, and labels turned by an angle (ADR placement/areas),
with exact tests for a turned box.

## Decision
- **A third anchor type**, `{"type": "line", "points", "width", "dot"}`. The reference
  point is the point halfway along the line; `width` is the stroke, 1 px by default.
- **Places along the line**: the middle, then up to four pairs on either side of it,
  evenly spread from end to end, at least a label height apart. A label lies over the
  stretch of its own width; the stretch's chord gives the direction. Nine places are
  enough to step past a crossing edge or a mark on the line, and they bound the work for
  a street of a thousand points.
- **Straight labels on straight stretches.** A stretch that leaves its chord by more
  than the label's height, or whose chord is shorter than 0.9 of its length (a zigzag
  stays near its chord while it folds), is no place. A label beside the line must also
  keep its offset from the whole line, so that none stands in the corner of an
  orthogonal edge with a leg through it.
- **Three positions**: above and below the line, at `placement.offset` from the stroke,
  ranked by `top` and `bottom` of the item's `position_order`; and on the line, by
  `placement.internal` — `auto` puts a label on a line that is at least as wide as the
  label is high, a street's casing, and beside a thinner one. No new option names the
  positions: `top` is above the text as it reads.
- **Turned along the line**, reading from left to right and upwards on a vertical
  stretch, by any angle up to `placement.line_rotation` (90° by default); a steeper
  stretch gets an upright label beside or on it, and `0` keeps every label upright for
  hosts that cannot turn text. Unlike an area's main axis, a line's direction is not
  noise: there is no least angle, and the angle is not clamped — a label 45° off a 70°
  line follows nothing.
- **The cost** is the label's lack, as for areas, in the `w_distance` term: its distance
  from the middle of the line (1 at an end), the bend under it in label heights, and the
  share of the label a shorter line does not carry. The turn costs what it costs an
  area's label.
- **Internal candidates.** A line label belongs to its line as an area label to its
  area: no gap to a mark, no rule about other marks being nearer, no stub. It is
  reported with model `internal` and `anchor_side` `top`, `bottom` or `internal`.
- **The line is not an obstacle**, as an area is not. Hosts list edges and streets under
  `obstacles` where other labels should keep off them; a label beside its line does not
  touch it. The dot halfway along the line is the item's mark, as an area's dot is: a
  label that has no place along the line stands beside it, and leaders lead to it.
- **In a window** the places are spread over the longest piece of the line inside the
  working extent, so that a street far longer than the view is named where it shows; the
  reference point stays the middle of the whole line, which does not move with the view.
- **Warm starts** keep a box that still lies on or beside the line where the labels of
  the line do, within 1 px and a quarter of the label's height, and within 5° of it.

## Consequences
Edges and streets are labeled as maps and diagrams label them, with the tests, costs and
result format turned labels already had; hosts that draw `rotation` for areas draw line
labels without a change. A problem that validated before is solved as before: no result
of the conformance suite or the benchmark changes. A line item costs up to 27 candidates
per variant and one pass over the line's segments for each. The label is straight: on a
line that curves under it everywhere it stands beside the dot or on a leader instead,
and the soft costs of a turned label are approximate as they are for areas. Labels of
lines take no part in fan and boundary columns. The dot halfway along a labeled line is
a mark other labels keep off, although nothing is drawn there while the label lies along
the line.

## Alternatives
- **Text on a path**, each glyph placed along the curve: the label a cartographer draws
  on a winding river, but a per-glyph result that no host of the format could draw from
  a box and an angle, and tests for a curved label that the engine does not have.
- **The line as the item's mark**, with adjacent and slider positions around it: the
  support points of a long polyline lie at its ends and corners, far from its middle,
  and every labeled line would be an obstacle of the class `items`, which is hard by
  default — in a graph, no node label could cross a labeled edge.
- **An option for the positions** (`above`, `below`, `on`): `position_order` and
  `internal` say the same, per item as well.
- **Clamping the angle** to `line_rotation`, as `area_rotation` does: a label neither
  upright nor along its line reads as a mistake.
- **A place at every label height** along the line: a street across the picture has a
  hundred of them, three positions each, for a choice that nine make as well.
- **Cutting the line to the window** when the problem is read: the reference point
  would move with every pan, and with it the box of a warm start.
