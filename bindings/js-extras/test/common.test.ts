// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { LabelResult } from "@label-anything/core";
import { LatestRunner, resolveEngine, setDefaultEngine, type AsyncEngine } from "../src/engine.js";
import { buildProblem, keepHostText, labelOf, resolveFont } from "../src/options.js";
import { followAnchors, leaderPath, renderLabels } from "../src/render.js";
import { LabelMemory } from "../src/stable.js";
import { fakeEngine } from "./engines.js";

const font = resolveFont({ family: "Arial", size: 10 });

describe("buildProblem", () => {
  const base = { canvas: { width: 100, height: 80 }, items: [] };

  it("sets the font and merges the option sections", () => {
    const p = buildProblem(base, { preset: "scatter", padding: 3, avoid: { label: { points: 0.5 } } }, font);
    expect(p.defaults?.font).toEqual({ family: "Arial", size: 10, weight: 400, style: "normal" });
    expect(p.preset).toBe("scatter");
    expect(p.canvas).toEqual({ width: 100, height: 80, padding: 3 });
    expect(p.avoid).toEqual({ label: { points: 0.5 } });
  });

  it("turns a leader style into distant labels and false into none", () => {
    expect(buildProblem(base, { leaders: "elbow" }, font)).toMatchObject({
      leaders: { style: "elbow" },
      placement: { models: ["adjacent", "slider", "distant"] },
    });
    const off = buildProblem(base, { leaders: false, placement: { models: ["adjacent", "distant", "boundary"] } }, font);
    expect(off.placement?.models).toEqual(["adjacent"]);
  });

  it("applies `problem` last and takes a priority section", () => {
    const p = buildProblem(base, { priority: { omission: "prefix" }, problem: { canvas: { width: 5, height: 5 } } }, font);
    expect(p.priority).toEqual({ omission: "prefix" });
    expect(p.canvas).toEqual({ width: 5, height: 5 });
  });

  it("keeps host-drawn text as it is: no wrap, truncate or shrink steps", () => {
    expect(keepHostText({ ...base }).degrade).toEqual(["alternatives", "distant", "evict_lower", "soft_overlap", "omit"]);
    expect(keepHostText({ ...base, degrade: ["wrap", "truncate", "shrink:0.9", "distant", "omit"] }).degrade).toEqual(["distant", "omit"]);
  });
});

describe("labelOf", () => {
  it("accepts accessors, field names and label objects", () => {
    expect(labelOf({ text: (d: { n: string }) => d.n }, { n: "A" }, 0)).toEqual({ type: "text", text: "A" });
    expect(labelOf({ text: "name" }, { name: 7 }, 0)).toEqual({ type: "text", text: "7" });
    expect(labelOf({ text: () => ({ type: "box", width: 3, height: 4 }) }, {}, 0)).toEqual({ type: "box", width: 3, height: 4 });
    expect(labelOf({ text: () => "" }, {}, 0)).toBeNull();
  });
});

describe("engines", () => {
  it("uses the default engine when none is given", () => {
    const e = fakeEngine();
    setDefaultEngine(e);
    try {
      expect(resolveEngine()).toBe(e);
    } finally {
      setDefaultEngine(undefined);
    }
  });

  it("keeps only the latest asynchronous result", async () => {
    const fake = fakeEngine();
    const resolvers: (() => void)[] = [];
    const slow: AsyncEngine = {
      place: (p, o) => new Promise<LabelResult>((res) => resolvers.push(() => res(fake.place(p, o)))),
    };
    const runner = new LatestRunner(slow);
    const got: number[] = [];
    const problem = (n: number) => ({ canvas: { width: 10, height: 10 }, items: [], solver: { seed: n } });
    runner.run(problem(1), {}, () => got.push(1), () => got.push(-1));
    runner.run(problem(2), {}, () => got.push(2), () => got.push(-2));
    expect(runner.busy).toBe(true);
    resolvers[1]!();
    resolvers[0]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual([2]);
    expect(runner.busy).toBe(false);
  });
});

const result: LabelResult = {
  version: "1",
  placements: [
    {
      id: "a",
      placed: true,
      box: { x: 10, y: 20, w: 30, h: 12 },
      text: { lines: ["Alpha"], used: "original", baseline_offsets: [9.5], x_offset: 1, font_size: 10 },
      leader: { points: [[0, 0], [5, 5], [10, 26]], style: "straight", port: [10, 26] },
    },
    {
      id: "b",
      placed: true,
      box: { x: 50, y: 50, w: 20, h: 24 },
      text: { lines: ["Be", "ta"], used: "original", baseline_offsets: [9.5, 21.5], x_offset: 1, font_size: 12 },
    },
    { id: "c", placed: false, reason: "omitted_by_priority" },
  ],
  stats: {} as LabelResult["stats"],
};

describe("renderLabels", () => {
  it("draws texts (with tspans for several lines) above leaders", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.appendChild(g);
    renderLabels(g, result, { font, halo: "white" });
    const texts = g.querySelectorAll("text");
    expect(texts.length).toBe(2);
    expect(texts[0]!.getAttribute("x")).toBe("11");
    expect(texts[0]!.getAttribute("y")).toBe("29.5");
    expect(texts[0]!.textContent).toBe("Alpha");
    expect(texts[1]!.getAttribute("font-size")).toBe("12");
    expect(Array.from(texts[1]!.querySelectorAll("tspan")).map((t) => t.getAttribute("y"))).toEqual(["59.5", "71.5"]);
    expect(g.querySelectorAll("path.la-leader").length).toBe(1);
    expect(g.firstElementChild!.getAttribute("class")).toBe("la-leaders");
    expect(g.lastElementChild!.getAttribute("stroke")).toBe("white");
    // the boxes start at x: inherited alignment (e.g. Observable Plot's) must not apply
    expect(g.lastElementChild!.getAttribute("text-anchor")).toBe("start");
    expect(g.lastElementChild!.getAttribute("dominant-baseline")).toBe("alphabetic");
    renderLabels(g, { ...result, placements: [] }, { font });
    expect(g.querySelectorAll("text").length).toBe(0);
  });

  it("dims labels and leaders that fade", () => {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    renderLabels(g, result, { font, opacity: new Map([["a", 0.5]]), leaderOpacity: new Map([["a", 0.25]]) });
    expect(g.querySelector('g[data-id="a"]')!.getAttribute("opacity")).toBe("0.5");
    expect(g.querySelector('path[data-id="a"]')!.getAttribute("opacity")).toBe("0.25");
    expect(g.querySelector('g[data-id="b"]')!.hasAttribute("opacity")).toBe(false);
  });

  it("writes leader paths, curves and underlines", () => {
    expect(leaderPath({ points: [[0, 0], [1.234, 2]], style: "straight", port: [1.234, 2] })).toBe("M0,0L1.23,2");
    expect(
      leaderPath({ points: [[0, 0], [2, 2]], style: "curved", port: [2, 2], curve: [[0, 0], [1, 0], [2, 2]], underline: [[2, 2], [9, 2]] }),
    ).toBe("M0,0Q1,0 2,2M2,2L9,2");
  });
});

describe("following anchors", () => {
  it("moves labels and leaders with their anchors and hides vanished ones", () => {
    const before = new Map([["a", [0, 0] as const], ["b", [50, 50] as const]]);
    const after = new Map([["a", [3, 4] as const]]);
    const moved = followAnchors(result, before, after);
    expect(moved.placements[0]!.box).toEqual({ x: 13, y: 24, w: 30, h: 12 });
    expect(moved.placements[0]!.leader!.points[2]).toEqual([13, 30]);
    expect(moved.placements[1]!.placed).toBe(false);
  });

  it("warm-starts from the previous result at the new anchor positions", () => {
    const m = new LabelMemory();
    expect(m.warmStart(new Map())).toBeUndefined();
    m.remember(result, new Map([["a", [0, 0] as const], ["c", [1, 1] as const]]));
    expect(m.warmStart(new Map([["a", [10, -5] as const], ["c", [2, 2] as const]]))).toEqual({
      placements: [
        { id: "a", placed: true, box: { x: 20, y: 15, w: 30, h: 12 } },
        { id: "c", placed: false },
      ],
    });
  });
});
