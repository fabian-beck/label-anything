// Port of the unit tests of rust/crates/la-core/src/solver/repair.rs.
import { describe, expect, it } from "vitest";
import { hungarian, stack } from "../src/solver/repair.js";

describe("solver::repair", () => {
  it("stacking_respects_gaps_and_bounds", () => {
    let y = stack([10, 11, 12], [5, 5], 0, 100);
    expect(Math.abs(y[1]! - y[0]! - 5) < 1e-9 && Math.abs(y[2]! - y[1]! - 5) < 1e-9).toBe(true);
    expect(Math.abs(y[1]! - 11)).toBeLessThan(1e-9); // centered on the desired mean
    y = stack([0, 1], [10], 5, 100);
    expect(y[0]!).toBeGreaterThanOrEqual(5 - 1e-9);
    y = stack([10, 50], [5], 0, 100);
    expect(y).toEqual([10, 50]);
  });

  it("hungarian_min_cost", () => {
    const c = [
      [4, 1, 3],
      [2, 0, 5],
      [3, 2, 2],
    ];
    const a = hungarian(c);
    let total = 0;
    a.forEach((j, i) => (total += c[i]![j]!));
    expect(total).toBe(5);
  });
});
