// Port of the unit tests of rust/crates/la-core/src/leaders.rs.
import { describe, expect, it } from "vitest";
import { Leader } from "../src/candidates.js";
import { cosDeg } from "../src/detmath.js";
import { P } from "../src/geom/index.js";
import { leadersConflict, leadersParallel } from "../src/leaders.js";
import { LeaderStyle } from "../src/model/index.js";

function leader(pts: [number, number][]): Leader {
  return new Leader(
    pts.map(([x, y]) => new P(x, y)),
    LeaderStyle.Straight,
  );
}

describe("leaders", () => {
  it("crossing_and_near_leaders_conflict", () => {
    const a = leader([
      [0, 0],
      [100, 0],
    ]);
    // crossing
    expect(
      leadersConflict(
        a,
        leader([
          [50, -20],
          [50, 20],
        ]),
        0,
      ),
    ).toBe(true);
    // a port 2 px from the other leader reads as a crossing (T-junction)
    const t = leader([
      [50, 40],
      [50, 2],
    ]);
    expect(leadersConflict(a, t, 4.8)).toBe(true);
    expect(leadersConflict(t, a, 4.8)).toBe(true);
    expect(leadersConflict(a, t, 1.5)).toBe(false);
    // a bend near the other leader counts too
    const bend = leader([
      [30, 40],
      [30, 3],
      [-20, 3],
    ]);
    expect(leadersConflict(a, bend, 4.8)).toBe(true);
  });

  it("neighbouring_starts_may_be_close", () => {
    // starts 3 px apart, leaving in different directions: no conflict
    const a = leader([
      [0, 0],
      [0, -50],
    ]);
    const b = leader([
      [3, 0],
      [40, -40],
    ]);
    expect(leadersConflict(a, b, 4.8)).toBe(false);
    // parallel at 3 px: the far ends are close as well
    const c = leader([
      [3, 0],
      [3, -50],
    ]);
    expect(leadersConflict(a, c, 4.8)).toBe(true);
    // a leader passing another leader's start is no start-start approach
    const d = leader([
      [-20, 2],
      [20, 2],
    ]);
    expect(leadersConflict(a, d, 4.8)).toBe(true);
  });

  it("underline_ends_count_as_vertices", () => {
    const a = leader([
      [0, 0],
      [100, 0],
    ]);
    const u = leader([
      [60, 40],
      [60, 10],
    ]);
    u.underline = [new P(60, 10), new P(80, 3)];
    expect(leadersConflict(a, u, 4.8)).toBe(true);
    expect(leadersConflict(a, u, 2.5)).toBe(false);
  });

  it("diverging_leaders", () => {
    const cos10 = cosDeg(10);
    const a = leader([
      [0, 0],
      [100, 0],
    ]);
    const nearly = leader([
      [0, 7],
      [98, 10],
    ]);
    const apart = leader([
      [0, 7],
      [78, 60],
    ]);
    expect(leadersParallel(a, nearly, 12, cos10)).toBe(true);
    expect(leadersParallel(a, apart, 12, cos10)).toBe(false);
    // starts farther apart than `near`, or the rule off
    expect(leadersParallel(a, nearly, 6, cos10)).toBe(false);
    expect(leadersParallel(a, nearly, 12, 1)).toBe(false);
  });
});
