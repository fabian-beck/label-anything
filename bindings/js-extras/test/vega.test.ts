import * as vega from "vega";
import { describe, expect, it } from "vitest";
import { registerVegaTransform } from "../src/vega.js";
import { cliEngine, fakeEngine } from "./engines.js";

const values = [
  { name: "Alpha", x: 1, y: 1, pop: 5 },
  { name: "Beta", x: 2, y: 3, pop: 50 },
  { name: "Gamma", x: 3, y: 2, pop: 20 },
  { name: "Delta", x: 4, y: 4, pop: 1 },
];

function spec(transform: Record<string, unknown>) {
  return {
    width: 300,
    height: 200,
    data: [{ name: "table", values }],
    scales: [
      { name: "x", domain: { data: "table", field: "x" }, range: "width" },
      { name: "y", domain: { data: "table", field: "y" }, range: "height" },
    ],
    marks: [
      {
        name: "trend",
        type: "rule",
        encode: { enter: { x: { value: 0 }, y: { value: 100 }, x2: { value: 300 }, y2: { value: 100 } } },
      },
      {
        name: "points",
        type: "symbol",
        from: { data: "table" },
        encode: { enter: { x: { scale: "x", field: "x" }, y: { scale: "y", field: "y" }, size: { value: 64 } } },
      },
      {
        name: "labels",
        type: "text",
        from: { data: "points" },
        encode: { enter: { text: { field: "datum.name" }, fontSize: { value: 11 } } },
        transform: [{ type: "labelAnything", size: { signal: "[width, height]" }, ...transform }],
      },
    ],
  };
}

async function run(transform: Record<string, unknown>) {
  const view = new vega.View(vega.parse(spec(transform) as vega.Spec), { renderer: "none" });
  await view.runAsync();
  const scene = view.scenegraph().root as unknown as { items: { items: { name?: string; items: Record<string, unknown>[] }[] }[] };
  const mark = scene.items[0]!.items.find((m) => m.name === "labels")!;
  return mark.items;
}

describe("Vega labelAnything transform", () => {
  it("places the text items of a reactive-geometry text mark", async () => {
    const engine = fakeEngine();
    registerVegaTransform(vega as never, { engine });
    const items = await run({ avoidMarks: ["trend"], priority: "datum.datum.pop" });
    const { problem } = engine.last;
    expect(problem.canvas).toEqual({ width: 300, height: 200 });
    expect(problem.items.map((i) => i.priority)).toEqual([5, 50, 20, 1]);
    // symbols are circles around the anchor; the rule is a hard obstacle of class "trend"
    expect(problem.items[0]!.anchor).toMatchObject({ x: 75, y: 150, mark: { shape: "circle" } }); // linear scales include zero
    expect(problem.obstacles?.vector).toEqual([{ class: "trend", polylines: [[[0, 100], [300, 100]]], width: 1 }]);
    expect(problem.avoid?.label).toMatchObject({ trend: "hard" });
    expect(problem.placement?.models).toEqual(["adjacent", "slider"]);
    for (const t of items) {
      expect(t.align).toBe("left");
      expect(t.baseline).toBe("alphabetic");
      expect([0, 1]).toContain(t.opacity);
    }
    const placed = engine.place(problem, {}).placements.filter((p) => p.placed).length;
    expect(items.filter((t) => t.opacity === 1).length).toBe(placed);
  });

  it("orders by the sort comparator when there is no priority field", async () => {
    const engine = fakeEngine();
    registerVegaTransform(vega as never, { engine });
    await run({ sort: { field: "datum.pop", order: "descending" } });
    expect(engine.last.problem.items.map((i) => i.priority)).toEqual([2, 4, 3, 1]);
  });

  it("writes leader paths when leaders are enabled", async () => {
    const engine = fakeEngine();
    registerVegaTransform(vega as never, { engine });
    const items = await run({ leaders: "straight" });
    expect(engine.last.problem.leaders).toEqual({ style: "straight" });
    expect(items.every((t) => typeof t.leaderPath === "string")).toBe(true);
  });

  it.skipIf(!cliEngine)("solves with the Rust engine", async () => {
    registerVegaTransform(vega as never, { engine: cliEngine! });
    const items = await run({ avoidMarks: ["trend"] });
    expect(items.filter((t) => t.opacity === 1).length).toBe(4);
    // no label crosses the trend line at y = 100
    for (const t of items) {
      const y = t.y as number;
      expect(y - 11 * 0.8 > 100 || y + 11 * 0.2 < 100).toBe(true);
    }
  });
});
