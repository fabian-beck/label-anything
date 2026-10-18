// The explainer's view of a solve agrees with the solver: for every scene (and a few
// option variants), the traced solve gives the untraced result, the free candidates the
// explainer shows at each greedy pick are exactly as many as the solver counted, random
// access to the placement after any step equals replaying the steps in order, and every
// step has an explanation and an overlay that name existing candidates.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BasicEnv, placeTraced, placeWith, validate, type LabelProblem } from "@label-anything/core";
import { beforeAll, describe, expect, it } from "vitest";
import { buildOverlay } from "../src/explain/draw.js";
import { Explained } from "../src/explain/model.js";
import { narrate } from "../src/explain/narrate.js";
import { type ExplainScene, scenes } from "../src/explain/scenes.js";
import { merge } from "../src/util.js";

const WORLD = fileURLToPath(new URL("../data/world.json", import.meta.url));

let all: ExplainScene[] = [];

beforeAll(async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ json: async () => JSON.parse(readFileSync(WORLD, "utf8")) })) as unknown as typeof fetch;
  all = scenes();
  for (const s of all) await s.load(new URL("file:///playground/"));
  globalThis.fetch = fetch;
});

const VARIANTS: [string, Record<string, unknown>][] = [
  ["defaults", {}],
  ["greedy only", { solver: { strategy: "greedy" } }],
  ["no lookahead, short ladder", { weights: { lookahead: 0, starve: 0 }, degrade: ["wrap", "omit"] }],
  ["exact", { solver: { strategy: "exact", max_iterations: 500 } }],
];

function check(problem: LabelProblem): void {
  expect(validate(problem).errors).toEqual([]);
  const { result, trace } = placeTraced(new BasicEnv(), problem, "rust");
  const plain = placeWith(new BasicEnv(), problem, "rust");
  const strip = (r: unknown) => JSON.stringify((r as { placements: unknown[] }).placements);
  expect(strip(result)).toBe(strip(plain));
  const ex = new Explained(trace, result);
  // the groups cover the events without gaps, in order
  expect(ex.groups[0]!.start).toBe(0);
  for (let g = 1; g < ex.groups.length; g++) expect(ex.groups[g]!.start).toBe(ex.groups[g - 1]!.end);
  expect(ex.groups[ex.groups.length - 1]!.end).toBe(ex.length);
  // the free candidates shown at a pick are the solver's live count
  trace.events.forEach((e, k) => {
    if (e.type === "pick" && e.pass === "level0") expect(ex.liveAt(e.item, k).length, `${trace.items[e.item]!.id} at ${k}`).toBe(e.live);
  });
  // random access = replay
  const replay = new Int32Array(trace.items.length).fill(-1);
  const probe = new Set([0, 1, Math.floor(ex.length / 3), Math.floor(ex.length / 2), ex.length - 2, ex.length - 1]);
  const states = new Map<number, string>();
  trace.events.forEach((e, k) => {
    for (const [i, c] of e.changes) replay[i] = c;
    if (probe.has(k)) states.set(k, replay.join());
  });
  for (const k of [...probe].reverse()) expect(ex.placementAt(k).join(), `step ${k}`).toBe(states.get(k));
  // explanations and overlays (every step outside the search, every 37th move)
  trace.events.forEach((e, k) => {
    if (e.type === "move" && k % 37 !== 0) return;
    const n = narrate(ex, k);
    expect(n.title.length, `title of step ${k} (${e.type})`).toBeGreaterThan(0);
    expect(n.html, `step ${k} (${e.type})`).not.toMatch(/undefined|NaN|\[object/);
    const ov = buildOverlay(ex, k, k % 2 === 0 ? 0 : null);
    for (const o of ov.cands) expect(trace.candidates[o.cand], `overlay of step ${k}`).toBeDefined();
  });
}

describe("explainer", () => {
  it("has its scenes", () => {
    expect(all.map((s) => s.id)).toEqual(["europe", "scatter", "lines", "areas"]);
  });

  for (const [name, patch] of VARIANTS) {
    for (const id of ["europe", "scatter", "lines", "areas"]) {
      it(`${id}, ${name}: the explained solve is the solver's`, () => {
        const s = all.find((x) => x.id === id)!;
        check(merge(s.problem(), patch));
      });
    }
  }

  it("shows the ladder, the search and fan labels where the scenes promise them", () => {
    const traceOf = (id: string) => placeTraced(new BasicEnv(), all.find((x) => x.id === id)!.problem(), "rust").trace;
    const eu = traceOf("europe");
    expect(eu.events.some((e) => e.type === "ladder" && e.step === "alternatives" && e.chosen !== null)).toBe(true);
    expect(new Set(eu.items.map((it) => it.key)).size).toBe(3);
    const lines = traceOf("lines");
    expect(lines.events.some((e) => e.type === "pass" && e.what === "fan" && e.kept)).toBe(true);
    const areas = traceOf("areas");
    expect(areas.candidates.some((c) => c.model === "internal")).toBe(true);
    expect(areas.candidates.some((c) => c.blocked === "legend")).toBe(true);
    const sc = traceOf("scatter");
    expect(sc.events.filter((e) => e.type === "move" && e.changes.length > 0).length).toBeGreaterThan(10);
  });
});
