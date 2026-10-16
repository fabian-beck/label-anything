# 0002 — Monorepo layout and package names

* Status: accepted
* Date: 2026-10-16

## Context
The brief prescribes the layout (`spec/`, `conformance/`, `rust/`, `ts/`, `bindings/`,
`bench/`, `docs/`, `examples/`) and asks to check name availability before publishing.
"Label Anything" is also the name of an unrelated computer-vision segmentation work.

## Decision
* Layout exactly as in the brief, plus `fonts/` (bundled OFL font and its provenance)
  and `tools/` (code generation, license checks, font subsetting).
* Registry check on 2026-10-16: `label-anything` was free on crates.io, npm and PyPI;
  the npm scope `@label-anything` was free.
* Names:
  * crates: `label-anything` (facade), `label-anything-core`, `-text`, `-expr`, `-svg`,
    `-raster`, `-render`, `-cli` (binary `label-anything`), `-wasm`, `-py`, `-capi`.
    Directory names stay `rust/crates/la-*` as in the brief.
  * npm: `@label-anything/core`, `/text`, `/svg`, `/raster`, `/wasm`, `/wasm-adapter`,
    `/extras` (js-extras).
  * PyPI: `label-anything` (import `label_anything`).
  * Maven: `io.github.fabian-beck:label-anything` (Java package
    `io.github.fabianbeck.labelanything`; `io.github.*` group ids need no domain).
  * C library: `liblabelanything` with header `label_anything.h`.
* All package descriptions say "label placement" for discoverability.

## Consequences
Before the first release the availability check must be repeated; names are
reserved by publishing 0.1.0. `la-expr` is an extra crate (not in the brief's list) so the
expression language can be shared by `la-core` and tools without pulling in the solver.
