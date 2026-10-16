// Port of the unit tests of rust/crates/la-core/src/grid/raster.rs.
import { describe, expect, it } from "vitest";
import { P } from "../../src/geom/index.js";
import { Shape } from "../../src/geom/shape.js";
import { GridSpec } from "../../src/grid/index.js";
import { MaskRaster } from "../../src/grid/raster.js";

function g(cols: number, rows: number, cell: number): GridSpec {
  return new GridSpec(0, 0, cell, cols, rows);
}

function total(cov: Uint8Array): number {
  let s = 0;
  for (const v of cov) s += v / 255;
  return s;
}

describe("grid::raster", () => {
  it("rect_coverage_exact_on_cells", () => {
    const m = new MaskRaster(g(10, 10, 2));
    m.rect(2, 2, 6, 4);
    const cov = m.intoCoverage();
    expect(cov[11]).toBe(255);
    expect(cov[12]).toBe(255);
    expect(cov[10]).toBe(0);
    // area 8 px² = 2 cells
    expect(Math.abs(total(cov) - 2)).toBeLessThan(0.05);
  });

  it("disc_area_close", () => {
    const m = new MaskRaster(g(40, 40, 1));
    m.disc(new P(20, 20), 10);
    const a = total(m.intoCoverage());
    const exact = Math.PI * 100;
    expect(Math.abs(a - exact) / exact).toBeLessThan(0.03);
  });

  it("thin_line_is_touched", () => {
    const m = new MaskRaster(g(10, 10, 4));
    m.capsule(new P(0.5, 13), new P(39, 13.3), 0.01);
    const cov = m.intoCoverage();
    for (let c = 0; c < 10; c++) expect(cov[3 * 10 + c]).toBeGreaterThanOrEqual(1);
  });

  it("capsule_area", () => {
    const m = new MaskRaster(g(60, 60, 1));
    m.capsule(new P(10, 10), new P(50, 40), 3);
    const a = total(m.intoCoverage());
    const exact = 50 * 6 + Math.PI * 9;
    expect(Math.abs(a - exact) / exact).toBeLessThan(0.05);
  });

  it("polygon_rules", () => {
    const outer = [new P(0, 0), new P(20, 0), new P(20, 20), new P(0, 20)];
    const hole = [new P(5, 5), new P(15, 5), new P(15, 15), new P(5, 15)];
    let m = new MaskRaster(g(20, 20, 1));
    m.polygon([outer, hole], true);
    let a = total(m.intoCoverage());
    expect(Math.abs(a - 300)).toBeLessThan(25);
    const rev = hole.slice().reverse();
    m = new MaskRaster(g(20, 20, 1));
    m.polygon([outer, rev], false);
    a = total(m.intoCoverage());
    expect(Math.abs(a - 300)).toBeLessThan(25);
  });

  it("far_outside_segments_are_clipped", () => {
    // Segments reaching far outside the grid are clipped first and touch the same cells
    // as their part near the grid.
    const touched = (segs: [P, P][]): Uint8Array => {
      const m = new MaskRaster(g(10, 10, 1));
      for (const [a, b] of segs) m.touchSegment(a, b);
      return m.intoCoverage();
    };
    const far = touched([
      [new P(-1e15, 5.5), new P(1e15, 5.5)],
      [new P(3.5, -1e300), new P(3.5, 1e300)],
      [new P(-1e12, -1e12 + 0.5), new P(1e12, 1e12 + 0.5)],
    ]);
    const near = touched([
      [new P(-1.5, 5.5), new P(11.5, 5.5)],
      [new P(3.5, -1.5), new P(3.5, 11.5)],
      [new P(-1.75, -1.25), new P(11.75, 12.25)],
    ]);
    expect(far).toEqual(near);
    for (let c = 0; c < 10; c++) {
      expect(far[5 * 10 + c]).toBe(1);
      expect(far[c * 10 + 3]).toBe(1);
    }
    // entirely outside, or with a non-finite endpoint: nothing
    const none = touched([
      [new P(-1e9, -5), new P(1e9, -5)],
      [new P(-Infinity, 5), new P(5, 5)],
      [new P(NaN, 5), new P(5, 5)],
    ]);
    expect(none.every((v) => v === 0)).toBe(true);
  });

  it("union_is_or", () => {
    const m = new MaskRaster(g(4, 4, 4));
    m.rect(0, 0, 2, 4);
    m.rect(2, 0, 4, 4);
    m.rect(0, 0, 4, 4);
    const cov = m.intoCoverage();
    expect(cov[0]).toBe(255);
  });

  it("shapes_and_large_polygons", () => {
    // curved shapes go through their outline; a polygon with many edges uses the
    // merge sorts (more than 32 edges and crossings per row)
    const m = new MaskRaster(g(50, 50, 1));
    m.shape(Shape.ellipse(new P(25, 25), 20, 10, 30));
    const a = total(m.intoCoverage());
    expect(Math.abs(a - Math.PI * 200) / (Math.PI * 200)).toBeLessThan(0.03);
    const comb: P[] = [];
    for (let i = 0; i < 40; i++) {
      comb.push(new P(i + 0.25, 1));
      comb.push(new P(i + 0.75, 49));
    }
    comb.push(new P(40, 49.5));
    comb.push(new P(0, 49.5));
    const p = new MaskRaster(g(50, 50, 1));
    p.polygon([comb], true);
    const q = new MaskRaster(g(50, 50, 1));
    q.polygon([comb], false);
    const ce = p.intoCoverage();
    const cn = q.intoCoverage();
    expect(total(ce)).toBeGreaterThan(500);
    expect(cn).toEqual(ce); // a simple polygon: both fill rules agree
  });
});
