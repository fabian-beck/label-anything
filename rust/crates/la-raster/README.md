# label-anything-raster

> **Experimental:** Label Anything is still experimental and under active development,
> mostly by an AI coding assistant (Claude Code) with limited human oversight. The API,
> the problem format and the placements can change without deprecation.

Raster backgrounds as coverage grids: the crate decodes PNG, JPEG or WebP images (or takes
raw RGBA), turns every pixel into a value between 0 and 1 with one of five modes (`ink`,
`alpha`, `cost`, `classmap`, `saliency`) and averages the values into per-class grids.
The computation is specified to the bit, so the TypeScript package
`@label-anything/raster` returns the same grids.

Part of [Label Anything](https://fabian-beck.github.io/label-anything/), a label placement engine for charts, maps and
diagrams. To place labels from Rust, use the crate
[`label-anything`](https://crates.io/crates/label-anything), which wires the parts
together; this crate is for programs that need this part alone.

```rust
use label_anything_raster::{process, GridSpec, Mode, RasterPlacement, Rgba};

// A 4×2 white image with one black pixel, on a canvas grid of 2 px cells.
let mut data = vec![255u8; 4 * 2 * 4];
data[4..7].copy_from_slice(&[0, 0, 0]);
let img = Rgba::new(4, 2, data).unwrap();
let grid = GridSpec { origin_x: 0.0, origin_y: 0.0, cell: 2.0, cols: 2, rows: 1 };
let mode = Mode::Ink { background: None, threshold: 0.12, dilate: 0 };
let out = process(&img, &mode, "ink", &RasterPlacement::default(), &grid);
assert_eq!(out[0].coverage, vec![64, 0]); // 1 of 4 pixels
```

Features: `decode` (default; PNG, JPEG and WebP through the `image` crate) and `parallel`
(large base64 inputs on several threads). The crate builds for `wasm32-unknown-unknown`
with and without `decode`.

MIT License.
