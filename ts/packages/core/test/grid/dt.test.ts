// Port of the unit tests of rust/crates/la-core/src/grid/dt.rs.
import { describe, expect, it } from "vitest";
import { P } from "../../src/geom/index.js";
import { distanceTransform, dtMaxima } from "../../src/grid/dt.js";
import { GridSpec } from "../../src/grid/index.js";

describe("grid::dt", () => {
  it("matches_brute_force", () => {
    const g = new GridSpec(0, 0, 2, 13, 9);
    const occ: boolean[] = [];
    for (let i = 0; i < g.cells(); i++) occ.push(i % 17 === 3 || i === 50);
    const dt = distanceTransform(g, (i) => occ[i]!);
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        let best = Infinity;
        for (let j = 0; j < occ.length; j++) {
          if (occ[j]) {
            const cr = Math.trunc(j / g.cols);
            const cc = j % g.cols;
            const dx = c - cc;
            const dy = r - cr;
            best = Math.min(best, Math.sqrt(dx * dx + dy * dy));
          }
        }
        const v = dt[r * g.cols + c]!;
        expect(Math.abs(v - best * 2)).toBeLessThan(1e-9);
      }
    }
  });

  it("empty_grid_is_far", () => {
    const g = new GridSpec(0, 0, 1, 4, 3);
    const dt = distanceTransform(g, () => false);
    expect(dt.every((v) => v >= 1e9)).toBe(true);
  });

  it("maxima_of_two_obstacles", () => {
    // a row with obstacles at both ends: clearances 0 1 2 3 3 2 1 0; of the plateau
    // only the first cell is a seed
    const row = new GridSpec(0, 0, 1, 8, 1);
    let dt = distanceTransform(row, (i) => i === 0 || i === 7);
    let m = dtMaxima(row, dt, 0);
    expect(m.length).toBe(1);
    expect(m[0]![0].eq(new P(3.5, 0.5))).toBe(true);
    expect(m[0]!.slice(1)).toEqual([3, 3, 0]);
    // obstacles in opposite corners of a 9×5 grid: the clearance peaks along the
    // perpendicular bisector (5 cells at (5, 0) and (3, 4), √20 at (4, 2))
    const g = new GridSpec(10, 20, 2, 9, 5);
    dt = distanceTransform(g, (i) => i === 0 || i === 44);
    m = dtMaxima(g, dt, 0);
    expect(m.map((s) => [s[2], s[3]])).toEqual([
      [5, 0],
      [4, 2],
      [3, 4],
    ]);
    for (const [p, v, c, r] of m) {
      expect(p.eq(g.cellCenter(c, r))).toBe(true);
      expect(v).toBe(dt[r * g.cols + c]);
    }
    expect(m[0]![1]).toBe(10);
    // below the minimum clearance nothing is a seed; far values (empty grid) neither
    expect(dtMaxima(g, dt, 9).length).toBe(2);
    expect(dtMaxima(g, dt, 100).length).toBe(0);
    const far = distanceTransform(g, () => false);
    expect(dtMaxima(g, far, 0).length).toBe(0);
  });
});
