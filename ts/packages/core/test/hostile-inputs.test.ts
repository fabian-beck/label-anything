// Small problems that ask for unbounded work: each once hung a solve or took the host's
// memory. They must end, quickly, with a result or an error.
// (Rust: rust/crates/la-core/tests/hostile_inputs.rs.)
import { describe, expect, it } from "vitest";
import { PlaceError } from "../src/api.js";
import { BasicEnv } from "../src/env.js";
import { solveWith } from "../src/place.js";

const point = (id: string, x: number, y: number): unknown => ({
  id,
  anchor: { type: "point", x, y },
  label: { type: "text", text: id },
});

/** The result, or the codes of the errors. */
function solve(problem: unknown): Record<string, any> | string[] {
  try {
    return solveWith(problem, new BasicEnv()) as Record<string, any>;
  } catch (e) {
    if (e instanceof PlaceError) return e.errors.map((i) => i.code);
    throw e;
  }
}

describe("hostile inputs", { timeout: 20_000 }, () => {
  // a country that reaches far beyond the view of a zoomed-in map
  it("an_area_far_larger_than_the_canvas", () => {
    for (const side of [1e5, 1e7, 1e17]) {
      const r = solve({
        canvas: { width: 400, height: 300 },
        items: [
          {
            id: "country",
            anchor: { type: "area", polygon: [[0, 0], [side, 0], [side, side], [0, side]] },
            label: { type: "text", text: "Country" },
          },
        ],
      }) as Record<string, any>;
      expect(r.placements.length).toBe(1);
    }
  });

  it("more_neighbours_than_points", () => {
    for (const k of [1e18, 2e18]) {
      const r = solve({
        canvas: { width: 400, height: 300 },
        items: [point("a", 100, 100), point("b", 104, 102)],
        priority: { terms: [{ builtin: "outlierness", k }] },
      }) as Record<string, any>;
      expect(r.stats.placed).toBe(2);
    }
  });

  // sizes beyond what a double holds: the costs of the fan pass are infinite
  it("labels_too_large_for_numbers", () => {
    solve({
      canvas: { width: 400, height: 300 },
      defaults: { font: { size: 1e160 } },
      items: [point("a", 100, 100), point("b", 104, 102)],
    });
  });

  it("counts_beyond_their_limits", () => {
    for (const [section, key, value] of [
      ["placement", "slider_per_quadrant", 1e9],
      ["placement", "distant_directions", 1e9],
      ["placement", "distant_rings", 1e9],
      ["degrade_options", "wrap_max_lines", 1e15],
    ] as const) {
      const problem = { canvas: { width: 400, height: 300 }, items: [point("a", 100, 100)], [section]: { [key]: value } };
      expect(solve(problem), key).toEqual(["range"]);
    }
  });
});
