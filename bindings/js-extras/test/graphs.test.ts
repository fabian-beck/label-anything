// @vitest-environment jsdom
import cytoscape from "cytoscape";
import type { LabelResult } from "@label-anything/core";
import { describe, expect, it, vi } from "vitest";
import { labelCytoscape } from "../src/cytoscape.js";
import { labelSigma, type SigmaLike } from "../src/sigma.js";
import { cliEngine, fakeEngine, overlaps } from "./engines.js";

function graph() {
  return cytoscape({
    headless: true,
    styleEnabled: true,
    layout: { name: "preset" },
    elements: [
      { data: { id: "a", label: "Alpha" }, position: { x: 0, y: 0 } },
      { data: { id: "b", label: "Beta" }, position: { x: 120, y: 0 } },
      { data: { id: "c", label: "Gamma" }, position: { x: 60, y: 80 } },
      { data: { id: "hub" }, position: { x: 60, y: 30 } },
      { data: { id: "ab", source: "a", target: "b" } },
      { data: { id: "ac", source: "a", target: "c" } },
    ],
    style: [
      { selector: "node", style: { label: "data(label)", width: 20, height: 20, "font-size": 12 } },
      { selector: "edge", style: { width: 2 } },
    ],
  });
}

describe("Cytoscape labels", () => {
  it("solves in model coordinates and positions Cytoscape's own labels", () => {
    const cy = graph();
    const engine = fakeEngine();
    const labels = labelCytoscape(cy as never, { engine, priority: (n) => (n.id() === "b" ? 10 : 1), measure: false });
    const { problem } = engine.last;
    expect(problem.canvas).toBeUndefined(); // unbounded: the solve does not depend on the viewport
    expect(problem.items.map((i) => [i.id, i.priority])).toEqual([["a", 1], ["b", 10], ["c", 1]]);
    expect(problem.items[0]!.anchor).toMatchObject({ x: 0, y: 0, mark: { shape: "circle", r: 10 } });
    expect(problem.items[0]!.label).toMatchObject({ type: "text", text: "Alpha", font: { size: 12 } });
    const vector = problem.obstacles!.vector!;
    expect(vector.find((v) => v.class === "nodes")!.shapes).toEqual([{ shape: "circle", r: 10, x: 60, y: 30 }]);
    expect(vector.find((v) => v.class === "edges")!.polylines!.length).toBe(2);
    expect(problem.avoid?.label).toMatchObject({ nodes: "hard" });
    const a = labels.result!.placements[0]!;
    const node = cy.getElementById("a");
    expect(node.style("text-valign")).toBe("center");
    expect(Number.parseFloat(node.style("text-margin-x"))).toBeCloseTo(a.box!.x + a.box!.w / 2, 6);
    labels.remove();
    expect(node.style("text-valign")).toBe("top"); // Cytoscape default again
    expect(Number.parseFloat(node.style("text-margin-x"))).toBe(0);
  });

  it("re-solves after graph changes", async () => {
    const cy = graph();
    const engine = fakeEngine();
    labelCytoscape(cy as never, { engine, debounce: 1, measure: false });
    cy.add({ data: { id: "d", label: "Delta" }, position: { x: 200, y: 50 } });
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.calls.length).toBe(2);
    expect(engine.last.problem.items.map((i) => i.id)).toContain("d");
  });

  it.skipIf(!cliEngine)("solves with the Rust engine", () => {
    const cy = graph();
    const labels = labelCytoscape(cy as never, { engine: cliEngine!, measure: false });
    expect(labels.result!.placements.filter((p) => p.placed).length).toBe(3);
    expect(overlaps(labels.result!)).toEqual([]);
  });
});

function fakeSigma() {
  const nodes: Record<string, { x: number; y: number; size: number; label: string }> = {
    a: { x: 10, y: 10, size: 5, label: "Alpha" },
    b: { x: 100, y: 10, size: 5, label: "Beta" },
    c: { x: 50, y: 80, size: 5, label: "Gamma" },
  };
  const settings: Record<string, unknown> = { labelFont: "Arial", labelSize: 14, labelWeight: "normal", defaultDrawNodeLabel: () => {}, nodeReducer: null };
  const cam = new Map<string, () => void>();
  const camera = { x: 0, on: (e: string, f: () => void) => cam.set(e, f), removeListener: (e: string) => cam.delete(e) };
  let refreshes = 0;
  const renderer: SigmaLike & { fire(): void; camera: typeof camera; refreshes(): number; settings: typeof settings } = {
    settings,
    camera,
    getGraph: () => ({
      forEachNode: (f) => Object.entries(nodes).forEach(([k, v]) => f(k, { ...v })),
      forEachEdge: (f) => f("ab", {}, "a", "b"),
    }),
    getNodeDisplayData: (k) => nodes[k] && { ...nodes[k]! },
    framedGraphToViewport: (p) => ({ x: p.x + camera.x, y: p.y }),
    getDimensions: () => ({ width: 300, height: 200 }),
    getSetting: (k) => settings[k],
    setSetting: (k, v) => (settings[k] = v),
    getCamera: () => camera,
    on: () => undefined,
    refresh: () => void refreshes++,
    fire: () => cam.get("updated")?.(),
    refreshes: () => refreshes,
  };
  return renderer;
}

describe("sigma labels", () => {
  it("draws placed labels at the solved offset and hides the others", async () => {
    const r = fakeSigma();
    const engine = fakeEngine();
    const labels = labelSigma(r, { engine, debounce: 1, measure: false });
    const { problem } = engine.last;
    expect(problem.canvas).toEqual({ width: 300, height: 200 });
    expect(problem.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(problem.obstacles!.vector![0]).toMatchObject({ class: "edges", polylines: [[[10, 10], [100, 10]]] });
    expect(r.refreshes()).toBe(1);
    const reducer = r.settings.nodeReducer as (k: string, d: object) => { forceLabel?: boolean; label?: string | null };
    expect(reducer("a", { label: "Alpha" }).forceLabel).toBe(true);
    // canvas drawing at the placed box, following the node
    const calls: [string, number, number][] = [];
    const ctx = { save() {}, restore() {}, fillText: (t: string, x: number, y: number) => calls.push([t, x, y]) } as unknown as CanvasRenderingContext2D;
    const draw = r.settings.defaultDrawNodeLabel as (c: CanvasRenderingContext2D, d: object, s: object) => void;
    const box = labels.result!.placements[0]!.box!;
    draw(ctx, { key: "a", x: 10, y: 10, size: 5 }, {});
    draw(ctx, { key: "a", x: 30, y: 10, size: 5 }, {});
    expect(calls[0]![1]).toBeCloseTo(box.x, 6);
    expect(calls[1]![1]).toBeCloseTo(box.x + 20, 6);
    // camera moves re-solve (debounced) with a warm start
    r.camera.x = 5;
    r.fire();
    await new Promise((res) => setTimeout(res, 20));
    expect(engine.calls.length).toBe(2);
    expect(engine.last.problem.warm_start?.placements.length).toBe(3);
    labels.remove();
    expect(r.settings.nodeReducer).toBeNull();
  });

  it("moves labels smoothly into the places of a new solve once they have held", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout", "clearTimeout"] });
    try {
      const r = fakeSigma();
      const base = fakeEngine();
      let second = false;
      const engine = {
        place(problem: Parameters<typeof base.place>[0], options?: Parameters<typeof base.place>[1]) {
          const res = base.place(problem, options) as LabelResult;
          if (!second) return res;
          return { ...res, placements: res.placements.map((p) => (p.id === "a" ? { ...p, box: { ...p.box!, y: p.box!.y + 20 } } : p)) } as LabelResult;
        },
      };
      const labels = labelSigma(r, { engine, debounce: 1, measure: false });
      const draw = r.settings.defaultDrawNodeLabel as (c: CanvasRenderingContext2D, d: object, s: object) => void;
      const yAt = () => {
        let y = NaN;
        const ctx = { save() {}, restore() {}, fillText: (_t: string, _x: number, yy: number) => (y = yy) } as unknown as CanvasRenderingContext2D;
        draw(ctx, { key: "a", x: 10, y: 10, size: 5 }, {});
        return y;
      };
      const y0 = yAt();
      second = true;
      r.fire();
      vi.advanceTimersByTime(5); // the debounced solve
      const refreshes = r.refreshes();
      vi.advanceTimersByTime(150);
      expect(r.refreshes()).toBeGreaterThan(refreshes + 3); // redrawn on animation frames
      expect(yAt()).toBeCloseTo(y0, 6); // the move delay (500 ms)
      vi.advanceTimersByTime(500);
      expect(yAt()).toBeGreaterThan(y0 + 1);
      expect(yAt()).toBeLessThan(y0 + 20);
      vi.advanceTimersByTime(600);
      expect(yAt()).toBeCloseTo(y0 + 20, 6);
      labels.remove();
    } finally {
      vi.useRealTimers();
    }
  });
});
