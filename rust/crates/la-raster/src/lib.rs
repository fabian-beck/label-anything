//! # label-anything-raster
//!
//! Raster backgrounds for the Label Anything label placement engine (spec §4.6): decode
//! PNG, JPEG or WebP images (or take raw RGBA), turn every pixel into a value in `[0, 1]`
//! with one of five modes (`ink`, `alpha`, `cost`, `classmap`, `saliency`) and
//! area-average the values into per-class `u8` coverage grids (spec §4.1). Building
//! summed-area tables from the grids is the core's job.
//!
//! The computation is specified to the bit: colour conversion (an exactly rounded sRGB
//! table, Ottosson's OKLab matrices and a Newton cube root), compositing, area weights,
//! summation order and quantization only use IEEE-754 `+ − × ÷ sqrt` in a fixed order, so
//! the pure TypeScript package `@label-anything/raster` produces identical coverage
//! arrays (checked by `conformance/raster`).
//!
//! ```
//! use label_anything_raster::{process, GridSpec, Mode, RasterPlacement, Rgba};
//!
//! // A 4×2 white image with one black pixel, on a canvas grid of 2 px cells.
//! let mut data = vec![255u8; 4 * 2 * 4];
//! data[4 * 1..4 * 1 + 3].copy_from_slice(&[0, 0, 0]);
//! let img = Rgba::new(4, 2, data).unwrap();
//! let grid = GridSpec { origin_x: 0.0, origin_y: 0.0, cell: 2.0, cols: 2, rows: 1 };
//! let mode = Mode::Ink { background: None, threshold: 0.12, dilate: 0 };
//! let out = process(&img, &mode, "ink", &RasterPlacement::default(), &grid);
//! assert_eq!(out[0].class, "ink");
//! assert_eq!(out[0].coverage, vec![64, 0]); // 1 of 4 pixels: floor(0.25 · 255 + 0.5)
//! ```
//!
//! ## Features
//!
//! * `decode` (default): PNG, JPEG and WebP decoding through the `image` crate (pure
//!   Rust, only the `png`, `jpeg` and `webp` codecs). Without it, [`decode`] returns an
//!   `unsupported` error and raw RGBA input still works. The crate builds for
//!   `wasm32-unknown-unknown` with and without the feature.
#![forbid(unsafe_code)]
#![warn(missing_docs)]

mod base64;
mod color;
mod decode;
mod error;
mod grid;
mod process;
mod rgba;
mod srgb_lut;

pub use base64::decode_base64;
pub use color::{estimate_background, parse_hex_color, srgb_to_oklab};
pub use decode::{decode, decode_source, ImageFormat};
pub use error::{RasterError, RasterErrorKind};
pub use grid::{GridSpec, RasterPlacement};
pub use process::{process, ClassCoverage, Mode};
pub use rgba::{rgba_from_base64, Rgba};
