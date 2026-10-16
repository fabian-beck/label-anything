// The grid limits of spec §4.1 (Rust: obstacles::grid_cell, lib.rs place_validated):
// at most 16 M cells, the auto cell size grows for huge canvases, an explicit grid cell
// over the limit and a non-finite working extent are errors with code `limit`.
import { describe, expect, it } from "vitest";
import { PlaceError } from "../src/api.js";
import { BasicEnv } from "../src/env.js";
import { MAX_GRID_CELLS } from "../src/obstacles.js";
import { placeWith } from "../src/place.js";

const item = (id: string, x: number, y: number): unknown => ({
  id,
  anchor: { type: "point", x, y },
  label: { type: "text", text: id },
});

function placeError(problem: unknown): PlaceError {
  try {
    placeWith(problem, new BasicEnv());
  } catch (e) {
    if (e instanceof PlaceError) return e;
    throw e;
  }
  throw new Error("expected a PlaceError");
}

describe("grid limits", () => {
  it("auto_cell_grows_for_huge_canvases", () => {
    const r = placeWith(
      { canvas: { width: 50000, height: 40000 }, items: [item("a", 100, 100), item("b", 49900, 39900)] },
      new BasicEnv(),
    );
    const g = (r.stats as Record<string, unknown>).grid as { cell: number; cols: number; rows: number };
    expect(g.cell).toBeGreaterThan(4);
    expect(g.cols * g.rows).toBeLessThanOrEqual(MAX_GRID_CELLS);
    expect(Math.ceil(50000 / g.cell)).toBe(g.cols);
    expect((r.stats as Record<string, unknown>).placed).toBe(2);
  });

  it("explicit_grid_cell_over_the_limit_is_an_error", () => {
    const e = placeError({ canvas: { width: 20000, height: 20000 }, solver: { grid_cell: 1 }, items: [item("a", 10, 10)] });
    expect(e.errors.map((i) => [i.pointer, i.code])).toEqual([["/solver/grid_cell", "limit"]]);
    expect(e.errors[0]!.message).toBe("the grid would have 400000000 cells (at most 16000000): use a larger solver.grid_cell");
  });

  it("non_finite_extent_is_an_error", () => {
    const e = placeError({ items: [item("a", -1e308, 0), item("b", 1e308, 0)] });
    expect(e.errors.map((i) => [i.pointer, i.code])).toEqual([["", "limit"]]);
  });
});
