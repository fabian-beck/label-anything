// Port of rust/crates/la-core/tests/cancel.rs: a cancelled solve (spec §10.3a) stops
// early but returns a valid result. Also checks the public `place` API: an `AbortSignal`
// or a duck-typed `{ aborted }` object cancels.
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { place, placeWith } from "../src/place.js";

/** Cancels after `after` polls and records progress reports. */
class CancelAfter implements Env {
  polls = 0;
  progressCount = 0;
  constructor(readonly after: number) {}
  cancelled(): boolean {
    this.polls += 1;
    return this.polls > this.after;
  }
  progress(_phase: string, fraction: number): void {
    expect(fraction >= 0 && fraction <= 1).toBe(true);
    this.progressCount += 1;
  }
}

function crowded(): Record<string, unknown> {
  const items = [];
  for (let i = 0; i < 300; i++) {
    const x = 20 + (i % 20) * 18;
    const y = 20 + Math.trunc(i / 20) * 14;
    items.push({ id: `i${i}`, anchor: { type: "point", x, y }, label: { type: "text", text: `Label ${i}` }, priority: i % 5 });
  }
  return {
    canvas: { width: 400, height: 260 },
    items,
    solver: { strategy: "local", time_budget_ms: 1e5, max_iterations: 100000 },
  };
}

type R = { placements: { reason?: string }[]; stats: Record<string, number | boolean> };

describe("cancel", () => {
  it("cancelled_solve_is_valid_and_reported", () => {
    const p = crowded();
    const full = placeWith(p, new CancelAfter(Number.MAX_SAFE_INTEGER)) as unknown as R;
    expect(full.stats.cancelled).toBe(false);
    for (const after of [0, 1, 3, 10]) {
      const env = new CancelAfter(after);
      const r = placeWith(p, env) as unknown as R;
      const st = r.stats;
      expect(st.cancelled, `after ${after}`).toBe(true);
      expect(st.hard_violations, `after ${after}`).toBe(0);
      expect(st.placed as number).toBeLessThanOrEqual(full.stats.placed as number);
      expect(env.progressCount).toBeGreaterThan(0);
      // items never reached are reported as budget_exhausted
      const exhausted = r.placements.filter((q) => q.reason === "budget_exhausted").length;
      if (after === 0) {
        expect(st.placed).toBe(0);
        expect(exhausted).toBe(300);
      }
    }
  });

  it("place honours an aborted signal and a duck-typed one", () => {
    const p = crowded();
    const ac = new AbortController();
    ac.abort();
    const r = place(p as never, { signal: ac.signal }) as unknown as R;
    expect(r.stats.cancelled).toBe(true);
    expect(r.stats.placed).toBe(0);
    const duck = { aborted: true } as unknown as AbortSignal;
    const r2 = place(p as never, { signal: duck }) as unknown as R;
    expect(r2.stats.cancelled).toBe(true);
    const phases: string[] = [];
    const p3 = { ...p, solver: { strategy: "greedy" } };
    const r3 = place(p3 as never, { signal: { aborted: false } as unknown as AbortSignal, progress: (ph) => phases.push(ph) }) as unknown as R;
    expect(r3.stats.cancelled).toBe(false);
    expect(phases).toContain("greedy");
  });
});
