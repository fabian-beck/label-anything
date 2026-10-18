// Port of the unit tests of rust/crates/la-core/src/priority.rs.
import { describe, expect, it } from "vitest";
import { P } from "../src/geom/index.js";
import { cmpF64, maxf } from "../src/math.js";
import { Pcg32 } from "../src/pcg.js";
import { KdTree, normalize, type Disc } from "../src/priority.js";

describe("priority", () => {
  it("kd_tree_finds_the_exact_kth_gap", () => {
    // heavy-tailed centres (a dense core, far outliers) with mixed radii
    const rng = new Pcg32(7);
    const u = () => rng.nextF64() + 1e-9;
    const pts: Disc[] = [];
    for (let i = 0; i < 600; i++) {
      const [a, b] = [u(), u()];
      const spread = 1 / (a * a) - 1;
      const c = new P(400 + spread * (b - 0.5), 300 + spread * (u() - 0.5));
      pts.push([c, [0, 1.5, 6][i % 3]!, i % 4 === 0 ? null : i]);
    }
    const tree = new KdTree(pts);
    const [best, stack]: [number[], number[]] = [[], []];
    for (const k of [1, 5]) {
      pts.forEach(([a, ri, idx], q) => {
        if (idx === null) return;
        const all = pts.filter((_, j) => j !== q).map(([c, r]) => maxf(c.dist(a) - r - ri, 0));
        all.sort(cmpF64);
        tree.smallestGaps(pts, a, ri, idx, k, best, stack);
        expect(best).toEqual(all.slice(0, k));
      });
    }
  });

  it("rank_normalization_with_ties_and_missing", () => {
    const v = normalize([3, 1, null, 3, 2], "rank");
    expect(v).toEqual([(2 + 3) / 2 / 3, 0, 0, 2.5 / 3, 1 / 3]);
    const m = normalize([2, 4, null], "minmax");
    expect(m).toEqual([0, 1, 0]);
  });
});
