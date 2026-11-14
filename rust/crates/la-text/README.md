# label-anything-text

> **Experimental:** Label Anything is still experimental and under active development,
> mostly by an AI coding assistant (Claude Code) with limited human oversight. The API,
> the problem format and the placements can change without deprecation.

Text measurement, line breaking, wrapping and truncation: an OpenType reader with simple
shaping (advances and pair kerning, summed in font units), full shaping with rustybuzz
(feature `shaping`), and a font book with a bundled Noto Sans subset. The TypeScript
package `@label-anything/text` implements the same algorithms and measures the same
widths, bit for bit.

Part of [Label Anything](https://fabian-beck.github.io/label-anything/), a label placement engine for charts, maps and
diagrams. To place labels from Rust, use the crate
[`label-anything`](https://crates.io/crates/label-anything), which wires the parts
together; this crate is for programs that need this part alone.

```rust
use label_anything_text::{greedy_wrap, FontBook};

let book = FontBook::with_bundled();
let font = book.font(book.resolve("default", 400, false));
assert_eq!(font.width("AV", 12.0), 1199.0 * 12.0 / 1000.0); // two advances and their kerning

let measure = |s: &str| font.width(s, 12.0);
assert_eq!(greedy_wrap("The quick brown fox", 90.0, &measure), ["The quick", "brown fox"]);
```

Features: `bundled-font` (default; embeds the metrics of Noto Sans Regular and Bold),
`shaping` (default; rustybuzz) and `woff2` (WOFF2 fonts). The crate has no I/O and builds
for `wasm32-unknown-unknown`.

MIT License. The embedded font metrics are a subset of Noto Sans, Copyright 2022 The Noto
Project Authors, under the SIL Open Font License 1.1 (`assets/OFL.txt`).
