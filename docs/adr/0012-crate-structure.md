# 0012 — Crate and package structure

* Status: accepted
* Date: 2026-10-16

## Decision
* `la-core` depends only on `serde`, `serde_json`, `la-text` and `la-expr` (all pure Rust,
  no I/O, `wasm32-unknown-unknown` without features). Optional feature `parallel`
  (rayon). SVG and raster decoding are injected through small traits (`SvgBackend`,
  `RasterBackend` in `la_core::env`) so the core never depends on `usvg`/`image`.
* `la-text`: font parsing, simple shaping, optional full shaping (`shaping` feature →
  rustybuzz), line breaking/wrapping/truncation, embedded metrics fonts (`bundled-font`
  feature, default), WOFF2 input (`woff2` feature → `wuff`, off by default).
  The OpenType reader (cmap, hmtx/hhea, OS/2, GDEF, GPOS pair kerning, legacy `kern`) is
  our own instead of `ttf-parser`: it is small, and the TypeScript package mirrors it
  table by table, so both implementations accept and reject the same malformed fonts and
  measure bit-identical widths (checked by differential fuzzing). rustybuzz still uses
  `ttf-parser` internally for full shaping.
* `la-svg`: usvg-based geometry + our selector engine on the original DOM (roxmltree).
* `la-raster`: image decoding (`image`, minimal features) + pixel modes (pure functions).
* `la-render`: debug SVG writer (+ optional PNG via resvg).
* `label-anything` (facade): wires everything into `place(&str) -> String` and the
  typed API; `la-cli`, `la-wasm`, `la-py`, `la-capi` build on it.
* TypeScript mirrors this: `@label-anything/text`, `/svg`, `/raster` are dependency-free
  packages; `@label-anything/core` depends on them and exposes `place`, `validate` and a
  lean `placeWith(env, problem)` for tree-shaking.

## Consequences
Bindings stay thin; heavy decoders are optional; the core is testable in isolation.
