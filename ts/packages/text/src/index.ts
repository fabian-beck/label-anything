/**
 * Text measurement, line breaking, wrapping and truncation for the Label Anything label
 * placement engine (spec §5.2–5.3). Zero dependencies; results are bit-identical to the Rust
 * crate `label-anything-text`.
 *
 * * {@link Font.fromBytes} parses a TrueType/OpenType font; {@link Font.width} measures
 *   with simple shaping (cmap → hmtx advances + GPOS/`kern` pair kerning).
 * * {@link FontBook} resolves `(family, weight, italic)`; {@link FontBook.withBundled}
 *   contains the bundled Noto Sans subset (Latin, Greek, Cyrillic).
 * * {@link breakOpportunities}, {@link greedyWrap}, {@link balancedWrap},
 *   {@link truncateEnd}, {@link truncateMiddle}, {@link wrapVariants} and
 *   {@link extraWrapVariants} work on code points with any `measure` callback.
 *
 * Limitation: there is no full OpenType shaping. {@link needsComplexShaping} detects the
 * texts (Arabic, Hebrew, Indic, Thai, …) for which simple-shaping widths are only
 * approximate, so hosts can measure those themselves.
 *
 * @packageDocumentation
 */
export { FontBook, type FontId } from "./book.js";
export { breakOpportunities } from "./breaks.js";
export { TextError } from "./errors.js";
export { Font } from "./font.js";
export { needsComplexShaping } from "./unicode.js";
export {
  balancedWrap,
  extraWrapVariants,
  greedyWrap,
  truncateEnd,
  truncateMiddle,
  wrapVariants,
  type Measure,
  type TextVariant,
  type Truncate,
  type WrapOptions,
} from "./wrap.js";
