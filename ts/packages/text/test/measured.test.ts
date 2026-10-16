// MeasuredText and FontMeasure against simple shaping and the callback, as the Rust tests in
// rust/crates/la-text/src/measured.rs and rust/crates/la-text/tests/measured.rs.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  balancedWrap,
  extraWrapVariants,
  Font,
  FontBook,
  greedyWrap,
  MeasuredText,
  truncateEnd,
  truncateMiddle,
  wrapVariants,
  type FontMeasure,
  type Truncate,
} from "../src/index.js";
import { codePoints } from "../src/unicode.js";

/**
 * Kerning pairs, combining marks (GDEF marks under IgnoreMarks), unmapped code points,
 * supplementary planes, white space and long class names; lone surrogates (JavaScript only).
 */
const TEXTS = [
  "",
  "A",
  "AVAVAV WAVY Typography",
  "To. Wa, Yo! L'F.P,Tr Ve LT LV AT Ty r. y,",
  "Té ÄV Wày ố ́x ééé",
  "́̂Á́V́",
  "Crème brûlée à la carte",
  "ΑθήναΚαι Москва",
  "中文x\u{1F600}yकि\ttab nbsp",
  "com.facebook.react.uimanager.layoutanimation.LayoutAnimationController$1",
  "org.springframework.beans.factory.support.DefaultListableBeanFactory",
  "XMLHttpRequestFactory std::collections::HashMap<String, Vec<u8>>",
  "A\ud800V\udc00A\udc00\ud800V",
];

/** UTF-16 offset of every code point of `text`, plus its length. */
function offsetsOf(text: string): number[] {
  const offsets = [0];
  for (const cp of codePoints(text)) offsets.push(offsets[offsets.length - 1] + (cp > 0xffff ? 2 : 1));
  return offsets;
}

/** Checks every range of `text` against `font.advanceUnits` and `font.width` at `sizes`. */
function checkRanges(font: Font, text: string, sizes: readonly number[]): void {
  const measured = new MeasuredText(font, text);
  const offsets = offsetsOf(text);
  expect(measured.len()).toBe(offsets.length - 1);
  for (let start = 0; start < offsets.length; start++) {
    for (let end = start; end < offsets.length; end++) {
      const s = text.slice(offsets[start], offsets[end]);
      const units = measured.advanceUnits(start, end);
      if (units !== font.advanceUnits(s)) expect.fail(`${JSON.stringify(s)}: ${units} != ${font.advanceUnits(s)}`);
      for (const size of sizes) {
        const [got, expected] = [measured.width(start, end, size), font.width(s, size)];
        if (!Object.is(got, expected)) expect.fail(`${JSON.stringify(s)} at ${size}: ${got} != ${expected}`);
      }
    }
  }
}

describe("MeasuredText", () => {
  const book = FontBook.withBundled();
  const regular = book.font(book.resolve("default", 400, false));

  it("every range equals simple shaping", () => {
    for (const font of [regular, book.font(book.resolve("default", 700, false))]) {
      for (const text of TEXTS) checkRanges(font, text, [1, 10, 12, 16.5]);
    }
  });

  it("empty text", () => {
    const measured = new MeasuredText(regular, "");
    expect(measured.isEmpty()).toBe(true);
    expect(measured.advanceUnits(0, 0)).toBe(0);
  });

  it("reversed range throws", () => {
    expect(() => new MeasuredText(regular, "AV").advanceUnits(2, 1)).toThrow(RangeError);
  });

  it("range past the end throws", () => {
    expect(() => new MeasuredText(regular, "AV").advanceUnits(0, 3)).toThrow(RangeError);
    expect(() => new MeasuredText(regular, "AV").advanceUnits(0.5, 1)).toThrow(RangeError);
  });
});

/**
 * The code points the synthetic fonts map (and a few they do not): kerned letters, the
 * combining acute (a GDEF mark), space, period, Greek Alpha, supplementary-plane glyphs.
 */
const ALPHABET = ["A", "B", "C", "T", "V", "a", "o", "y", ".", " ", "́", "Α", "\u{1F600}", "\u{10400}", "z"];

const fontDir = fileURLToPath(new URL("../../../../conformance/text/fonts/", import.meta.url));

/** The synthetic fonts of conformance/text/fonts/ (marks, IgnoreMarks and other lookup flags,
 * pairs that skip their second glyph, legacy `kern` tables, CFF, a collection). */
function syntheticFonts(): [string, Font][] {
  return readdirSync(fontDir)
    .sort()
    .map((file) => [file, Font.fromBytes(readFileSync(join(fontDir, file)))]);
}

/** mulberry32: deterministic pseudo-random numbers `0 <= x < n`. */
function random(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

/** Mostly kerned letters ("ToToTo" chains skipping pairs), with marks and spaces. */
function randomText(below: (n: number) => number, maxLen: number): string {
  let text = "";
  for (let len = below(maxLen + 1); len > 0; len--) {
    text += below(10) < 4 ? ["T", "o", "A", "V"][below(4)] : ALPHABET[below(ALPHABET.length)];
  }
  return text;
}

describe("MeasuredText with synthetic fonts", () => {
  const fonts = syntheticFonts();

  it("every range equals simple shaping", () => {
    expect(fonts.length).toBeGreaterThanOrEqual(5);
    const below = random(0x2545f491);
    for (const [, font] of fonts) {
      for (let k = 0; k < 300; k++) checkRanges(font, randomText(below, 16), [13.3]);
    }
  });

  it("font measure wraps like the callback", () => {
    const below = random(7);
    for (const [name, font] of fonts) {
      for (let k = 0; k < 100; k++) {
        const text = randomText(below, 24);
        const size = [9, 11, 13.3][below(3)];
        const callback = (s: string): number => font.width(s, size);
        const fast: FontMeasure = { font, size };
        const full = font.width(text, size);
        for (const w of [0, full * 0.2, full * 0.35, full * 0.5, full * 0.8, full + 1]) {
          const context = `${name}: ${JSON.stringify(text)} at ${w}`;
          expect(greedyWrap(text, w, fast), context).toEqual(greedyWrap(text, w, callback));
          expect(truncateEnd(text, w, fast), context).toEqual(truncateEnd(text, w, callback));
          for (let n = 1; n <= 3; n++) {
            for (const m of [null, w]) {
              expect(balancedWrap(text, n, m, fast), context).toEqual(balancedWrap(text, n, m, callback));
            }
            expect(truncateMiddle(text, w, n, fast), context).toEqual(truncateMiddle(text, w, n, callback));
            for (const truncate of ["none", "end", "middle"] as Truncate[]) {
              const opts = { maxWidth: w, maxLines: n, balance: n !== 2, truncate };
              // toEqual compares numbers with Object.is: bit-identical widths
              expect(wrapVariants(text, opts, fast), context).toEqual(wrapVariants(text, opts, callback));
            }
          }
        }
        expect(extraWrapVariants(text, 4, fast), `${name}: ${text}`).toEqual(extraWrapVariants(text, 4, callback));
      }
    }
  });
});
