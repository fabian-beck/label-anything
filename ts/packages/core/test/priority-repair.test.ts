// Port of rust/crates/la-core/tests/priority_repair.rs: the priority repair moves one
// label aside (ADR 0049): an omitted item gets a label when the one more important label
// in its way can move to another of its positions.
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { placeWith } from "../src/place.js";

/** No clock: the solve is deterministic. */
const NO_CLOCK: Env = {};

type Res = {
  stats: Record<string, unknown>;
  placements: { id: string; placed: boolean; anchor_side?: string; reason?: string }[];
};

function item(id: string, x: number, y: number, w: number, priority: number, order: string[]) {
  return {
    id,
    anchor: { type: "point", x, y },
    priority,
    label: { type: "text", text: id, width: w, height: 10, padding: 0 },
    placement: { position_order: order },
  };
}

/**
 * "B" (more important) prefers its right side, where it blocks the only position of "H",
 * above its mark; without the lookahead and the search, the greedy pass leaves "H" out.
 */
function problem(extra: object[] = []): Record<string, unknown> {
  return {
    version: "1",
    canvas: { width: 200, height: 100 },
    preset: "none",
    items: [item("B", 50, 50, 40, 2, ["right", "left"]), item("H", 100, 50, 30, 1, ["top"]), ...extra],
    placement: { models: ["adjacent"] },
    weights: { lookahead: 0, starve: 0 },
    degrade: ["omit"],
    solver: { strategy: "greedy" },
  };
}

/** A less important item whose only label comes 2 px close to the left position of "B". */
function lower(id: string, y: number, priority: number, side: string) {
  return item(id, side === "bottom" ? 20 : 30, y, 30, priority, [side]);
}

function sides(r: Res): [string, string | null][] {
  return r.placements.map((p) => [p.id, p.anchor_side ?? null]);
}

describe("moving one label aside", () => {
  it("a more important label moves aside", () => {
    const r = placeWith(problem(), NO_CLOCK) as Res;
    expect(sides(r)).toEqual([
      ["B", "left"],
      ["H", "top"],
    ]);
    expect(r.stats.priority_inversions).toBe(0);
  });

  it("one less important label gives way", () => {
    const r = placeWith(problem([lower("L1", 30, 0, "bottom")]), NO_CLOCK) as Res;
    expect(sides(r)).toEqual([
      ["B", "left"],
      ["H", "top"],
      ["L1", null],
    ]);
    expect(r.placements[2]!.reason).toBe("omitted_by_priority");
  });

  it("two less important labels do not", () => {
    const p = problem([lower("L1", 30, 0, "bottom"), lower("L2", 70, -1, "top")]);
    const r = placeWith(p, NO_CLOCK) as Res;
    expect(sides(r)).toEqual([
      ["B", "right"],
      ["H", null],
      ["L1", "bottom"],
      ["L2", "top"],
    ]);
  });

  it("the moved label may take a pruned position", () => {
    // a costly shade on the left position: the pruning drops it (`prune_factor` 1)
    const p = problem();
    p.obstacles = { vector: [{ class: "shade", rects: [[7, 45, 40, 10]] }] };
    p.avoid = { label: { shade: 5 } };
    p.placement = { models: ["adjacent"], prune_factor: 1 };
    const r = placeWith(p, NO_CLOCK) as Res;
    expect(sides(r)).toEqual([
      ["B", "left"],
      ["H", "top"],
    ]);
    expect(r.stats.candidates).toBe(3);
  });

  it("a place moved from serves an item visited before", () => {
    // "E" (between "B" and "H") is visited first: its cheap position below is taken by "F",
    // which cannot move, and the one above, under a costly shade, was pruned and is in
    // the way of "B" on the right. Once "B" moves aside for "H", the pass without moves
    // finds that position free.
    const p = problem();
    const items = p.items as object[];
    items.splice(1, 0, item("F", 75, 95, 30, 3.5, ["top"]), item("E", 75, 70, 30, 3, ["bottom", "top"]));
    p.canvas = { width: 200, height: 120 };
    p.obstacles = { vector: [{ class: "shade", rects: [[60, 57, 30, 10]] }] };
    p.avoid = { label: { shade: 5 } };
    p.placement = { models: ["adjacent"], prune_factor: 1 };
    const r = placeWith(p, NO_CLOCK) as Res;
    expect(sides(r)).toEqual([
      ["B", "left"],
      ["F", "top"],
      ["E", "top"],
      ["H", "top"],
    ]);
    expect(r.stats.priority_inversions).toBe(0);
  });
});
