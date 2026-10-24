// Solve traces (ADR project/solve-traces): a traced solve makes the decisions of an untraced one,
// and the trace replays to the result. Every parity fixture (the Rust result of a conformance
// problem, solved without a clock) is solved again with a tracer: the result must still be
// the Rust one bit for bit, and applying the placement changes of the events in order must
// give exactly the result's placements.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BasicEnv } from "../src/env.js";
import { placeTraced } from "../src/index.js";
import type { SolveTrace, TracePhase } from "../src/trace.js";
import { jsonDiff, withoutTiming } from "./parity-util.js";

const DIR = fileURLToPath(new URL("../../../../conformance/parity/", import.meta.url));

interface Fixture {
  problem?: unknown;
  problem_file?: string;
  result: unknown;
}

type Placement = { id: string; placed: boolean; box?: { x: number; y: number; w: number; h: number } | null; leader?: { points: number[][] } | null };

const PHASES: TracePhase[] = ["prepare", "candidates", "greedy", "local", "exact", "fan", "boundary", "uncross", "repair", "verify"];

/** The placed trace candidate per item after replaying every event. */
function replay(trace: SolveTrace): number[] {
  const placed = new Array<number>(trace.items.length).fill(-1);
  for (const e of trace.events) for (const [i, c] of e.changes) placed[i] = c;
  return placed;
}

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

describe("solve traces", () => {
  for (const f of files) {
    it(f, () => {
      const fx = JSON.parse(readFileSync(join(DIR, f), "utf8")) as Fixture;
      const problem = fx.problem ?? JSON.parse(readFileSync(join(DIR, fx.problem_file!), "utf8"));
      const { result, trace } = placeTraced(new BasicEnv(), problem, "rust");
      // the decisions of the untraced solve, which are the Rust core's
      expect(jsonDiff(withoutTiming(result), fx.result)).toEqual([]);
      // the phases come in pipeline order
      const phases = trace.events.flatMap((e) => (e.type === "phase" ? [e.phase] : []));
      expect(phases.map((p) => PHASES.indexOf(p))).toEqual([...phases.map((p) => PHASES.indexOf(p))].sort((a, b) => a - b));
      expect(phases[0]).toBe("prepare");
      expect(phases[phases.length - 1]).toBe("verify");
      // the replayed placement is the result's
      const placed = replay(trace);
      const ps = (result as unknown as { placements: Placement[] }).placements;
      expect(trace.items.map((it) => it.id)).toEqual(ps.map((p) => p.id));
      ps.forEach((p, i) => {
        const c = placed[i]!;
        // a group member is drawn by its representative's label: it has no candidate itself
        if (!p.placed || c < 0) {
          if (c >= 0) expect.fail(`${p.id}: placed in the trace, not in the result`);
          if (p.placed) expect(trace.items[i]!.reason ?? "grouped").toBe("grouped");
          return;
        }
        const cand = trace.candidates[c]!;
        expect(cand.item).toBe(i);
        expect(cand.box, p.id).toEqual([p.box!.x, p.box!.y, p.box!.w, p.box!.h]);
        expect(cand.leaders[0]?.points ?? null, p.id).toEqual(p.leader?.points ?? null);
      });
      // every candidate an event names exists and belongs to that event's item
      for (const e of trace.events) {
        for (const [i, c] of e.changes) if (c >= 0) expect(trace.candidates[c]!.item).toBe(i);
        if (e.type === "place") expect(trace.candidates[e.cand]!.item).toBe(e.item);
        if (e.type === "generate") for (const c of e.cands) expect(trace.candidates[c]!.item).toBe(e.item);
      }
      const moves = trace.events.filter((e) => e.type === "move").length;
      expect(moves).toBeLessThanOrEqual(trace.iterations);
    });
  }

  it("records the greedy decisions and the search of a crowded problem", () => {
    const items = [];
    for (let k = 0; k < 24; k++) {
      const x = 200 + 60 * Math.cos(k * 2.4) * Math.sqrt(k / 24);
      const y = 150 + 50 * Math.sin(k * 2.4) * Math.sqrt(k / 24);
      items.push({ id: `p${k}`, anchor: { type: "point", x, y }, label: { type: "text", text: `Label ${k}` } });
    }
    const { result, trace } = placeTraced(new BasicEnv(), { canvas: { width: 400, height: 300 }, items }, "rust");
    const types = new Set(trace.events.map((e) => e.type));
    for (const t of ["generate", "band", "pick", "score", "place", "anneal", "move", "verify"]) expect(types, t).toContain(t);
    // a placement rules out the conflicting level-0 candidates of waiting items
    const killed = trace.events.flatMap((e) => (e.type === "place" ? e.killed : []));
    expect(killed.length).toBeGreaterThan(0);
    for (const e of trace.events) if (e.type === "place") for (const k of e.killed) expect(trace.candidates[k]!.item).not.toBe(e.item);
    // a cost breakdown sums to the cost of every evaluated candidate
    for (const c of trace.candidates) {
      if (c.cost === null) continue;
      const sum = c.breakdown!.reduce((a, [, v]) => a + v, 0);
      expect(sum).toBeCloseTo(c.cost, 9);
    }
    // the trace's moves are the budget's
    const moves = trace.events.filter((e) => e.type === "move");
    expect(moves.length).toBe(trace.iterations);
    expect((result.stats as unknown as { iterations: number }).iterations).toBe(moves.length);
  });
});
