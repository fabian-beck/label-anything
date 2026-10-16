import { codePoints, isBreakSpace, isCjk, isLower, isMark, isUpper } from "./unicode.js";

const isDigit = (cp: number | undefined): boolean => cp !== undefined && cp >= 0x30 && cp <= 0x39;

/** Code points after which a line may end when they are followed by something other than a mark. */
const BREAK_AFTER = new Set([..."/\\._-,;:|"].map((c) => c.charCodeAt(0)));

/** {@link breakOpportunities} of a text given as code points. */
export function breaksOf(cps: readonly number[]): number[] {
  const out: number[] = [];
  for (let k = 0; k + 1 < cps.length; k++) {
    const a = cps[k];
    const b = cps[k + 1];
    if (isMark(b)) continue;
    let breaks: boolean;
    if (isBreakSpace(a)) {
      breaks = true;
    } else if (BREAK_AFTER.has(a)) {
      const colons = a === 0x3a && b === 0x3a;
      const number = (a === 0x2e || a === 0x2c) && isDigit(cps[k - 1]) && isDigit(b);
      breaks = !colons && !number;
    } else {
      const next = cps[k + 2];
      breaks =
        (isLower(a) && isUpper(b)) ||
        (isUpper(a) && isUpper(b) && next !== undefined && isLower(next)) ||
        (isCjk(a) && isCjk(b));
    }
    if (breaks) out.push(k);
  }
  return out;
}

/**
 * Indices `k` (in code points) such that a line may end after code point `k`, ascending,
 * `0 <= k < n - 1` (the end of the text is not listed).
 *
 * A line may end between `a = text[k]` and `b = text[k + 1]`: never if `b` is a combining
 * mark; after white space other than the no-break spaces U+00A0, U+2007, U+202F; after
 * `/ \ . _ - , ; : |`, except between two colons (`::` breaks after the second) and after
 * `.` or `,` between two ASCII digits; between a Lowercase and an Uppercase code point
 * (camelCase); after `a` if `a` and `b` are Uppercase and `text[k + 2]` is Lowercase
 * (`XMLHttp` → `XML|Http`); between two CJK code points (U+2E80–9FFF, U+AC00–D7AF,
 * U+F900–FAFF, U+FF00–FFEF, U+20000–2FFFF).
 */
export function breakOpportunities(text: string): number[] {
  return breaksOf(codePoints(text));
}
