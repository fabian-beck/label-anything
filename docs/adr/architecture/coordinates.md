# Coordinates and units

A problem needs no canvas; coordinates pass through one transform, and lengths and angles
follow one convention in every binding.

## Context
The simplest call, `place(anchors, labels)`, gives nothing but points and texts, and hosts
bring coordinates in their own conventions: SVG matrices, y pointing up, lengths in points
or relative to the font.

## Decision
- `canvas` is optional: it comes from the first raster (size divided by scale), else the
  first SVG viewport; otherwise the problem is **unbounded**, with no `canvas_edge` and a
  grid over the content's bounding box grown by `max(max_distance, 20 em)`.
- `transform` (SVG matrix order) applies first, then `y_axis: "up"` flips with the canvas
  height. Lengths are never transformed.
- Units are `px`, `pt` (4/3 px) and `em` (the label's font size; lengths tied to no label
  use `defaults.font.size`), parsed in one function per implementation.
- Mark rotations turn clockwise on screen, as in SVG. Leader angles turn
  counter-clockwise, 0 = right and 90 = up, as people mean "45° up-right".
- Item ids default to the index as a string.

## Consequences
`place(anchors, labels)` works without any other input, and hosts pass coordinates as they
have them. Without a canvas nothing keeps the labels inside a frame.
