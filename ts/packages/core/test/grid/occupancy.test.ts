// Tests of the occupancy grid: the bits against the cell counts while boxes come and go
// (as the unit test of rust/crates/la-core/src/grid/occupancy.rs), the window of a box
// against a per-cell reference, and the frozen (summed-area) answers against the bitset
// ones.
import { describe, expect, it } from "vitest";
import { Rect } from "../../src/geom/index.js";
import { OCC_MARGIN, Occupancy, newWindow } from "../../src/grid/occupancy.js";
import { Pcg32 } from "../../src/pcg.js";

/** The cells `k` of one axis with `t0 < k < t1` (the definition of `Occupancy.span`). */
function refSpan(o: number, cell: number, n: number, a: number, b: number): [number, number] {
  const t0 = (a + OCC_MARGIN - o) * (1 / cell) - 0.5;
  const t1 = (b - OCC_MARGIN - o) * (1 / cell) - 0.5;
  let lo = -1;
  let hi = -1;
  for (let k = 0; k < n; k++) {
    if (t0 < k && k < t1) {
      if (lo < 0) lo = k;
      hi = k + 1;
    }
  }
  return lo < 0 ? [0, 0] : [lo, hi];
}

function randomBox(rng: Pcg32, w: number, h: number): Rect {
  const x = rng.nextF64() * (w + 40) - 20;
  const y = rng.nextF64() * (h + 40) - 20;
  return new Rect(x, y, x + rng.nextF64() * 60, y + rng.nextF64() * 30);
}

describe("occupancy", () => {
  it("bits_mirror_the_counts", () => {
    // marking word by word keeps the bits equal to "count > 0", with overlapping boxes
    // added and removed in any order, across word boundaries and at the grid's edges
    const occ = new Occupancy(new Rect(0, 0, 300, 40)); // cell 2: 150 × 20 cells
    const rng = new Pcg32(7);
    const placed: Rect[] = [];
    const probe = newWindow();
    let wrong = 0;
    for (let n = 0; n < 2000; n++) {
      if (placed.length === 0 || rng.nextF64() < 0.55) {
        const x = rng.nextF64() * 340 - 20;
        const y = rng.nextF64() * 50 - 5;
        const r = new Rect(x, y, x + rng.nextF64() * 160, y + rng.nextF64() * 12);
        occ.mark(r, true);
        placed.push(r);
      } else {
        const k = rng.nextBelow(placed.length);
        occ.mark(placed[k]!, false);
        placed.splice(k, 1);
      }
      // every cell: blocked iff a placed box covers its center
      for (let row = 0; row < 20; row++) {
        for (let c = 0; c < 150; c++) {
          const cx = 2 * c + 1;
          const cy = 2 * row + 1;
          let covered = false;
          for (const r of placed) {
            if (r.x0 + OCC_MARGIN < cx && cx < r.x1 - OCC_MARGIN && r.y0 + OCC_MARGIN < cy && cy < r.y1 - OCC_MARGIN) {
              covered = true;
              break;
            }
          }
          if (!occ.window(new Rect(cx - 0.5, cy - 0.5, cx + 0.5, cy + 0.5), probe) || occ.blockedIn(probe) !== covered) {
            wrong++;
          }
        }
      }
    }
    expect(wrong).toBe(0);
    for (const r of placed) occ.mark(r, false);
    expect(occ.isEmpty()).toBe(true);
  });

  it("window_matches_the_cell_definition", () => {
    const extent = new Rect(-5, -3, 795, 597);
    const occ = new Occupancy(extent);
    // cell size: max(2, sqrt(area / 1e6)) = 2 here
    const cell = 2;
    const cols = Math.ceil(800 / cell);
    const rows = Math.ceil(600 / cell);
    const rng = new Pcg32(7);
    const w = newWindow();
    const box = new Float64Array(4);
    for (let n = 0; n < 2000; n++) {
      const r = randomBox(rng, 800, 600);
      const [c0, c1] = refSpan(extent.x0, cell, cols, r.x0, r.x1);
      const [r0, r1] = refSpan(extent.y0, cell, rows, r.y0, r.y1);
      const expected = c1 > c0 && r1 > r0;
      expect(occ.window(r, w)).toBe(expected);
      if (expected) expect(Array.from(w)).toEqual([c0, c1, r0, r1]);
      box[0] = r.x0;
      box[1] = r.y0;
      box[2] = r.x1;
      box[3] = r.y1;
      const w2 = newWindow();
      expect(occ.windowBox(box, w2)).toBe(expected);
      if (expected) expect(Array.from(w2)).toEqual([c0, c1, r0, r1]);
    }
  });

  it("window_of_a_nan_coordinate", () => {
    // a NaN bound converts to 0 (Rust `as i64`): first cell 0 + 1, end 0
    const occ = new Occupancy(new Rect(0, 0, 100, 100)); // cell 2
    const w = newWindow();
    expect(occ.window(new Rect(NaN, 0, 30, 20), w)).toBe(true);
    expect(Array.from(w)).toEqual([1, 15, 0, 10]);
    expect(occ.window(new Rect(0, 0, NaN, 20), w)).toBe(false);
    expect(occ.window(new Rect(0, NaN, 30, 20), w)).toBe(true);
    expect(Array.from(w)).toEqual([0, 15, 1, 10]);
  });

  it("frozen_answers_equal_the_bitset_answers", () => {
    const extent = new Rect(0, 0, 640, 480);
    const live = new Occupancy(extent);
    const frozen = new Occupancy(extent);
    const rng = new Pcg32(11);
    for (let n = 0; n < 150; n++) {
      const r = randomBox(rng, 640, 480);
      live.mark(r, true);
      frozen.mark(r, true);
    }
    frozen.freeze();
    expect(frozen.sameCells(live)).toBe(true);
    const w = newWindow();
    let hits = 0;
    for (let n = 0; n < 3000; n++) {
      // small boxes (bitset scan) and large ones (the frozen grid's summed-area table)
      let r = randomBox(rng, 640, 480);
      if (n % 3 === 0) r = new Rect(r.x0, r.y0, r.x0 + (r.x1 - r.x0) * 6, r.y0 + (r.y1 - r.y0) * 6);
      const a = live.blocked(r);
      expect(frozen.blocked(r)).toBe(a);
      if (live.window(r, w)) expect(frozen.blockedIn(w)).toBe(live.blockedIn(w));
      if (a) hits++;
    }
    expect(hits).toBeGreaterThan(100);
    expect(hits).toBeLessThan(2900);
  });

  it("marks_are_counted", () => {
    const occ = new Occupancy(new Rect(0, 0, 100, 100));
    const r = new Rect(10, 10, 30, 20);
    expect(occ.isEmpty()).toBe(true);
    occ.mark(r, true);
    occ.mark(r, true);
    expect(occ.blocked(new Rect(14, 12, 18, 16))).toBe(true);
    occ.mark(r, false);
    expect(occ.blocked(new Rect(14, 12, 18, 16))).toBe(true);
    occ.mark(r, false);
    expect(occ.blocked(new Rect(14, 12, 18, 16))).toBe(false);
    expect(occ.isEmpty()).toBe(true);
    // touching boxes are not blocked
    occ.mark(r, true);
    expect(occ.blocked(new Rect(30, 10, 40, 20))).toBe(false);
    expect(occ.blocked(new Rect(27, 10, 40, 20))).toBe(true);
  });
});
