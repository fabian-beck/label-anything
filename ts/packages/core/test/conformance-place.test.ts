// Runs conformance/place/*.json (format: conformance/README.md, "place cases") through
// the TypeScript runner (src/conformance/run.ts, also `npm run conformance`), with the
// runner's independent re-checks of label overlaps, leader crossings and canvas bounds.
import { describe, expect, it } from "vitest";
import { checkPlace, loadPlaceCases } from "../src/conformance/run.js";
import { CONF } from "./util.js";

const cases = loadPlaceCases(CONF);

describe("conformance/place", () => {
  it("has the place cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });
  for (const c of cases) {
    it(c.name, () => {
      expect(checkPlace(c.problem, c.expect)).toEqual([]);
    });
  }
});
