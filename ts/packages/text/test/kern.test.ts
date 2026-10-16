// Kerning ranges (`Kerning.ranges`) against the walk over every range, as the unit tests of
// rust/crates/la-text/src/kern.rs.
import { describe, expect, it } from "vitest";
import { ClassPairs, GlyphPairs, Kerning, LookupBuilder } from "../src/kern.js";

/** mulberry32: deterministic pseudo-random numbers `0 <= x < n` for the property tests. */
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

/**
 * Random marks and 1–4 lookups (IgnoreMarks or not) of 1–3 subtables each: explicit pairs or
 * class pairs (including classes beyond the class count), skipping their second glyph or not.
 * Few glyphs and dense tables give long runs of skipping pairs.
 */
function randomKerning(below: (n: number) => number, numGlyphs: number): Kerning {
  const marks = Uint8Array.from({ length: numGlyphs }, () => (below(4) === 0 ? 1 : 0));
  const lookups = [];
  for (let l = 1 + below(4); l > 0; l--) {
    const builder = new LookupBuilder(numGlyphs);
    for (let st = 1 + below(3); st > 0; st--) {
      const skipSecond = below(2) === 0;
      const slots: [number, number][] = [];
      if (below(2) === 0) {
        const sets: number[] = [];
        const seconds: number[] = [];
        const deltas: number[] = [];
        for (let first = 0; first < numGlyphs; first++) {
          if (below(3) === 0) continue;
          const start = seconds.length;
          for (let second = 0; second < numGlyphs; second++) {
            if (below(2) === 0) {
              seconds.push(second);
              deltas.push(below(201) - 100);
            }
          }
          slots.push([first, sets.length / 2]);
          sets.push(start, seconds.length);
        }
        const subtable = new GlyphPairs(
          skipSecond,
          Uint32Array.from(sets),
          Uint16Array.from(seconds),
          Int32Array.from(deltas),
        );
        builder.pushSubtable(subtable, slots);
      } else {
        const class1Count = 1 + below(3);
        const class2Count = 1 + below(3);
        const classes = Uint16Array.from({ length: numGlyphs }, () => below(class2Count + 1));
        for (let first = 0; first < numGlyphs; first++) if (below(3) !== 0) slots.push([first, below(class1Count)]);
        const deltas = Int32Array.from({ length: class1Count * class2Count }, () => below(201) - 100);
        builder.pushSubtable(new ClassPairs(skipSecond, classes, class2Count, deltas), slots);
      }
    }
    const lookup = builder.finish(below(2) === 0);
    if (lookup !== null) lookups.push(lookup);
  }
  return new Kerning(marks, lookups);
}

/** The runs of skipping pairs of the tracks of a `KerningRanges` (for the coverage check). */
type Inspectable = { tracks: { runs: Uint32Array }[] };

describe("kerning ranges", () => {
  it("ranges equal the walk over every range", () => {
    const below = random(0x9e3779b9);
    let skipping = 0;
    let longRuns = 0;
    for (let k = 0; k < 400; k++) {
      const numGlyphs = 2 + below(6);
      const kerning = randomKerning(below, numGlyphs);
      for (let r = 0; r < 8; r++) {
        const len = below(25);
        const glyphs = Uint16Array.from({ length: len }, () => below(numGlyphs));
        const ranges = kerning.ranges(glyphs, len);
        for (const { runs } of (ranges as unknown as Inspectable).tracks) {
          if (runs.length === 0) continue;
          skipping++;
          for (let t = 1; t < runs.length; t++) if (runs[t] !== 0xffffffff && runs[t] + 1 < t) longRuns++;
        }
        for (let start = 0; start <= len; start++) {
          for (let end = start; end <= len; end++) {
            const got = ranges.adjustment(start, end);
            const expected = kerning.adjustment(glyphs.subarray(start, end), end - start);
            if (got !== expected) expect.fail(`glyphs ${glyphs}, range ${start}..${end}: ${got} != ${expected}`);
          }
        }
      }
    }
    // the cases exercise walks with skipped glyphs, including runs of 3+ skipping pairs
    expect(skipping).toBeGreaterThan(500);
    expect(longRuns).toBeGreaterThan(500);
  });

  it("ranges without kerning", () => {
    const kerning = new Kerning(new Uint8Array(4), []);
    const ranges = kerning.ranges(Uint16Array.of(1, 2, 3), 3);
    expect((ranges as unknown as Inspectable).tracks).toEqual([]);
    expect(ranges.adjustment(0, 3)).toBe(0);
  });
});
