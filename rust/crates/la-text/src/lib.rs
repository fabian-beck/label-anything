//! Text measurement, line breaking, wrapping and truncation for the Label Anything label
//! placement engine (spec §5.2–5.3 in `spec/spec.md`). Pure Rust, no I/O, builds for
//! `wasm32-unknown-unknown`. The TypeScript package `@label-anything/text` implements the
//! same algorithms with bit-identical results.
//!
//! # Measuring
//!
//! * [`Font::from_bytes`] parses a TrueType/OpenType font once; [`Font::width`] measures
//!   with **simple shaping**: `cmap` → `hmtx` advances + GPOS pair kerning (`kern`
//!   feature) or a legacy `kern` table, summed in font units and scaled once, so widths are
//!   identical in every implementation. [`Font::width_shaped`] uses full shaping
//!   (rustybuzz, feature `shaping`) and [`Font::measure`] picks one per [`Shaping`] mode;
//!   [`needs_complex_shaping`] tells which texts need full shaping.
//! * [`FontBook`] resolves `(family, weight, italic)` requests to fonts;
//!   `FontBook::with_bundled` contains the bundled Noto Sans subset.
//!
//! ```
//! # #[cfg(feature = "bundled-font")] {
//! use label_anything_text::FontBook;
//!
//! let book = FontBook::with_bundled();
//! let font = book.font(book.resolve("default", 400, false));
//! assert_eq!(font.advance_units("AV"), 1199); // advances of A and V, plus their kerning
//! assert_eq!(font.width("AV", 12.0), 1199.0 * 12.0 / 1000.0);
//! # }
//! ```
//!
//! # Wrapping
//!
//! The wrapping functions work on code points and take a `measure` closure, so they work
//! with any font, size or host-provided measurement:
//!
//! * [`break_opportunities`] — where a line may end;
//! * [`greedy_wrap`], [`balanced_wrap`] — line breaking;
//! * [`truncate_end`], [`truncate_middle`] — shortening with `…`;
//! * [`wrap_variants`], [`extra_wrap_variants`] — the layout variants of a label
//!   ([`TextVariant`]) for given [`WrapOptions`].
//!
//! ```
//! use label_anything_text::{greedy_wrap, wrap_variants, WrapOptions};
//!
//! let measure = |s: &str| 6.0 * s.chars().count() as f64; // or |s| font.width(s, 12.0)
//! assert_eq!(greedy_wrap("org.example.Foo", 72.0, &measure), ["org.example.", "Foo"]);
//! assert_eq!(greedy_wrap("The quick brown fox", 100.0, &measure), ["The quick brown", "fox"]);
//!
//! let opts = WrapOptions { max_width: Some(100.0), max_lines: 2, ..WrapOptions::default() };
//! let variants = wrap_variants("The quick brown fox", &opts, &measure);
//! assert_eq!(variants[0].lines, ["The quick", "brown fox"]); // balanced
//! assert_eq!(variants[0].widths, [54.0, 54.0]);
//! ```
//!
//! # Features
//!
//! * `bundled-font` (default): embeds the metrics-only Noto Sans Regular and Bold
//!   (SIL OFL 1.1, see `assets/OFL.txt`) for `FontBook::with_bundled`.
//! * `shaping` (default): full shaping with rustybuzz for [`Font::width_shaped`].
//! * `woff2`: WOFF2 input for [`Font::from_bytes`] (pure-Rust decoder `wuff`).
#![forbid(unsafe_code)]
#![warn(missing_docs)]

mod book;
mod breaks;
mod cmap;
mod error;
mod font;
mod kern;
mod reader;
mod unicode;
mod unicode_data;
mod wrap;

pub use book::{FontBook, FontId};
pub use breaks::break_opportunities;
pub use error::TextError;
pub use font::{Font, Shaping};
pub use unicode::needs_complex_shaping;
pub use wrap::{
    balanced_wrap, extra_wrap_variants, greedy_wrap, truncate_end, truncate_middle, wrap_variants,
    TextVariant, Truncate, WrapOptions,
};
