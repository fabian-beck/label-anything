// The character map (`cmap` formats 4 and 12), flattened for constant-time lookups.
//
// Semantics shared with the Rust implementation:
// * One subtable is used: the first record with the best (platform, encoding) of
//   (3,10), (0,4), (3,1), (0,3) whose subtable has format 4 or 12.
// * Segments (format 4) and groups (format 12) are stably sorted by their start code; a
//   code point is mapped by the first one in that order that contains it.
// * Glyph ids >= numGlyphs and unmapped code points map to glyph 0.
import { Malformed, type Reader } from "./reader.js";

/** (platform, encoding) pairs in order of preference. */
const PREFERENCE: readonly (readonly [number, number])[] = [
  [3, 10],
  [0, 4],
  [3, 1],
  [0, 3],
];

/** Code point → glyph id. */
export class CharMap {
  /** Glyph of every BMP code point. */
  private readonly bmp = new Uint16Array(0x10000);
  /** Sorted, disjoint runs above U+FFFF: `starts[i] ↦ glyphs[i]`, `starts[i] + 1 ↦ glyphs[i] + 1`, … */
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];
  private readonly glyphs: number[] = [];

  private constructor() {}

  /** Parses the `cmap` table; `null` if it has no usable Unicode subtable. */
  static parse(cmap: Reader, numGlyphs: number): CharMap | null {
    let best: { rank: number; subtable: Reader } | null = null;
    const records = cmap.u16(2);
    for (let record = 0; record < records; record++) {
      const at = 4 + 8 * record;
      const platform = cmap.u16(at);
      const encoding = cmap.u16(at + 2);
      const rank = PREFERENCE.findIndex(([p, e]) => p === platform && e === encoding);
      if (rank < 0) continue;
      const subtable = cmap.tail(cmap.u32(at + 4));
      const format = subtable.u16(0);
      if ((format === 4 || format === 12) && (best === null || rank < best.rank)) best = { rank, subtable };
    }
    if (best === null) return null;
    const map = new CharMap();
    if (best.subtable.u16(0) === 4) map.parseFormat4(best.subtable, numGlyphs);
    else map.parseFormat12(best.subtable, numGlyphs);
    return map;
  }

  /** The glyph of a code point (0 if unmapped). */
  glyph(cp: number): number {
    if (cp < 0x10000) return this.bmp[cp];
    let lo = 0;
    let hi = this.ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ends[mid] < cp) lo = mid + 1;
      else hi = mid;
    }
    return lo < this.ends.length && this.starts[lo] <= cp ? this.glyphs[lo] + (cp - this.starts[lo]) : 0;
  }

  private parseFormat4(sub: Reader, numGlyphs: number): void {
    const length = Math.min(sub.u16(2), sub.length);
    const segCount = sub.u16(6) >>> 1;
    const ends = 14;
    const starts = 16 + 2 * segCount;
    const deltas = 16 + 4 * segCount;
    const rangeOffsets = 16 + 6 * segCount;
    const glyphIds = 16 + 8 * segCount;
    if (length < glyphIds) throw new Malformed();
    const glyphIdCount = (length - glyphIds) >>> 1;
    const segments: [start: number, end: number, delta: number, rangeOffset: number, index: number][] = [];
    for (let i = 0; i < segCount; i++) {
      const start = sub.u16(starts + 2 * i);
      const end = sub.u16(ends + 2 * i);
      if (start <= end) segments.push([start, end, sub.u16(deltas + 2 * i), sub.u16(rangeOffsets + 2 * i), i]);
    }
    segments.sort((a, b) => a[0] - b[0]);
    let nextFree = 0; // code points below are mapped by an earlier segment
    for (const [start, end, delta, rangeOffset, i] of segments) {
      for (let cp = Math.max(start, nextFree); cp <= end; cp++) {
        let glyph: number;
        if (rangeOffset === 0) {
          glyph = (cp + delta) & 0xffff;
        } else {
          // Index into glyphIdArray, as in the OpenType spec's pointer arithmetic.
          const index = (rangeOffset >>> 1) + i + cp - start - segCount;
          if (index >= 0 && index < glyphIdCount) {
            const id = sub.u16(glyphIds + 2 * index);
            glyph = id === 0 ? 0 : (id + delta) & 0xffff;
          } else {
            glyph = 0;
          }
        }
        this.bmp[cp] = glyph < numGlyphs ? glyph : 0;
      }
      nextFree = Math.max(nextFree, end + 1);
    }
  }

  private parseFormat12(table: Reader, numGlyphs: number): void {
    const sub = table.slice(0, Math.min(table.u32(4), table.length));
    const count = sub.u32(12);
    sub.checkArray(16, count, 12);
    const groups: [start: number, end: number, glyph: number][] = [];
    for (let k = 0; k < count; k++) {
      const at = 16 + 12 * k;
      const start = sub.u32(at);
      const end = Math.min(sub.u32(at + 4), 0x10ffff);
      if (start <= end) groups.push([start, end, sub.u32(at + 8)]);
    }
    groups.sort((a, b) => a[0] - b[0]);
    let nextFree = 0;
    for (const [start, end, startGlyph] of groups) {
      const glyphOf = (cp: number): number => startGlyph + (cp - start);
      let first = Math.max(start, nextFree);
      for (let cp = first, last = Math.min(end, 0xffff); cp <= last; cp++) {
        const glyph = glyphOf(cp);
        this.bmp[cp] = glyph < numGlyphs ? glyph : 0;
      }
      first = Math.max(first, 0x10000);
      if (first <= end && glyphOf(first) < numGlyphs) {
        const glyph = glyphOf(first);
        this.starts.push(first);
        this.ends.push(Math.min(end, first + (numGlyphs - glyph) - 1));
        this.glyphs.push(glyph);
      }
      nextFree = Math.max(nextFree, end + 1);
    }
  }
}
