// Port of the unit tests of rust/crates/la-core/src/priority.rs.
import { describe, expect, it } from "vitest";
import { normalize } from "../src/priority.js";

describe("priority", () => {
  it("rank_normalization_with_ties_and_missing", () => {
    const v = normalize([3, 1, null, 3, 2], "rank");
    expect(v).toEqual([(2 + 3) / 2 / 3, 0, 0, 2.5 / 3, 1 / 3]);
    const m = normalize([2, 4, null], "minmax");
    expect(m).toEqual([0, 1, 0]);
  });
});
