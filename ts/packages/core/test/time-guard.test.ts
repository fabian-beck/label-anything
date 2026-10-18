// Port of rust/crates/la-core/tests/time_guard.rs: the greedy pass's wall-clock guard
// (ADR 0042) runs from the start of the pass, so a slow preparation (host text
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
});
