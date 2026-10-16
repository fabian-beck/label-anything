// Code point classes used by shaping selection and line breaking (spec §5.2–5.3).
import { COMBINING_MARKS } from "./generated/unicode-data.js";

/** Unicode `White_Space` (trimmed at line starts and ends). */
export function isSpace(cp: number): boolean {
  return (
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0x20 ||
    cp === 0x85 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/** `White_Space` except the no-break spaces U+00A0, U+2007 and U+202F: a line may end after it. */
export function isBreakSpace(cp: number): boolean {
  return isSpace(cp) && cp !== 0xa0 && cp !== 0x2007 && cp !== 0x202f;
}

/** Combining mark (General_Category Mn, Mc or Me, Unicode 15.1). */
export function isMark(cp: number): boolean {
  if (cp < 0x300) return false;
  let lo = 0;
  let hi = COMBINING_MARKS.length >> 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (COMBINING_MARKS[2 * mid + 1] < cp) lo = mid + 1;
    else hi = mid;
  }
  return lo < COMBINING_MARKS.length >> 1 && COMBINING_MARKS[2 * lo] <= cp;
}

/** CJK ideographs, syllables and full-width forms between which a line may break. */
export function isCjk(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x2ffff)
  );
}

const LOWERCASE = /^\p{Lowercase}$/u;
const UPPERCASE = /^\p{Uppercase}$/u;

/** Unicode `Lowercase` property. */
export function isLower(cp: number): boolean {
  if (cp < 0x80) return cp >= 0x61 && cp <= 0x7a;
  return LOWERCASE.test(String.fromCodePoint(cp));
}

/** Unicode `Uppercase` property. */
export function isUpper(cp: number): boolean {
  if (cp < 0x80) return cp >= 0x41 && cp <= 0x5a;
  return UPPERCASE.test(String.fromCodePoint(cp));
}

/** Code points of `text` (lone surrogates count as code points). */
export function codePoints(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) i++;
    out.push(cp);
  }
  return out;
}

/** Blocks whose scripts simple shaping cannot measure correctly (inclusive ranges). */
const COMPLEX_SCRIPTS: readonly (readonly [number, number])[] = [
  [0x0590, 0x08ff], // Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic (+ supplements, extensions)
  [0x0900, 0x0dff], // Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam, Sinhala
  [0x0e00, 0x109f], // Thai, Lao, Tibetan, Myanmar
  [0x1100, 0x11ff], // Hangul Jamo
  [0x1780, 0x18af], // Khmer, Mongolian
  [0x1cd0, 0x1cff], // Vedic Extensions
  [0xa8e0, 0xa8ff], // Devanagari Extended
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xa9e0, 0xa9ff], // Myanmar Extended-B
  [0xaa60, 0xaa7f], // Myanmar Extended-A
  [0xd7b0, 0xd7ff], // Hangul Jamo Extended-B
  [0x10ec0, 0x10eff], // Arabic Extended-C
  [0x11660, 0x1167f], // Mongolian Supplement
  [0x11b00, 0x11b5f], // Devanagari Extended-A
];

/**
 * Whether `text` contains code points of scripts that need full shaping: Hebrew, Arabic,
 * Syriac, Thaana, NKo (U+0590–08FF), Indic scripts and Sinhala (U+0900–0DFF), Thai, Lao,
 * Tibetan, Myanmar (U+0E00–109F), Hangul Jamo (U+1100–11FF), Khmer, Mongolian
 * (U+1780–18AF) and the extension blocks U+1CD0–1CFF, U+A8E0–A8FF, U+A960–A97F,
 * U+A9E0–A9FF, U+AA60–AA7F, U+D7B0–D7FF, U+10EC0–10EFF, U+11660–1167F, U+11B00–11B5F.
 *
 * This package only implements simple shaping, so such texts are measured with simple
 * shaping too; hosts that need exact widths for them can measure with their own shaper
 * (e.g. canvas `measureText`) and pass the widths in.
 */
export function needsComplexShaping(text: string): boolean {
  for (const cp of codePoints(text)) {
    if (cp < 0x0590) continue;
    for (const [start, end] of COMPLEX_SCRIPTS) if (cp >= start && cp <= end) return true;
  }
  return false;
}
