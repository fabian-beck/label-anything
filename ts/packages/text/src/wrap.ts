// Wrapping, balancing and truncation of text labels (spec §5.3), identical to the Rust
// crate `label-anything-text`.
//
// Every function takes a `measure` callback that returns the width of a string (e.g.
// `(s) => font.width(s, 12)`, or a host measurement such as canvas `measureText`), so the
// algorithms work with any font and size. Positions are code point indices. A line [s..e]
// is the text from code point s to e with trailing white space removed; the next line
// starts after e, skipping white space. Blank texts produce a single empty line.
//
// Searches assume that extending a line never makes it narrower: they scan candidates in
// ascending order and stop at the first one that does not fit, which for such widths is the
// same as taking the largest one that fits, but measures far fewer long lines.
import { breaksOf } from "./breaks.js";
import { codePoints, isMark, isSpace } from "./unicode.js";

const ELLIPSIS = "…";

/** Measures the width of a string. */
export type Measure = (text: string) => number;

/** How text that does not fit in `maxLines` lines of `maxWidth` is shortened. */
export type Truncate = "none" | "end" | "middle";

/** Wrap settings of a text label (`wrap` and `truncate` of the problem). */
export interface WrapOptions {
  /** Maximum line width; `null`/absent wraps only when `maxLines > 1` asks for it. */
  maxWidth?: number | null;
  /** Maximum number of lines (default: unlimited; values below 1 count as 1). */
  maxLines?: number;
  /** Offer balanced variants (default `true`; otherwise only the greedy wrap). */
  balance?: boolean;
  /** What happens when the text needs more than `maxLines` lines (default `"none"`). */
  truncate?: Truncate;
}

/** One way of laying out a text label. */
export interface TextVariant {
  /** The lines, top to bottom. */
  lines: string[];
  /** `measure(line)` of every line. */
  widths: number[];
  /** Whether text was replaced by `…`. */
  truncated: boolean;
}

/** A line as [first, last] code point indices (before trimming). */
type Span = readonly [number, number];

/** UTF-16 offset of every code point, plus the total length. */
function utf16Offsets(cps: readonly number[]): number[] {
  const offsets = [0];
  for (const cp of cps) offsets.push(offsets[offsets.length - 1] + (cp > 0xffff ? 2 : 1));
  return offsets;
}

/** A text prepared for wrapping: code points, break opportunities and cached widths. */
class Wrapper {
  private readonly cps: number[];
  /** UTF-16 offset of every code point, plus `text.length`. */
  private readonly offsets: number[];
  private readonly breaks: number[];
  private readonly widths = new Map<number, number>();

  constructor(
    private readonly text: string,
    private readonly measure: Measure,
  ) {
    this.cps = codePoints(text);
    this.offsets = utf16Offsets(this.cps);
    this.breaks = breaksOf(this.cps);
  }

  get length(): number {
    return this.cps.length;
  }

  /** First non-space code point at or after `i`. */
  skipSpaces(i: number): number {
    while (i < this.cps.length && isSpace(this.cps[i])) i++;
    return i;
  }

  /** The text of line [s..e] (trailing white space removed). */
  line(s: number, e: number): string {
    let end = e + 1;
    while (end > s && isSpace(this.cps[end - 1])) end--;
    return this.text.slice(this.offsets[s], this.offsets[end]);
  }

  private width(s: number, e: number): number {
    const key = s * (this.cps.length + 1) + e;
    let w = this.widths.get(key);
    if (w === undefined) {
      w = this.measure(this.line(s, e));
      this.widths.set(key, w);
    }
    return w;
  }

  /** Index of the first break opportunity `>= s`. */
  private firstBreak(s: number): number {
    let lo = 0;
    let hi = this.breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.breaks[mid] < s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Greedy wrap at width `w`: the rest of the text if it fits, else up to the last break
   * that fits before the first one that does not, else an emergency break. Stops after
   * `limit + 1` lines.
   */
  greedy(w: number, limit: number): Span[] {
    const n = this.cps.length;
    const lines: Span[] = [];
    let s = this.skipSpaces(0);
    while (s < n && lines.length <= limit) {
      let e: number;
      if (this.width(s, n - 1) <= w) {
        e = n - 1;
      } else {
        let end = -1;
        for (let i = this.firstBreak(s); i < this.breaks.length; i++) {
          const k = this.breaks[i];
          if (this.width(s, k) > w) break;
          end = k;
        }
        e = end >= 0 ? end : this.emergency(s, w);
      }
      lines.push([s, e]);
      s = this.skipSpaces(e + 1);
    }
    return lines;
  }

  /** Whether a line may end after code point `e` without splitting off combining marks. */
  private canEnd(e: number): boolean {
    return e + 1 >= this.cps.length || !isMark(this.cps[e + 1]);
  }

  /**
   * Emergency break inside the segment starting at `s` (no break opportunity fits): the last
   * end before the segment's end that fits (ascending, stopping at the first that does not),
   * else the shortest line.
   */
  private emergency(s: number, w: number): number {
    const i = this.firstBreak(s);
    const segmentEnd = i < this.breaks.length ? this.breaks[i] : this.cps.length - 1;
    let end = -1;
    for (let e = s; e < segmentEnd; e++) {
      if (!this.canEnd(e)) continue;
      if (this.width(s, e) > w) return end >= 0 ? end : e;
      end = e;
    }
    return end >= 0 ? end : segmentEnd;
  }

  /** Balanced wrap into at most `n` lines (spec §5.3). */
  balanced(n: number, maxWidth: number | null): Span[] {
    const len = this.cps.length;
    n = Math.max(1, Math.floor(n));
    const first = this.skipSpaces(0);
    if (first >= len) return [];
    const starts = [first];
    for (const k of this.breaks) {
      const s = this.skipSpaces(k + 1);
      if (s < len && starts[starts.length - 1] !== s) starts.push(s);
    }
    let candidates: number[] = [];
    for (const s of starts) {
      for (let i = this.firstBreak(s); i <= this.breaks.length; i++) {
        const k = i < this.breaks.length ? this.breaks[i] : len - 1;
        const w = this.width(s, k);
        if (maxWidth !== null && w > maxWidth) break;
        candidates.push(w);
      }
    }
    if (maxWidth !== null) {
      candidates.push(maxWidth);
      candidates = candidates.filter((w) => w <= maxWidth);
    }
    candidates = candidates.filter((w) => !Number.isNaN(w)).sort((a, b) => a - b);
    candidates = candidates.filter((w, i) => i === 0 || w !== candidates[i - 1]);
    if (candidates.length === 0) return this.greedy(maxWidth ?? Infinity, Infinity);
    let lo = 0;
    let hi = candidates.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.greedy(candidates[mid], n).length <= n) hi = mid;
      else lo = mid + 1;
    }
    const lines = this.greedy(candidates[lo], Infinity);
    return maxWidth !== null && lines.length > n ? this.greedy(maxWidth, Infinity) : lines;
  }

  /** The whole text as one line. */
  singleLine(): Span[] {
    const first = this.skipSpaces(0);
    return first < this.cps.length ? [[first, this.cps.length - 1]] : [];
  }

  /** The lines as strings; a blank text is one empty line. */
  strings(lines: readonly Span[]): string[] {
    return lines.length === 0 ? [""] : this.texts(lines);
  }

  texts(lines: readonly Span[]): string[] {
    return lines.map(([s, e]) => this.line(s, e));
  }

  variant(lines: string[], truncated: boolean): TextVariant {
    return { lines, widths: lines.map((line) => this.measure(line)), truncated };
  }
}

const sameLines = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((line, i) => line === b[i]);

/**
 * Greedy wrap: every line takes the rest of the text if it fits `maxWidth`, else extends to
 * the last break opportunity that fits; a segment wider than `maxWidth` is broken at the last
 * code point position that fits (never before a combining mark, at least one code point).
 */
export function greedyWrap(text: string, maxWidth: number, measure: Measure): string[] {
  const wrapper = new Wrapper(text, measure);
  return wrapper.strings(wrapper.greedy(maxWidth, Infinity));
}

/**
 * Balanced wrap into at most `nLines` lines: `greedyWrap` at the smallest candidate width
 * (the widths of the lines between break opportunities, and `maxWidth`; only those
 * `<= maxWidth`) that needs at most `nLines` lines, found by binary search. If even
 * `maxWidth` needs more lines, the result is `greedyWrap(text, maxWidth)`.
 */
export function balancedWrap(
  text: string,
  nLines: number,
  maxWidth: number | null | undefined,
  measure: Measure,
): string[] {
  const wrapper = new Wrapper(text, measure);
  return wrapper.strings(wrapper.balanced(nLines, maxWidth ?? null));
}

/**
 * Shortens `text` with a trailing `…` to fit `maxWidth`: the longest code point prefix (not
 * separated from its combining marks, trailing white space removed; lengths are tried in
 * ascending order up to the first that does not fit) such that `prefix + "…"` fits; `"…"` if
 * none does. A text that fits is returned unchanged.
 */
export function truncateEnd(text: string, maxWidth: number, measure: Measure): string {
  if (measure(text) <= maxWidth) return text;
  const cps = codePoints(text);
  const offsets = utf16Offsets(cps);
  let best = ELLIPSIS;
  for (let keep = 1; keep < cps.length; keep++) {
    if (isMark(cps[keep])) continue;
    let end = keep;
    while (end > 0 && isSpace(cps[end - 1])) end--;
    const candidate = text.slice(0, offsets[end]) + ELLIPSIS;
    if (measure(candidate) > maxWidth) break;
    best = candidate;
  }
  return best;
}

/** `text` without leading and trailing white space. */
function trimSpaces(text: string): string {
  const cps = codePoints(text);
  const offsets = utf16Offsets(cps);
  let start = 0;
  let end = cps.length;
  while (start < end && isSpace(cps[start])) start++;
  while (end > start && isSpace(cps[end - 1])) end--;
  return text.slice(offsets[start], offsets[end]);
}

/**
 * Replaces the middle of `text` (trimmed) with `…` so that its greedy wrap at `maxWidth` has
 * at most `maxLines` lines, removing the fewest code points `r >= 1` (binary search): the
 * left part keeps `ceil((n - r) / 2)` code points, the right part `floor((n - r) / 2)`, both
 * shrunk so that no base is separated from its combining marks, with the white space next to
 * `…` removed. Returns the wrapped lines; a text that fits is only wrapped.
 */
export function truncateMiddle(text: string, maxWidth: number, maxLines: number, measure: Measure): string[] {
  maxLines = Math.max(1, Math.floor(maxLines));
  const trimmed = trimSpaces(text);
  const full = new Wrapper(trimmed, measure);
  const fullLines = full.greedy(maxWidth, Infinity);
  if (fullLines.length <= maxLines) return full.strings(fullLines);
  const cps = codePoints(trimmed);
  const offsets = utf16Offsets(cps);
  const n = cps.length;
  const candidate = (removed: number): string => {
    const keep = n - removed;
    let left = Math.ceil(keep / 2);
    while (left > 0 && isMark(cps[left])) left--;
    let right = n - Math.floor(keep / 2);
    while (right < n && isMark(cps[right])) right++;
    while (left > 0 && isSpace(cps[left - 1])) left--;
    while (right < n && isSpace(cps[right])) right++;
    return trimmed.slice(0, offsets[left]) + ELLIPSIS + trimmed.slice(offsets[right]);
  };
  let lo = 1;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (new Wrapper(candidate(mid), measure).greedy(maxWidth, maxLines).length <= maxLines) hi = mid;
    else lo = mid + 1;
  }
  const result = new Wrapper(candidate(lo), measure);
  return result.strings(result.greedy(maxWidth, Infinity));
}

/**
 * The layout variants of a text label with wrap settings (spec §5.3 "Variants").
 *
 * `L_min` is the line count of the greedy wrap at `maxWidth` (1 without `maxWidth`). If
 * `L_min <= maxLines`: the balanced wraps into `L_min ..= min(L_min + 2, maxLines)` lines
 * (only the greedy wrap if `balance` is false), without duplicates. Otherwise the text is
 * truncated: `"end"` keeps the first `maxLines - 1` greedy lines and shortens the rest of
 * the text into the last line ({@link truncateEnd}), `"middle"` uses {@link truncateMiddle},
 * and `"none"` keeps the greedy lines (more than `maxLines`, `truncated: false`).
 */
export function wrapVariants(text: string, opts: WrapOptions, measure: Measure): TextVariant[] {
  const wrapper = new Wrapper(text, measure);
  const maxWidth = opts.maxWidth ?? null;
  const maxLines = Math.max(1, Math.floor(opts.maxLines ?? Infinity));
  const truncate = opts.truncate ?? "none";
  const greedy = maxWidth === null ? wrapper.singleLine() : wrapper.greedy(maxWidth, Infinity);
  const lMin = Math.max(greedy.length, 1);
  if (lMin <= maxLines) {
    if (opts.balance === false) return [wrapper.variant(wrapper.strings(greedy), false)];
    const variants: TextVariant[] = [];
    for (let n = lMin; n <= Math.min(lMin + 2, maxLines); n++) {
      const lines = wrapper.strings(wrapper.balanced(n, maxWidth));
      if (variants.every((v) => !sameLines(v.lines, lines))) variants.push(wrapper.variant(lines, false));
    }
    return variants;
  }
  if (maxWidth === null || truncate === "none") return [wrapper.variant(wrapper.strings(greedy), false)];
  let lines: string[];
  if (truncate === "end") {
    lines = wrapper.texts(greedy.slice(0, maxLines - 1));
    const restStart = greedy[maxLines - 1][0];
    lines.push(truncateEnd(wrapper.line(restStart, wrapper.length - 1), maxWidth, measure));
  } else {
    lines = truncateMiddle(text, maxWidth, maxLines, measure);
  }
  return [wrapper.variant(lines, true)];
}

/**
 * Extra variants for the `wrap` ladder step of labels without wrap settings: the balanced
 * wraps into `2 ..= maxLines` lines, without duplicates and without single-line results.
 */
export function extraWrapVariants(text: string, maxLines: number, measure: Measure): TextVariant[] {
  const wrapper = new Wrapper(text, measure);
  const variants: TextVariant[] = [];
  // No wrap has more lines than code points, so larger counts only repeat variants.
  for (let n = 2; n <= Math.min(maxLines, wrapper.length); n++) {
    const spans = wrapper.balanced(n, null);
    if (spans.length < 2) continue;
    const lines = wrapper.strings(spans);
    if (variants.every((v) => !sameLines(v.lines, lines))) variants.push(wrapper.variant(lines, false));
  }
  return variants;
}
