// Port of the unit tests of rust/crates/la-core/src/grid/regions.rs.
import { describe, expect, it } from "vitest";
import { P, Rect } from "../../src/geom/index.js";
import { GridSpec } from "../../src/grid/index.js";
import { type RegionFill, RegionMap, type SplitScratch } from "../../src/grid/regions.js";

const grid = (cols: number, rows: number): GridSpec => new GridSpec(0, 0, 1, cols, rows);

function rect(x0: number, y0: number, x1: number, y1: number, region: number): RegionFill {
  return { region, rings: [[new P(x0, y0), new P(x1, y0), new P(x1, y1), new P(x0, y1)]], evenOdd: false };
}

describe("grid::regions", () => {
  it("painting_and_borders", () => {
    // two regions side by side on open space, a third over part of the first, then an open hole
    const m = RegionMap.of(grid(10, 4), [
      rect(0, 0, 4, 4, 1),
      rect(4, 0, 8, 4, 2),
      rect(2, 0, 3, 2, 3),
      rect(6, 1, 7, 2, 0),
    ])!;
    expect(Array.from(m.ids.slice(0, 10))).toEqual([1, 1, 3, 1, 2, 2, 2, 2, 0, 0]);
    expect(Array.from(m.ids.slice(10, 20))).toEqual([1, 1, 3, 1, 2, 2, 0, 2, 0, 0]);
    expect(m.at(new P(2.5, 3.5))).toBe(1);
    expect(m.at(new P(-1, 1))).toBe(0);
    const s: SplitScratch = { ids: [], areas: [] };
    // a box inside region 1 (no border cell): one region
    let b = m.split(new Rect(0, 2, 2, 4), 1, s);
    expect(b.area).toBe(4);
    expect(b.straddle()).toBe(0);
    expect(b.foreign).toBe(0);
    // half in 1, half in 2: the straddle is the box's area, the foreign part half of it
    b = m.split(new Rect(3, 2, 5, 4), 1, s);
    expect(b.area).toBe(4);
    expect(Math.abs(b.straddle() - 4)).toBeLessThan(1e-12);
    expect(b.foreign).toBe(2);
    // half in 2, half open: nothing foreign for an item at home in 2
    b = m.split(new Rect(7, 2, 9, 3), 2, s);
    expect(b.foreign).toBe(0);
    expect(Math.abs(b.straddle() - 2)).toBeLessThan(1e-12);
    // fractional overlap: a quarter of a cell of region 2 under a box in region 1
    b = m.split(new Rect(3, 2, 4.5, 2.5), 1, s);
    expect(Math.abs(b.area - 0.75)).toBeLessThan(1e-12);
    expect(Math.abs(b.foreign - 0.25)).toBeLessThan(1e-12);
    const want = (4 * 0.5 * 0.25) / 0.75;
    expect(Math.abs(b.straddle() - want)).toBeLessThan(1e-12);
    // leaders: 1 → 3 → 1 → 2 → open along row 0
    expect(m.crossings([new P(0.5, 0.5), new P(9.5, 0.5)])).toBe(4);
    expect(m.crossings([new P(0.5, 3.5), new P(1.5, 3.5)])).toBe(0);
    expect(m.crossings([new P(0.5, 3.5)])).toBe(0);
  });

  it("home_falls_back_to_the_regions_under_the_mark", () => {
    let m = RegionMap.of(grid(10, 10), [rect(0, 0, 4, 10, 1), rect(6, 0, 10, 10, 2)])!;
    expect(m.home(new P(1.5, 5), new Rect(1, 4.5, 2, 5.5))).toBe(1);
    // open at the point: the mark's box grown by a cell reaches 4 cells of region 1
    // (column 3) and none of region 2
    expect(m.home(new P(4.5, 5), new Rect(4.2, 4.8, 4.8, 5.2))).toBe(1);
    // in the middle: equal counts, the lower region
    expect(m.home(new P(5, 5), new Rect(4.5, 4.5, 5.5, 5.5))).toBe(1);
    // far from everything
    m = RegionMap.of(grid(10, 10), [rect(0, 0, 2, 2, 1)])!;
    expect(m.home(new P(8, 8), new Rect(7.5, 7.5, 8.5, 8.5))).toBe(0);
  });

  it("fill_rules", () => {
    const ring = (x0: number, y0: number, x1: number, y1: number): P[] => [new P(x0, y0), new P(x1, y0), new P(x1, y1), new P(x0, y1)];
    // a hole wound like the outer ring: kept by non-zero, cut by even-odd
    const rings = [ring(0, 0, 6, 6), ring(2, 2, 4, 4)];
    const nz = RegionMap.of(grid(6, 6), [{ region: 1, rings, evenOdd: false }])!;
    expect(nz.ids[2 * 6 + 2]).toBe(1);
    const eo = RegionMap.of(grid(6, 6), [{ region: 1, rings, evenOdd: true }])!;
    expect(eo.ids[2 * 6 + 2]).toBe(0);
    expect(eo.ids[0]).toBe(1);
  });

  it("no_fills_no_map", () => {
    expect(RegionMap.of(grid(4, 4), [])).toBeNull();
  });
});
