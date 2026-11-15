// Port of rust/crates/la-core/tests/pinned.rs: pinned labels (spec §10.1, ADR
// motion/pinned-labels). With `warm_start.pin`, a view that only moved keeps every label
// where it is. The solve adds labels around them.
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { solveWith } from "../src/place.js";

/** No clock: the solve is deterministic. */
const NO_CLOCK: Env = {};

type Placement = { id: string; placed: boolean; box?: { x: number; y: number }; anchor?: [number, number]; reason?: string };
type Res = { stats: Record<string, unknown>; placements: Placement[] };
type Obj = Record<string, unknown>;
type Place = [id: string, x: number, y: number, pop: number];

const solve = (p: Obj): Res => solveWith(p, NO_CLOCK) as unknown as Res;

/** Deterministic pseudo-random numbers in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

const W = 400;
const H = 300;
// The map is labeled this far beyond the view, and its points are known that far beyond
// that again: farther than a label reaches from its point.
const OVERSCAN = 60;
const MARKS = 130;

/** Places of a map of 2000 × 1400 px with a priority each. */
function places(n: number): Place[] {
  const r = lcg(5);
  return Array.from({ length: n }, (_, i) => {
    const x = Math.round(r() * 2000);
    const y = Math.round(r() * 1400);
    return [`p${i}`, x, y, Math.round(r() * 1000)] as Place;
  });
}

/** The problem of a view whose top-left corner is at (`cx`, `cy`) of the map. */
function view(all: Place[], cx: number, cy: number, warm?: Obj): Obj {
  const reach = OVERSCAN + MARKS;
  const items = all
    .map(([id, x, y, pop]) => [id, x - cx, y - cy, pop] as Place)
    .filter(([, x, y]) => x >= -reach && y >= -reach && x <= W + reach && y <= H + reach)
    .map(([id, x, y, pop]) => ({
      id,
      priority: pop,
      anchor: { type: "point", x, y, mark: { shape: "circle", r: 3 } },
      label: { type: "text", text: id, width: 46, height: 14, padding: 0 },
    }));
  return {
    version: "1",
    preset: "map",
    items,
    canvas: { width: W, height: H, overscan: OVERSCAN },
    ...(warm ? { warm_start: warm } : {}),
  };
}

/** The offset of a placed label from its anchor. */
const offset = (p: Placement): [number, number] | null => (p.box && p.anchor ? [p.box.x - p.anchor[0], p.box.y - p.anchor[1]] : null);

/** Pans the view in 40 steps; the labels that are kept, moved and lost on the way, and the labels that came. */
function pan(all: Place[], pin: boolean): { kept: number; moved: number; lost: number; came: number } {
  const t = { kept: 0, moved: 0, lost: 0, came: 0 };
  let prev = solve(view(all, 700, 500));
  for (let step = 1; step <= 40; step++) {
    const r = solve(view(all, 700 + 7 * step, 500 + 3 * step, { pin, placements: prev.placements }));
    expect(r.stats.hard_violations).toBe(0);
    if (pin) {
      expect(r.stats.strategy_used).toBe("greedy");
      expect(r.stats.pinned as number).toBeGreaterThan(20);
    } else expect(r.stats.pinned).toBeUndefined();
    const before = new Map(prev.placements.map((p) => [p.id, offset(p)]));
    for (const p of r.placements) {
      const a = before.get(p.id) ?? null;
      const b = offset(p);
      if (a !== null && b === null) {
        // a point that left the working extent is a mark only: its label is gone
        if (p.reason !== "outside") t.lost++;
      } else if (a !== null && b !== null) {
        if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) t.kept++;
        else t.moved++;
      } else if (b !== null) t.came++;
    }
    prev = r;
  }
  return t;
}

describe("pinned labels (warm_start.pin)", () => {
  it("a pan moves no label and loses none", () => {
    const all = places(1400);
    const pinned = pan(all, true);
    expect([pinned.moved, pinned.lost]).toEqual([0, 0]);
    expect(pinned.kept).toBeGreaterThan(1500);
    expect(pinned.came).toBeGreaterThan(40);
    // the same pan with warm starts alone: labels move, and some lose their place
    const warm = pan(all, false);
    expect(warm.moved + warm.lost).toBeGreaterThan(40);
  });

  it("the points beyond the overscan are marks only", () => {
    const all = places(1400);
    const r = solve(view(all, 700, 500));
    let inside = 0;
    let beyond = 0;
    for (const p of r.placements) {
      const [, px, py] = all.find((a) => a[0] === p.id)!;
      const [x, y] = [px - 700, py - 500];
      // (the mark's bounding box against the working extent)
      const out = x + 3 < -OVERSCAN || y + 3 < -OVERSCAN || x - 3 > W + OVERSCAN || y - 3 > H + OVERSCAN;
      expect(p.reason === "outside", p.id).toBe(out);
      if (out) {
        expect(p.placed).toBe(false);
        beyond++;
      } else inside++;
    }
    expect(inside).toBeGreaterThan(60);
    expect(beyond).toBeGreaterThan(60);
  });

  // with both it is pinned, also where a fresh solve would not put it; a warm start
  // without the rotation is another label's
  it("a turned label is pinned with its rotation", () => {
    type Turned = { stats: Record<string, unknown>; placements: { box: { x: number; y: number }; anchor: [number, number]; rotation: number }[] };
    // a strip of 220 × 26 px at 30° around (`cx`, `cy`): its label only fits along it
    const [c, s] = [Math.cos((30 * Math.PI) / 180), Math.sin((30 * Math.PI) / 180)];
    const problem = (cx: number, cy: number, warm?: Obj): Turned =>
      solve({
        version: "1",
        canvas: { width: 300, height: 200 },
        items: [
          {
            id: "fjord",
            anchor: { type: "area", polygon: [[-110, -13], [110, -13], [110, 13], [-110, 13]].map(([x, y]) => [cx + x! * c - y! * s, cy + x! * s + y! * c]) },
            label: { type: "text", text: "Fjord", width: 60, height: 14, padding: 0 },
          },
        ],
        ...(warm ? { warm_start: warm } : {}),
      }) as unknown as Turned;
    const p = problem(150, 100).placements[0]!;
    expect(Math.abs(p.rotation - 30)).toBeLessThan(0.01);
    // the label as it was shown: 40 px along the strip from where a fresh solve has it
    const shown = { x: p.box.x + 40 * c, y: p.box.y + 40 * s, w: 60, h: 14 };
    const warm = (rotation: boolean): Obj => ({
      pin: true,
      placements: [{ id: "fjord", placed: true, box: shown, anchor: p.anchor, ...(rotation ? { rotation: p.rotation } : {}) }],
    });
    // the view moves by (40, 10), and the label with it
    const pinned = problem(190, 110, warm(true));
    const q = pinned.placements[0]!;
    expect(pinned.stats.pinned).toBe(1);
    expect(Math.abs(q.box.x - shown.x - 40)).toBeLessThan(1e-9);
    expect(Math.abs(q.box.y - shown.y - 10)).toBeLessThan(1e-9);
    expect(q.rotation).toBe(p.rotation);
    // without the rotation the warm start is an upright box, which does not fit the strip
    const upright = problem(190, 110, warm(false)).placements[0]! as unknown as { rotation?: number; model: string };
    expect(upright.rotation).toBeUndefined();
    expect(upright.model).not.toBe("internal");
  });
});
