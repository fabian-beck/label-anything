# Packages

The engine is a set of small Rust crates mirrored by dependency-free TypeScript packages;
the core does no I/O, and everything heavy is an optional feature.

## Context
One core serves Rust programs, the command line, WebAssembly, Python, a C ABI and, through
it, Java, while a TypeScript port mirrors it line by line. Not every host needs image
decoding or full text shaping, and the core has to build for `wasm32-unknown-unknown` and
be testable without I/O.

## Decision
- `la-core` depends only on `serde`, `serde_json` and the project's own `la-text`,
  `la-expr`, `la-svg` and `la-raster`. Optional features: `parallel` (rayon) and `decode`
  (PNG, JPEG and WebP through the `image` crate). The raster pixel modes are pure
  functions the core calls directly; SVG backgrounds go through a small `SvgBackend` trait
  whose default is `la-svg`, so hosts can plug in their own.
- `la-text`: fonts, simple shaping, line breaking and the embedded metrics fonts; full
  shaping (`shaping`, rustybuzz) and WOFF2 input (`woff2`) are features. Its OpenType
  reader is the project's own rather than `ttf-parser`, because the TypeScript package
  mirrors it table by table: both accept the same fonts and measure the same widths, which
  differential fuzzing checks.
- `la-svg` parses SVG without dependencies (ADR obstacles/svg); `la-raster` holds the
  pixel modes and coverage grids, with decoding behind `decode`; `la-expr` the expression
  language, so tools can use it without the solver; `la-render` the debug renderer.
- The facade `label-anything` wires everything into `place(&str) -> String` and the typed
  API; `la-cli`, `la-wasm`, `la-py` and `la-capi` build on it.
- TypeScript mirrors this: `@label-anything/text`, `/svg` and `/raster` have no
  dependencies, `@label-anything/core` builds on them and offers `place`, `validate` and a
  lean `placeWith(env, problem)` for tree-shaking.

## Consequences
Bindings stay thin, heavy decoders are opt-in, and the core is tested in isolation. The
price of owning the font reader, the SVG parser and the raster code is writing them twice;
it is also what keeps the two implementations identical.
