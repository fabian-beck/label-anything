// Port of rust/crates/la-core/tests/window.rs: windows (spec §2.3, ADR motion/windows).
// With `canvas.overscan` the canvas shows part of a larger drawing. Labels are placed as if
// the drawing went on beyond its edges, so a label near an edge keeps its place when the
// view moves it across.
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { solveWith } from "../src/place.js";

/** No clock: the solve is deterministic. */
const NO_CLOCK: Env = {};

type Box = { x: number; y: number; w: number; h: number };
type Res = { stats: { placed: number }; placements: { id: string; placed: boolean; box?: Box }[] };
type Obj = Record<string, unknown>;

const solve = (p: Obj): Res => solveWith(p, NO_CLOCK) as unknown as Res;

/** Deterministic pseudo-random numbers in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/** Points of a map of 900 × 700 px, with labels of a fixed size (no font needed). */
function mapPoints(n: number): [string, number, number][] {
  const r = lcg(11);
  return Array.from({ length: n }, (_, i) => [`p${i}`, Math.round(r() * 900), Math.round(r() * 700)]);
}

const item = (id: string, x: number, y: number): Obj => ({
  id,
  anchor: { type: "point", x, y, mark: { shape: "circle", r: 3 } },
  label: { type: "text", text: id, width: 46, height: 14, padding: 0 },
});

const boxOf = (r: Res, id: string): Box | undefined => r.placements.find((p) => p.id === id)?.box;

describe("windows (canvas.overscan)", () => {
  // the same grids, the same candidates, no edge
  it("a window is the middle of a larger canvas, where labels may leave it", () => {
    const [w, h, m] = [400, 300, 48];
    const pts = mapPoints(160)
      .map(([id, x, y]) => [id, x - 250, y - 200] as [string, number, number])
      .filter(([, x, y]) => x >= -m && y >= -m && x <= w + m && y <= h + m);
    expect(pts.length).toBeGreaterThan(40);
    const road = (d: number) => ({
      vector: [{ class: "lines", width: 2, polylines: [[[-80 + d, 40 + d], [200 + d, 180 + d], [520 + d, 90 + d]]] }],
    });
    const window = solve({
      version: "1",
      canvas: { width: w, height: h, overscan: m },
      preset: "map",
      obstacles: road(0),
      items: pts.map(([id, x, y]) => item(id, x, y)),
    });
    const larger = solve({
      version: "1",
      canvas: { width: w + 2 * m, height: h + 2 * m, allow_outside: true },
      preset: "map",
      obstacles: road(m),
      items: pts.map(([id, x, y]) => item(id, x + m, y + m)),
    });
    expect(window.placements.length).toBe(larger.placements.length);
    let crossing = 0;
    window.placements.forEach((a, i) => {
      const b = larger.placements[i]!;
      expect(a.id).toBe(b.id);
      expect(a.placed, a.id).toBe(b.placed);
      if (!a.box || !b.box) return;
      expect(Math.abs(a.box.x + m - b.box.x), a.id).toBeLessThan(1e-6);
      expect(Math.abs(a.box.y + m - b.box.y), a.id).toBeLessThan(1e-6);
      const p = a.box;
      const inside = p.x >= 0 && p.y >= 0 && p.x + p.w <= w && p.y + p.h <= h;
      const outside = p.x >= w || p.y >= h || p.x + p.w <= 0 || p.y + p.h <= 0;
      if (!inside && !outside) crossing++;
    });
    expect(crossing).toBeGreaterThanOrEqual(3);
  });

  /** One frame of a view that pans to the right by `pan` px: `r` comes to the right edge and leaves the canvas. */
  const frame = (pan: number, canvas: Obj, warm?: Res): Res =>
    solve({
      version: "1",
      canvas,
      items: [item("r", 130 + pan, 50), item("a", 60 + pan, 30), item("b", 40 + pan, 75)],
      ...(warm ? { warm_start: warm } : {}),
    });

  it("a label keeps its place while the view moves it across the edge", () => {
    const window = { width: 160, height: 100, overscan: 60 };
    const first = frame(0, window);
    const b0 = boxOf(first, "r")!;
    const offset = b0.x - 130;
    let prev = first;
    // 5 px inside the edge, on it, 20 and 50 px beyond it
    for (const pan of [25, 30, 50, 80]) {
      const r = frame(pan, window, prev);
      const b = boxOf(r, "r")!;
      expect(b, `pan ${pan}`).toBeDefined();
      expect(Math.abs(b.x - (130 + pan + offset)), `pan ${pan}`).toBeLessThan(1e-9);
      expect(b.y, `pan ${pan}`).toBe(b0.y);
      prev = r;
    }
    // the same view without the overscan: the canvas edge pushes the label aside
    const contained = { width: 160, height: 100 };
    const c0 = frame(0, contained);
    expect(boxOf(c0, "r")).toEqual(b0);
    const c1 = frame(25, contained, c0);
    expect(Math.abs(boxOf(c1, "r")!.x - (155 + offset))).toBeGreaterThan(1);
  });

  it("the label of an area passed whole stays with its area, wherever the window is", () => {
    const outline = [
      [40, 30],
      [330, 20],
      [360, 120],
      [250, 190],
      [70, 160],
    ];
    const at = (dx: number, dy: number): [number, number] => {
      const r = solve({
        version: "1",
        canvas: { width: 200, height: 150, overscan: 40 },
        items: [
          {
            id: "a",
            anchor: { type: "area", polygon: outline.map(([x, y]) => [x! + dx, y! + dy]) },
            label: { type: "text", text: "Area", width: 60, height: 14, padding: 0 },
          },
        ],
      });
      const b = boxOf(r, "a")!;
      return [b.x - dx, b.y - dy];
    };
    const home = at(0, 0);
    // into view, half out of it, out of it and beyond the overscan
    for (const [dx, dy] of [
      [-60, 0],
      [-150, -40],
      [-320, 10],
      [500, 300],
    ]) {
      const p = at(dx!, dy!);
      expect(Math.abs(p[0] - home[0]), `moved by (${dx}, ${dy})`).toBeLessThan(1e-6);
      expect(Math.abs(p[1] - home[1]), `moved by (${dx}, ${dy})`).toBeLessThan(1e-6);
    }
  });

  // the greedy pass alone: it is the pass that keeps to this budget
  it("the ink budget is a fraction of the working extent", () => {
    // labels of 40 × 20 px: 2 % of the extent of 200 × 200 px, 8 % of the canvas
    const problem = (canvas: Obj): Obj => ({
      version: "1",
      canvas,
      solver: { strategy: "greedy" },
      priority: { budget: { max_ink_fraction: 0.05 } },
      items: [
        [30, 30],
        [70, 70],
        [130, 130],
      ].map(([x, y], i) => ({
        id: `l${i}`,
        anchor: { type: "point", x, y },
        label: { type: "text", text: "L", width: 40, height: 20, padding: 0 },
      })),
    });
    expect(solve(problem({ width: 100, height: 100, overscan: 50 })).stats.placed).toBe(2);
    expect(solve(problem({ width: 100, height: 100 })).stats.placed).toBe(0);
  });
});
