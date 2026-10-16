// Constant-time widths of the substrings of a text with simple shaping (spec §5.2),
// identical to `MeasuredText` of the Rust crate `label-anything-text`.
import type { Font } from "./font.js";
import type { KerningRanges } from "./kern.js";

/**
 * A text prepared for measuring its substrings with simple shaping.
 *
 * Simple shaping adds up integer glyph advances and pair-kerning adjustments, so one
 * linear-time pass over the text answers every code point range in constant time: prefix sums
 * of the advances, plus, per kerning lookup, the adjustments its walk (spec §5.2) adds from
 * every position on. The ranges are exact: `advanceUnits(start, end)` equals
 * {@link Font.advanceUnits} of the code points `start..end` for every range, so
 * {@link MeasuredText.width} is bit-identical to {@link Font.width}. The wrapping functions
 * measure their candidate lines this way with a {@link FontMeasure}.
 *
 * ```ts
 * const text = new MeasuredText(font, "AVA");
 * text.advanceUnits(0, 2) === font.advanceUnits("AV"); // true
 * text.width(1, 3, 12) === font.width("VA", 12); // true
 * ```
 */
export class MeasuredText {
  private readonly unitsPerEm: number;
  /** `advances[i]`: the sum of the advances of the first `i` glyphs, in font units. */
  private readonly advances: Float64Array;
  private readonly kerning: KerningRanges;

  /** Maps `text` to glyphs and prepares its ranges, in time linear in its length. */
  constructor(font: Font, text: string) {
    const { glyphs, n, advances } = font.glyphRun(text);
    this.unitsPerEm = font.unitsPerEm;
    this.advances = advances;
    this.kerning = font.kerningRanges(glyphs, n);
  }

  /** The number of code points of the text (lone surrogates count as code points). */
  len(): number {
    return this.advances.length - 1;
  }

  /** Whether the text is empty. */
  isEmpty(): boolean {
    return this.len() === 0;
  }

  /**
   * {@link Font.advanceUnits} of the code points `start..end` of the text. Throws a
   * `RangeError` unless `0 <= start <= end <= len()` (integers).
   */
  advanceUnits(start: number, end: number): number {
    if (!(Number.isInteger(start) && Number.isInteger(end) && 0 <= start && start <= end && end <= this.len())) {
      throw new RangeError(`code point range ${start}..${end} outside 0..${this.len()}`);
    }
    return this.advances[end] - this.advances[start] + this.kerning.adjustment(start, end);
  }

  /**
   * {@link Font.width} of the code points `start..end` at `size` px:
   * `advanceUnits(start, end) * size / unitsPerEm`, in exactly this order (bit-identical).
   */
  width(start: number, end: number, size: number): number {
    return (this.advanceUnits(start, end) * size) / this.unitsPerEm;
  }
}
