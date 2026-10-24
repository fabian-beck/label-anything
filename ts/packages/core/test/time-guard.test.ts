// Port of rust/crates/la-core/tests/time_guard.rs: the greedy pass's wall-clock guard
// (ADR solver/time-budget) runs from the start of the pass, so a slow preparation (host text
// measurement) does not leave the labels unplaced.
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { placeWith } from "../src/place.js";

/** A clock that advances 5 ms with every host measurement, and only then. */
class SlowMeasure implements Env {
  now = 1;
  nowMs(): number {
    return this.now;
  }
  measure(): null {
    this.now += 5;
    return null;
  }
}

/** A clock that advances `step` ms every time it is read. */
class Ticking implements Env {
  now = 1;
  constructor(private readonly step: number) {}
  nowMs(): number {
    this.now += this.step;
    return this.now;
  }
}

type Res = { stats: Record<string, unknown>; placements: { placed: boolean; reason?: string }[] };

/** 200 labels in four rows, each with a free position, every one its own priority band. */
function rows(omission: string) {
  const items = Array.from({ length: 200 }, (_, i) => ({
    id: `i${i}`,
    anchor: { type: "point", x: 20 + (i % 50) * 40, y: 50 + Math.floor(i / 50) * 100 },
    label: { type: "text", text: `L${i}` },
    priority: 200 - i,
  }));
  // guard 10 ms: it passes after a few bands on this clock
  return { canvas: { width: 2020, height: 420 }, items, priority: { omission },
           solver: { strategy: "greedy", time_budget_ms: 1 } };
}

describe("time guard", () => {
  it("slow_preparation_does_not_starve_the_greedy_pass", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: `i${i}`,
      anchor: { type: "point", x: 40 + i * 70, y: 100 },
      label: { type: "text", text: `L${i}` },
      priority: i,
    }));
    // guard 10 ms; measuring the ten labels alone takes 50 ms on this clock
    const p = { canvas: { width: 800, height: 200 }, items, solver: { strategy: "greedy", time_budget_ms: 1 } };
    const r = placeWith(p, new SlowMeasure()) as { stats: Record<string, unknown> };
    expect(r.stats.placed).toBe(10);
    expect(r.stats.time_guard_hit).toBe(false);
  });

  it("after_the_guard_the_rest_get_level_0", () => {
    const r = placeWith(rows("strict"), new Ticking(1)) as Res;
    expect(r.stats.time_guard_hit).toBe(true);
    // every label has a free level-0 position: the level-0 pass after the guard places them
    // all instead of leaving them budget_exhausted (ADR solver/time-budget)
    expect(r.stats.placed).toBe(200);
  });

  it("after_the_guard_a_prefix_continues_at_level_0", () => {
    // the prefix checks the guard every 64 items: it passes at the first check, and the
    // guard of the level-0 pass ends the prefix at a later one
    const r = placeWith(rows("prefix"), new Ticking(6)) as Res;
    expect(r.stats.time_guard_hit).toBe(true);
    const placed = r.stats.placed as number;
    // more than the 63 items before the guard's first check: the level-0 pass places more
    expect(placed).toBeGreaterThan(64);
    expect(placed).toBeLessThan(200);
    // still a prefix of the priority order (= input order here), the rest out of time
    expect(r.placements.slice(0, placed).every((p) => p.placed)).toBe(true);
    expect(r.placements.slice(placed).every((p) => p.reason === "budget_exhausted")).toBe(true);
  });

  it("the_level_0_pass_has_its_own_guard", () => {
    // 1,000 items: the level-0 pass checks its guard every 64 items, one clock reading each,
    // and stops 10 ms after it began; the rest are budget_exhausted
    const items = Array.from({ length: 1000 }, (_, i) => ({
      id: `i${i}`,
      anchor: { type: "point", x: 20 + (i % 50) * 40, y: 20 + Math.floor(i / 50) * 30 },
      label: { type: "text", text: "L" },
      priority: 1000 - i,
    }));
    const p = { canvas: { width: 2020, height: 640 }, items, solver: { strategy: "greedy", time_budget_ms: 1 } };
    const r = placeWith(p, new Ticking(1)) as Res;
    expect(r.stats.time_guard_hit).toBe(true);
    const placed = r.stats.placed as number;
    expect(placed).toBeGreaterThan(100);
    expect(placed).toBeLessThan(1000);
    expect(r.placements.some((q) => q.reason === "budget_exhausted")).toBe(true);
  });
});
