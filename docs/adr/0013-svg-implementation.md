# 0013 — SVG backgrounds: own mirrored implementation, no usvg

* Status: accepted (refines the `la-svg` bullet of ADR 0012)
* Date: 2026-10-16

## Context
§4.5 turns SVG backgrounds into classified obstacle geometry. ADR 0012 sketched `la-svg`
as usvg geometry plus our selector engine on the roxmltree DOM. Requirements that matter
here: identical behaviour of the Rust crate and the zero-dependency TypeScript package,
no panics on hostile input, `wasm32-unknown-unknown`, a small dependency footprint and
deterministic output. Findings while evaluating the options:

* **usvg** drops `<text>` without fontdb, resolves CSS and `<use>` internally with no
  mapping back to source elements (rewriting ids to recover it breaks `href`s and `#id` CSS
  rules), and converts arcs to cubics with a fixed approximation. Every one of these would
  differ from the TypeScript implementation in edge cases.
* **roxmltree** parses recursively, one call chain per nesting level. Measured: a
  document nested 150 levels deep aborts a debug build on a 2 MiB thread (the default for
  tests), ~1 000–4 000 levels abort release builds — a stack overflow is an uncatchable
  abort, not an error.
* **svgtypes** would save little: the micro-syntaxes (numbers, lengths, transforms, path
  data, colours) are ~400 lines that the TypeScript side needs anyway.

## Decision
* Both packages implement the same algorithms in mirrored modules
  (`xml, num, geom, transform, path, flatten, color, css, selector, style, render, text,
  classify`), with the same operation order for floating-point work. Runtime dependencies:
  none (Rust: optional `serde` feature for JSON identical to the TS objects).
* **XML:** our own iterative parser (explicit element stack; namespaces; internal DTD
  entities incl. markup, with roxmltree's loop limits; CDATA; character references;
  attribute-value normalization). Its acceptance rules follow roxmltree, which stays a
  dev-dependency: a differential test compares accept/reject and the full tree on 20 000
  random documents. The one intended deviation: a namespace declaration repeated in one
  start tag is rejected (XML 1.0 "Unique Att Spec"; roxmltree accepts it).
* **Limits** (structured errors, never panics): nesting > 1024 elements, > 1 000 000
  elements, `<use>` expansion > 2 000 000 rendered elements or > 8 000 000 points → `limit`;
  render depth (elements plus `<use>` levels) is capped at 384, deeper content is skipped
  with a `limit` warning (fits a 2 MiB debug stack; tested). Selector matching is a dynamic
  program over the ancestor chain (no exponential backtracking).
* **Geometry:** Béziers are transformed first and split uniformly by Wang's formula;
  arcs, circles, ellipses and rounded corners are sampled on the exact curve with the
  sagitta formula on the largest singular value of `CTM · R(φ) · diag(rx, ry)` — every
  flattened curve is within `tolerance` canvas px of the true curve (property-tested).
  Stroke width = `stroke-width · √|det CTM|` (`vector-effect: non-scaling-stroke`: as is).
* **Attribution:** geometry drawn through `<use>` belongs to the outermost `<use>` for
  classification, `element_geometry` and `select`; `source` names the defining element.
  Primitives are emitted in paint order, which is non-decreasing in `element`, so the
  primitives of an element subtree form one contiguous slice.
* **Text** uses the injected `measure(text, size, family, weight)` (default 0.55 em per
  code point) and ascent/descent (default 0.8/0.2 em; the engine passes its bundled font's,
  ADR 0020); one box per text chunk.
* **Differential testing** (`ts/packages/svg/scripts/parity.mjs`): the conformance cases
  plus seeded random documents (random features, invalid values, DTD entities, namespaces,
  mutated/truncated markup) produce identical scenes, classifications and selections in
  Rust and TypeScript (every element, flag, box, vertex and warning code, to 1e-9
  relative); 20 000 random documents over 10 seeds agree. One fix came out of it: when
  arc radii must be scaled up, the centre is set to the chord midpoint directly instead
  of computing a catastrophically cancelling `sqrt(num/den)`.

## Consequences
* ≈ 3 000 lines per language that must change together; the mirrored file layout, the
  shared conformance cases and the parity script keep them aligned (run the script after
  every change to either side; see `conformance/svg/README.md`).
* Not modelled (spec §4.5): clipping, masks, filters, markers, dashes, gradient/pattern
  transparency (a valid paint server counts as opaque), `textLength`, per-glyph
  positioning (first `x`/`y`/`dx`/`dy` value only), `textPath` layout, intrinsic image sizes,
  external references, `foreignObject` content; `currentColor` is opaque.
* Performance (10 000 elements, parse + classify with the `auto` rules): Rust release
  ≈ 20 ms; TypeScript on Node ≈ 45–110 ms warm. A cold first call in Node pays JIT
  tier-up and scavenger copying of the (retained) result, ≈ 0.2–0.3 s on a loaded 4-core
  container.
