# 0011 — The `auto` preset and SVG selector extensions

* Status: accepted
* Date: 2026-10-16

## Context
§6.6: with an SVG, `auto` maps `circle,ellipse,rect[small]`→points,
`path,line,polyline`→lines, `text`→text; with a raster, `ink` at 0.5; distant + leaders
when > 30 % of items lack a free adjacent candidate. The defaults table lists
adjacent+slider+distant.

## Decision
* Presets are data (`spec/presets/*.json`): `options` (merged between defaults and the
  problem), `svg_classes` (rules for SVG sources without `classes`) and, for `auto`,
  `auto.crowded_fraction` / `crowded_models`.
* `auto` uses `[adjacent, slider]` and switches to `[adjacent, slider, distant]` when more
  than 30 % of the items have no statically free adjacent/slider candidate — unless the
  problem sets `placement.models` itself. Other presets use the table default (with
  distant). The ladder's `distant` step still gives leaders to individual items that do
  not fit, so `auto` degrades gracefully either way.
* "rect[small]" is not CSS; we add pseudo-classes to the selector subset:
  `:small` (bbox ≤ 16 px both ways), `:background` (bbox ≥ 90 % of the canvas both ways —
  plot backgrounds must not become obstacles), `:filled`, `:unfilled`.

## Consequences
Typical SVG exports (matplotlib, Vega, Plotly, ggplot2/svglite) get sensible obstacle
classes without configuration; background rectangles and figure patches are ignored.
