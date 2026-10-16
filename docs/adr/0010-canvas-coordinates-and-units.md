# 0010 — Canvas inference, coordinates and units

* Status: accepted
* Date: 2026-10-16

## Decision
* `canvas` is optional: from the first raster (size / scale), else the first SVG
  viewport, else **unbounded** (no `canvas_edge`, grid over the content bounding box
  grown by `max(max_distance, 20 em)`). This makes `place(anchors, labels)` work without
  any other input.
* `transform` (SVG matrix order) is applied first, then `y_axis: "up"` flips with the
  canvas height. Lengths are never transformed.
* Units: `px`, `pt` (4/3 px), `em` (the label's font size; global lengths use
  `defaults.font.size`). Parsed in one function per implementation.
* Mark rotation: degrees clockwise on screen (SVG). Leader angles: degrees
  counter-clockwise on screen, 0 = right, 90 = up (what people mean by "45° up-right").
* Item ids default to the index as a string.
