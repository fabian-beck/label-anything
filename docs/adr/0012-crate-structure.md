# 0012 — Crate and package structure

* Status: accepted
* Date: 2026-10-16
* Area: Packages and formats
* Amended by: [ADR 0013](0013-svg-implementation.md) (`la-svg`)

## Context
One core serves very different hosts: Rust programs, the command line, WebAssembly,
Python and a C ABI, and a TypeScript port that mirrors it. Not every host needs image
decoding or full text shaping, and the core has to build for `wasm32-unknown-unknown` and
be testable without I/O.

## Decision
* `la-core` depends only on `serde`, `serde_json`, `la-text`, `la-expr`, `la-svg` and
  `la-raster` without default features (all pure Rust, no I/O, `wasm32-unknown-unknown`
  without features). Optional features: `parallel` (rayon) and `decode` (PNG/JPEG/WebP through
  `la-raster/decode`, i.e. the `image` crate; the facade enables it). The raster pixel
  modes are pure functions shared by every host, so the core calls them directly and
  borrows the decoded image instead of copying it through a backend trait. SVG
  backgrounds go through a small trait (`SvgBackend` in `la_core::env`) whose default
  is the built-in `la-svg` backend, so hosts can still plug in their own.
* `la-text`: font parsing, simple shaping, optional full shaping (`shaping` feature →
  rustybuzz), line breaking/wrapping/truncation, embedded metrics fonts (`bundled-font`
  feature, default), WOFF2 input (`woff2` feature → `wuff`, off by default).
  The OpenType reader (cmap, hmtx/hhea, OS/2, GDEF, GPOS pair kerning, legacy `kern`) is
  our own instead of `ttf-parser`: it is small, and the TypeScript package mirrors it
  table by table, so both implementations accept and reject the same malformed fonts and
  measure bit-identical widths (checked by differential fuzzing). rustybuzz still uses
  `ttf-parser` internally for full shaping.
* `la-svg`: our own XML parser, CSS subset, path flattening and selector engine, with no
  runtime dependencies and mirrored line by line in `@label-anything/svg` (ADR 0013
  explains why not usvg).
* `la-raster`: pixel modes, background estimation and coverage grids (pure functions,
  identical to `@label-anything/raster` byte for byte) + image decoding (`decode` feature:
  `image` with only the png/jpeg/webp codecs).
* `la-render`: debug SVG writer (+ optional PNG via resvg).
* `label-anything` (facade): wires everything into `place(&str) -> String` and the
  typed API; `la-cli`, `la-wasm`, `la-py`, `la-capi` build on it.
* TypeScript mirrors this: `@label-anything/text`, `/svg`, `/raster` are dependency-free
  packages; `@label-anything/core` depends on them and exposes `place`, `validate` and a
  lean `placeWith(env, problem)` for tree-shaking.

## Consequences
Bindings stay thin; heavy decoders are optional; the core is testable in isolation.
