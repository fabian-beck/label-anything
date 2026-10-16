// Port of the unit tests of rust/crates/la-core/src/grid/mod.rs.
import { describe, expect, it } from "vitest";
import { Rect } from "../../src/geom/index.js";
import { GridSpec, Sat, quantize } from "../../src/grid/index.js";

function spec(cols: number, rows: number, cell: number): GridSpec {
  return new GridSpec(0, 0, cell, cols, rows);
}

describe("grid", () => {
  it("sat_blocks_and_integral", () => {
    const g = spec(4, 3, 2);
    const cov = new Uint8Array(12);
    cov[5] = 255; // col 1, row 1 -> canvas [2,4]x[2,4]
    cov[6] = 100; // col 2, row 1
    const sat = Sat.fromCoverage(4, 3, cov);
    expect(sat.block(0, 4, 0, 3)).toBe(355);
    expect(sat.cell(1, 1)).toBe(255);
    // full cell
    let a = sat.coveredArea(g, new Rect(2, 2, 4, 4));
    expect(Math.abs(a - 4)).toBeLessThan(1e-12);
    // half of cell (1,1)
    a = sat.coveredArea(g, new Rect(3, 2, 4, 4));
    expect(Math.abs(a - 2)).toBeLessThan(1e-12);
    // quarter of (1,1) and quarter of (2,1) with 100/255
    a = sat.coveredArea(g, new Rect(3, 3, 5, 4));
    expect(Math.abs(a - (1 + 100 / 255))).toBeLessThan(1e-12);
    // rect spanning many cells
    a = sat.coveredArea(g, new Rect(-10, -10, 100, 100));
    expect(Math.abs(a - (4 + (4 * 100) / 255))).toBeLessThan(1e-9);
    expect(sat.any(g, new Rect(3.9, 3.9, 4, 4))).toBe(true);
    expect(sat.any(g, new Rect(0, 0, 2, 2))).toBe(false);
    // touching the covered cell only on its edge is not "any"
    expect(sat.any(g, new Rect(0, 2, 2, 4))).toBe(false);
  });

  it("integral_matches_brute_force", () => {
    const g = spec(7, 5, 1.5);
    const cov = new Uint8Array(35);
    for (let i = 0; i < cov.length; i++) cov[i] = (i * 37) % 256;
    const sat = Sat.fromCoverage(7, 5, cov);
    const rects = [new Rect(0.3, 0.2, 9.1, 6.9), new Rect(1.5, 1.5, 3, 3), new Rect(2.2, 0, 2.9, 7.5), new Rect(-3, 4, 4, 4.4)];
    for (const r of rects) {
      let brute = 0;
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 7; col++) {
          const cr = g.cellRect(col, row);
          brute += (cr.overlapArea(r) / (1.5 * 1.5)) * cov[row * 7 + col]!;
        }
      }
      const v = sat.integral(g, r);
      expect(Math.abs(v - brute)).toBeLessThan(1e-9);
    }
  });

  it("quantize_never_zero_for_positive", () => {
    expect(quantize(0)).toBe(0);
    expect(quantize(1e-9)).toBe(1);
    expect(quantize(1)).toBe(255);
    expect(quantize(0.5)).toBe(128);
  });

  it("grid_spec_helpers", () => {
    const g = GridSpec.covering(new Rect(10, 20, 31, 29), 4);
    expect([g.cols, g.rows, g.cells()]).toEqual([6, 3, 18]);
    expect(g.extent().eq(new Rect(10, 20, 34, 32))).toBe(true);
    expect(g.cellCenter(1, 2).x).toBe(16);
    expect(g.toCell(g.cellCenter(1, 2))).toEqual([1.5, 2.5]);
    expect(g.cellRange(new Rect(14, 20, 18.5, 23))).toEqual([1, 3, 0, 1]);
    expect(g.cellRange(new Rect(-100, -100, -50, -50))).toEqual([0, 0, 0, 0]);
    expect(GridSpec.covering(new Rect(0, 0, 0, 0), 4).cells()).toBe(1);
    // the wrapping u32 sums stay exact for differences
    const big = new Uint8Array(4200 * 4200).fill(255);
    const sat = Sat.fromCoverage(4200, 4200, big);
    expect(sat.block(0, 4200, 0, 4200)).toBe((4200 * 4200 * 255) % 2 ** 32); // wrapped
    expect(sat.block(100, 200, 100, 300)).toBe(100 * 200 * 255);
  });
});
