# SVG backgrounds

SVG backgrounds are read by the project's own parser, mirrored line by line in Rust and
TypeScript, rather than by usvg or roxmltree.

## Context
An SVG background becomes classified obstacle geometry (spec §4.5). The Rust crate and the
dependency-free TypeScript package must behave identically, never panic on hostile input,
build for `wasm32-unknown-unknown`, and stay small and deterministic. The established
libraries did not fit:

- usvg drops `<text>` without a font database, resolves CSS and `<use>` without mapping
  geometry back to source elements, and approximates arcs with fixed cubics; each would
  differ from TypeScript at the edges.
- roxmltree recurses once per nesting level: 150 levels abort a debug build on a 2 MiB
  stack, and a stack overflow is an abort, not an error.

## Decision
- Both packages implement the same modules (`xml`, `num`, `geom`, `transform`, `path`,
  `flatten`, `color`, `css`, `selector`, `style`, `render`, `text`, `classify`) with the
  same order of floating-point operations and no runtime dependencies.
- The XML parser is iterative and follows roxmltree's acceptance rules, which a
  differential test checks on 20,000 random documents; the one intended deviation is
  rejecting a namespace declared twice in one start tag, as XML 1.0 requires.
- Limits are errors, never panics: 1,024 nesting levels, 10⁶ elements, 2·10⁶ elements
  after `<use>` expansion, 8·10⁶ points; content deeper than 384 render levels is skipped
  with a warning. Selector matching is a dynamic program, without exponential
  backtracking.
- Curves are flattened in canvas space, Béziers by Wang's formula and arcs on the exact
  curve, so every polyline lies within `tolerance` of the truth. Geometry drawn through
  `<use>` belongs to the outermost `<use>`.
- Text boxes span the measuring font's ascender and descender (Noto Sans: 1.069 and 0.293
  em), as a browser's `getBBox` does; the parser alone, without fonts, uses 0.8 and 0.2
  em.
- The selector subset has pseudo-classes for chart exports: `:small` (≤ 16 px both ways),
  `:background` (≥ 90 % of the canvas both ways, so plot backgrounds do not become
  obstacles), `:filled` and `:unfilled`. With them the presets classify typical exports of
  matplotlib, Vega, Plotly and svglite without configuration.

## Consequences
About 3,000 lines per language must change together; the mirrored file layout, the
conformance cases and a parity script (`ts/packages/svg/scripts/parity.mjs`, run after
every change) keep them aligned. Not modelled: clipping, masks, filters, markers, dashes,
transparency inside paint servers, per-glyph positioning and external resources. Parsing
and classifying 10,000 elements takes about 20 ms in Rust and 45–110 ms in Node.
