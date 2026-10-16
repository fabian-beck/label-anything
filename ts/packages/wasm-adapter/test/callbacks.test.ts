// The non-schema options: priority, cost, measure, progress, readFile, signal.
import { beforeAll, describe, expect, it } from "vitest";
import type { CandidateInfo, FontSpec, LabelResult, PlaceOptions } from "@label-anything/core";
import { built, readProblem, scatter, untimed, type AnyProblem } from "./helpers.js";

type Wasm = typeof import("../src/node.js");
let la: Wasm;

function thrown(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error("expected an exception");
}

function placedIds(r: LabelResult): string[] {
  return r.placements.filter((p) => p.placed).map((p) => p.id);
}

describe.skipIf(!built)("callbacks", () => {
  beforeAll(async () => {
    la = await import("../src/node.js");
  });

  describe("priority", () => {
    it("is evaluated once per item and acts like explicit priorities", () => {
      const problem = scatter(10, { priority: { budget: { max_labels: 3 } } });
      const calls: [string, number][] = [];
      const r = la.place(problem, {
        priority: (item, i) => {
          calls.push([item.id as string, i]);
          return i; // later items first
        },
      });
      expect(calls).toEqual(problem.items.map((it, i) => [it.id, i]));
      expect(placedIds(r).sort()).toEqual(["p7", "p8", "p9"]);
      expect(r.placements.find((p) => p.id === "p9")?.priority).toMatchObject({ score: 9, rank: 0 });
      const explicit = { ...problem, items: problem.items.map((it, i) => ({ ...it, priority: i })) };
      expect(untimed(r)).toEqual(untimed(la.place(explicit)));
      // JSON text input
      expect(untimed(la.place(JSON.stringify(problem), { priority: (_it, i) => i }))).toEqual(untimed(r));
    });

    it("takes [tier, score]; explicit item.priority and item.tier win; terms are replaced", () => {
      const problem = scatter(6, { priority: { terms: [{ builtin: "outlierness" }] } });
      problem.items[0] = { ...problem.items[0], priority: 100, tier: 2 } as AnyProblem["items"][number];
      const r = la.place(problem, { priority: (_it, i) => [i % 2, -i] });
      const pri = (id: string) => r.placements.find((p) => p.id === id)?.priority as Record<string, unknown>;
      expect(pri("p0")).toMatchObject({ tier: 2, score: 100, rank: 0 });
      expect(pri("p1")).toMatchObject({ tier: 1, score: -1 });
      expect(pri("p2")).toMatchObject({ tier: 0, score: -2 });
      expect(pri("p3").terms).toBeUndefined(); // the callback replaces priority.terms
      expect((la.place(problem).placements[3].priority as Record<string, unknown>).terms).toBeDefined();
    });

    it("rethrows exceptions and rejects invalid values", () => {
      const boom = new Error("boom");
      expect(thrown(() => la.place(scatter(3), { priority: () => { throw boom; } }))).toBe(boom);
      expect(() => la.place(scatter(3), { priority: () => Number.NaN })).toThrow(TypeError);
      expect(() => la.place(scatter(3), { priority: () => [0.5, 1] })).toThrow(TypeError);
      expect(() => la.place(scatter(3), { priority: 3 } as unknown as PlaceOptions)).toThrow(TypeError);
    });
  });

  describe("cost", () => {
    it("is called per candidate with CandidateInfo and steers the placement", () => {
      const problem = scatter(6);
      const anchors = new Map(problem.items.map((it) => [it.id as string, it.anchor as { x: number }]));
      const seen: CandidateInfo[] = [];
      const right = la.place(problem, {
        cost: (c) => {
          seen.push(c);
          return c.box.x + c.box.w / 2 < (anchors.get(c.itemId)?.x ?? 0) ? 100 : 0;
        },
      });
      expect(seen.length).toBeGreaterThan(problem.items.length);
      expect(seen[0]).toEqual({
        itemId: "p0",
        box: { x: expect.any(Number), y: expect.any(Number), w: expect.any(Number), h: expect.any(Number) },
        leader: expect.any(Boolean),
      });
      expect(new Set(seen.map((c) => c.itemId))).toEqual(new Set(anchors.keys()));
      for (const p of right.placements) {
        expect(p.placed).toBe(true);
        expect((p.box?.x ?? 0) + (p.box?.w ?? 0) / 2).toBeGreaterThanOrEqual(anchors.get(p.id)?.x ?? 0);
      }
      const zero = la.place(problem, { cost: () => 0 });
      expect(zero.placements.map((p) => p.box)).toEqual(la.place(problem).placements.map((p) => p.box));
    });

    it("stops calling back after an exception and rethrows it", () => {
      const boom = new RangeError("cost failed");
      let costCalls = 0;
      const phases: string[] = [];
      const e = thrown(() =>
        la.place(scatter(8), {
          cost: () => {
            if (++costCalls === 3) throw boom;
            return 0;
          },
          progress: (phase) => phases.push(phase),
        }),
      );
      expect(e).toBe(boom);
      expect(costCalls).toBe(3);
      expect(phases).toEqual([]); // "greedy" is reported after the candidates
      expect(() => la.place(scatter(3), { cost: () => "1" as unknown as number })).toThrow(/cost callback must return a finite number/);
      expect(() => la.place(scatter(3), { cost: () => Number.POSITIVE_INFINITY })).toThrow(TypeError);
      expect(la.place(scatter(3)).stats.hard_violations).toBe(0); // the instance is fine afterwards
    });
  });

  describe("measure", () => {
    it("replaces the built-in measurement", () => {
      const calls: [string, FontSpec][] = [];
      const r = la.place(scatter(4), {
        measure: (text, font) => {
          calls.push([text, font]);
          return { width: text.length * 10, ascent: 9, descent: 3 };
        },
      });
      expect(calls.map((c) => c[0])).toContain("P0");
      expect(calls[0][1]).toEqual({ family: expect.any(String), weight: 400, italic: false, size: 12 });
      const p0 = r.placements.find((p) => p.id === "p0");
      expect(p0?.text?.line_widths).toEqual([20]);
    });

    it("falls back to the built-in measurement on null", () => {
      const problem = scatter(5);
      const r = la.place(problem, { measure: () => null });
      expect(untimed(r)).toEqual(untimed(la.place(problem)));
    });

    it("rethrows exceptions and rejects malformed metrics", () => {
      const boom = { reason: "not an Error" };
      expect(thrown(() => la.place(scatter(3), { measure: () => { throw boom; } }))).toBe(boom);
      const bad = { measure: () => ({ width: 3 }) } as unknown as PlaceOptions;
      expect(() => la.place(scatter(3), bad)).toThrow(/measure callback/);
    });
  });

  describe("progress", () => {
    it("reports the phases", () => {
      const seen: [string, number][] = [];
      la.place(scatter(5), { progress: (phase, fraction) => void seen.push([phase, fraction]) });
      expect(seen.map((s) => s[0])).toEqual(expect.arrayContaining(["greedy", "local"]));
      for (const [, f] of seen) expect(f).toBeGreaterThanOrEqual(0);
      const boom = new Error("progress");
      expect(thrown(() => la.place(scatter(5), { progress: () => { throw boom; } }))).toBe(boom);
    });
  });

  describe("readFile", () => {
    const svg = readProblem("svg-background.json");
    const markup: string = svg.obstacles.svg.source;
    const byPath = (): AnyProblem => ({ ...svg, obstacles: { svg: { ...svg.obstacles.svg, source: undefined, path: "bg.svg" } } });

    it("reads files referenced by path", () => {
      const paths: string[] = [];
      const r = la.place(byPath(), {
        readFile: (p) => {
          paths.push(p);
          return new TextEncoder().encode(markup);
        },
      });
      expect(paths).toEqual(["bg.svg"]);
      expect(r.placements).toEqual(la.place(svg).placements);
      // a string is accepted as UTF-8 text
      const r2 = la.place(byPath(), { readFile: () => markup as unknown as Uint8Array });
      expect(r2.placements).toEqual(r.placements);
    });

    it("reports files as unavailable without readFile", () => {
      const e = thrown(() => la.place(byPath())) as InstanceType<Wasm["PlaceError"]>;
      expect(e).toBeInstanceOf(la.PlaceError);
      expect(e.errors).toEqual([
        expect.objectContaining({ pointer: "/obstacles/svg/path", code: "invalid_value", message: expect.stringContaining("readFile") }),
      ]);
    });

    it("rethrows exceptions and rejects non-bytes", () => {
      const enoent = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      expect(thrown(() => la.place(byPath(), { readFile: () => { throw enoent; } }))).toBe(enoent);
      expect(() => la.place(byPath(), { readFile: () => 42 as unknown as Uint8Array })).toThrow(/readFile must return a Uint8Array/);
    });
  });

  describe("signal", () => {
    it("an aborted signal stops after the greedy phase", () => {
      const problem = scatter(12);
      const normal = la.place(problem);
      expect(normal.stats.strategy_used).toBe("local");
      const controller = new AbortController();
      controller.abort();
      const r = la.place(problem, { signal: controller.signal });
      expect(r.stats.strategy_used).toBe("greedy");
      expect(r.stats.iterations).toBe(0);
      expect(r.stats.hard_violations).toBe(0);
      const greedy = la.place({ ...problem, solver: { strategy: "greedy" } });
      expect(untimed(r)).toEqual(untimed(greedy));
      expect(la.place(problem, { signal: new AbortController().signal }).stats.strategy_used).toBe("local");
    });
  });

  it("rejects malformed options", () => {
    const p = scatter(2);
    expect(() => la.place(p, 42 as unknown as PlaceOptions)).toThrow(/options must be an object/);
    expect(() => la.place(p, { cost: 5 } as unknown as PlaceOptions)).toThrow(/options.cost must be a function/);
    expect(() => la.place(p, { signal: true } as unknown as PlaceOptions)).toThrow(/options.signal/);
    expect(la.place(p, {}).stats.placed).toBe(2);
    expect(la.place(p, null as unknown as PlaceOptions).stats.placed).toBe(2);
  });
});
