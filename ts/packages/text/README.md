# @label-anything/text

> **Experimental:** Label Anything is still experimental and under active development,
> mostly by an AI coding assistant (Claude Code) with limited human oversight. The API,
> the problem format and the placements can change without deprecation.

Text measurement, line breaking, wrapping and truncation for the
[Label Anything](https://fabian-beck.github.io/label-anything/) label placement engine, in pure TypeScript with zero
dependencies: an OpenType reader with simple shaping (advances and pair kerning), a font
book with a bundled Noto Sans subset (Latin, Greek, Cyrillic), and the line breaker. The
widths are **bit-identical** to the Rust crate `label-anything-text` (checked by
`conformance/text`).

To place labels, use [`@label-anything/core`](https://www.npmjs.com/package/@label-anything/core),
which builds on this package; use this one for the text part alone.

```ts
import { FontBook, greedyWrap, wrapVariants } from "@label-anything/text";

const book = FontBook.withBundled();
const font = book.font(book.resolve("default", 400, false));
font.width("AV", 12); // 14.388: two advances and their kerning

const measure = (s: string) => font.width(s, 12); // or any function, e.g. on a canvas context
greedyWrap("The quick brown fox", 90, measure); // ["The quick", "brown fox"]

// the layouts a label may take: balanced lines first
wrapVariants("The quick brown fox", { maxWidth: 100, maxLines: 2 }, { font, size: 12 })[0];
// { lines: ["The quick", "brown fox"], widths: [54.036, 56.58], truncated: false }
```

`Font.fromBytes(bytes)` reads your own TrueType or OpenType font. There is no full
OpenType shaping: `needsComplexShaping(text)` tells which texts (Arabic, Hebrew, Indic,
Thai, …) get approximate widths, so that a host can measure those itself.

MIT License. The bundled font metrics are a subset of Noto Sans, Copyright 2022 The Noto
Project Authors, under the SIL Open Font License 1.1 (`OFL.txt`).
