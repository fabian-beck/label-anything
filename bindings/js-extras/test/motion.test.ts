import type { LabelResult } from "@label-anything/core";
import { describe, expect, it } from "vitest";
import { LabelMotion } from "../src/motion.js";

type Placement = LabelResult["placements"][number];

/** A label `[id, x, y, w, h]` of an item at `anchor`; `extra` adds fields (leader, text). */
function lab(id: string, box: [number, number, number, number], anchor: [number, number], extra: Partial<Placement> = {}): Placement {
  const [x, y, w, h] = box;
  return { id, placed: true, box: { x, y, w, h }, anchor, anchor_side: "right", model: "adjacent", leader: null, ...extra };
}

function result(...placements: Placement[]): LabelResult {
  return { version: "1", placements, stats: {} } as unknown as LabelResult;
}

const boxOf = (f: { result: LabelResult }, id: string) => f.result.placements.find((p) => p.id === id)?.box;

describe("LabelMotion", () => {
  it("shows the first result at once and follows the anchors", () => {
    const m = new LabelMotion();
    m.target(result(lab("a", [12, 0, 30, 10], [10, 5]), lab("b", [50, 20, 20, 10], [48, 25])), undefined, 0);
    expect(m.moving).toBe(false);
    const f = m.frame(undefined, 0);
    expect(boxOf(f, "a")).toEqual({ x: 12, y: 0, w: 30, h: 10 });
    expect(f.opacity.size).toBe(0);
    // the anchors moved: the labels move along
    const g = m.frame(new Map<string, [number, number]>([["a", [15, 2]], ["b", [48, 25]]]), 10);
    expect(boxOf(g, "a")).toEqual({ x: 17, y: -3, w: 30, h: 10 });
    expect(g.result.placements.find((p) => p.id === "a")!.anchor).toEqual([15, 2]);
  });

  it("glides to a new place without overshooting and settles within the duration", () => {
    const m = new LabelMotion({ duration: 300 });
    m.target(result(lab("a", [12, 0, 30, 10], [10, 5])), undefined, 0);
    m.target(result(lab("a", [42, 0, 30, 10], [10, 5])), undefined, 1000);
    expect(m.moving).toBe(true);
    const xs: number[] = [];
    for (let t = 1000; t <= 1300; t += 10) xs.push(boxOf(m.frame(undefined, t), "a")!.x);
    expect(xs[0]).toBe(12);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]!);
    expect(Math.max(...xs)).toBeLessThanOrEqual(42);
    expect(xs[15]!).toBeGreaterThan(20); // half way through, well on its way
    expect(42 - xs[xs.length - 1]!).toBeLessThan(0.02 * 30 + 1e-9);
    m.frame(undefined, 2000);
    expect(boxOf(m.frame(undefined, 2000), "a")!.x).toBe(42);
    expect(m.moving).toBe(false);
  });

  it("fades new labels in and gone labels out", () => {
    const m = new LabelMotion({ duration: 200 });
    m.target(result(lab("a", [0, 0, 10, 10], [0, 0]), lab("b", [30, 0, 10, 10], [30, 0])), undefined, 0);
    m.target(result(lab("a", [0, 0, 10, 10], [0, 0]), lab("c", [60, 0, 10, 10], [60, 0])), undefined, 100);
    let f = m.frame(undefined, 100);
    expect(f.opacity.get("c")).toBe(0);
    expect(f.opacity.has("b")).toBe(false); // still fully visible
    expect(f.result.placements.map((p) => p.id)).toEqual(["b", "a", "c"]); // fading ones first, below
    f = m.frame(undefined, 200);
    expect(f.opacity.get("c")).toBeCloseTo(0.5, 9);
    expect(f.opacity.get("b")).toBeCloseTo(0.5, 9);
    expect(f.result.placements[0]!.id).toBe("b");
    f = m.frame(undefined, 300);
    expect(f.result.placements.map((p) => p.id).sort()).toEqual(["a", "c"]);
    expect(f.opacity.size).toBe(0);
    expect(m.moving).toBe(false);
  });

  it("lets a label that is gone for one solve only dim", () => {
    const m = new LabelMotion({ duration: 300 });
    const a = lab("a", [0, 0, 10, 10], [0, 0]);
    const b = lab("b", [30, 0, 10, 10], [30, 0]);
    m.target(result(a, b), undefined, 0);
    m.target(result(a), undefined, 1000);
    m.target(result(a, lab("b", [30, 5, 10, 10], [30, 0])), undefined, 1100);
    const ops: number[] = [];
    for (let t = 1100; t <= 1400; t += 50) ops.push(m.frame(undefined, t).opacity.get("b") ?? 1);
    expect(Math.min(...ops)).toBeCloseTo(2 / 3, 9);
    expect(ops[ops.length - 1]).toBe(1);
    // it glides to its new place instead of popping up there
    const y = boxOf(m.frame(undefined, 1150), "b")!.y;
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(5);
  });

  it("attaches leaders to the gliding box and fades out a leader that is no longer needed", () => {
    const m = new LabelMotion({ duration: 300 });
    const near = lab("a", [104, 95, 30, 10], [100, 100]);
    const leader = { points: [[104, 98], [140, 80]] as [number, number][], style: "straight" as const, port: [140, 80] as [number, number] };
    const far = lab("a", [140, 75, 30, 10], [100, 100], { leader, model: "distant", anchor_side: "distant" });
    m.target(result(near), undefined, 0);
    m.target(result(far), undefined, 1000);
    let f = m.frame(undefined, 1100);
    let p = f.result.placements[0]!;
    // mid-way: the leader starts 4.47 px from the anchor (as in the result) and ends on the box
    const [s0, port] = [p.leader!.points[0]!, p.leader!.port];
    expect(Math.hypot(s0[0] - 100, s0[1] - 100)).toBeGreaterThan(3);
    expect(port[0]).toBeCloseTo(p.box!.x, 9);
    expect(port[1]).toBeCloseTo(p.box!.y + 5, 9);
    f = m.frame(undefined, 2000);
    p = f.result.placements[0]!;
    expect(p.leader).toEqual(leader); // exact once it has arrived
    // back next to the point: the old leader fades while the label glides back
    m.target(result(near), undefined, 3000);
    f = m.frame(undefined, 3150);
    p = f.result.placements[0]!;
    expect(p.leader).not.toBeNull();
    expect(f.leaderOpacity.get("a")).toBeCloseTo(0.5, 9);
    f = m.frame(undefined, 3400);
    expect(f.result.placements[0]!.leader).toBeNull();
  });

  it("scales the text with a box that shrinks", () => {
    const m = new LabelMotion({ duration: 300 });
    const text = { lines: ["Alpha"], used: "original" as const, baseline_offsets: [8], font_size: 10, x_offset: 1 };
    m.target(result(lab("a", [0, 0, 40, 12], [0, 0], { text })), undefined, 0);
    const small = { ...text, font_size: 8.5, baseline_offsets: [6.8], x_offset: 0.85 };
    m.target(result(lab("a", [0, 0, 34, 10.2], [0, 0], { text: small })), undefined, 1000);
    const t0 = m.frame(undefined, 1000).result.placements[0]!.text!;
    expect(t0.font_size).toBeCloseTo(10, 9); // starts at the old size
    const t1 = m.frame(undefined, 1150).result.placements[0]!.text!;
    expect(t1.font_size).toBeGreaterThan(8.5);
    expect(t1.font_size).toBeLessThan(10);
    expect(m.frame(undefined, 2000).result.placements[0]!.text).toEqual(small);
  });

  it("draws every solve as it is with duration 0, and uses the solve's anchors without placement anchors", () => {
    const m = new LabelMotion({ duration: 0 });
    const bare = (x: number): Placement => ({ id: "a", placed: true, box: { x, y: 0, w: 10, h: 10 } }) as Placement;
    const at = (x: number, y: number) => new Map<string, [number, number]>([["a", [x, y]]]);
    m.target(result(bare(12)), at(10, 5), 0);
    m.target(result(bare(40)), at(10, 5), 10);
    expect(m.moving).toBe(false);
    const f = m.frame(at(20, 5), 10);
    expect(boxOf(f, "a")!.x).toBe(50); // 40 + the anchor's movement
    m.target(result(), undefined, 20);
    expect(m.frame(undefined, 20).result.placements).toEqual([]);
  });
});
