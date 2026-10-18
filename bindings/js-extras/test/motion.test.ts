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
const idsOf = (f: { result: LabelResult }) => f.result.placements.map((p) => p.id);
const rank = (r: number): Partial<Placement> => ({ priority: { tier: 0, score: 0, rank: r } as Placement["priority"] });
const at = (...a: [string, number, number][]) => new Map<string, [number, number]>(a.map(([id, x, y]) => [id, [x, y]]));

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
    const m = new LabelMotion({ duration: 300, moveDelay: 0 });
    // 30 px: less than two label heights
    m.target(result(lab("a", [12, 0, 30, 20], [10, 5])), undefined, 0);
    m.target(result(lab("a", [42, 0, 30, 20], [10, 5])), undefined, 1000);
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

  it("fades a new label in after the appear delay and a gone one out after the hold time", () => {
    const m = new LabelMotion({ duration: 200, appearDelay: 200, holdTime: 400 });
    m.target(result(lab("a", [0, 0, 10, 10], [0, 0]), lab("b", [30, 0, 10, 10], [30, 0])), undefined, 0);
    m.target(result(lab("a", [0, 0, 10, 10], [0, 0]), lab("c", [60, 0, 10, 10], [60, 0])), undefined, 100);
    let f = m.frame(undefined, 100);
    expect(idsOf(f)).toEqual(["b", "a"]); // c waits; b stays, below the labels of the result
    expect(f.opacity.size).toBe(0);
    f = m.frame(undefined, 300);
    expect(idsOf(f)).toEqual(["b", "a"]); // c starts now
    f = m.frame(undefined, 400);
    expect(f.opacity.get("c")).toBeCloseTo(0.5, 9);
    expect(f.opacity.has("b")).toBe(false);
    f = m.frame(undefined, 600);
    expect(f.opacity.get("b")).toBeCloseTo(0.5, 9); // fading since 500
    expect(f.opacity.has("c")).toBe(false);
    expect(m.moving).toBe(true);
    f = m.frame(undefined, 700);
    expect(idsOf(f)).toEqual(["a", "c"]);
    expect(f.opacity.size).toBe(0);
    expect(m.moving).toBe(false);
  });

  it("never shows a label placed for less than the appear delay", () => {
    const m = new LabelMotion();
    m.target(result(lab("a", [0, 0, 10, 10], [0, 0])), undefined, 0);
    m.target(result(lab("a", [0, 0, 10, 10], [0, 0]), lab("c", [60, 0, 10, 10], [60, 0])), undefined, 1000);
    expect(m.moving).toBe(true);
    expect(idsOf(m.frame(undefined, 1150))).toEqual(["a"]);
    m.target(result(lab("a", [0, 0, 10, 10], [0, 0])), undefined, 1150);
    for (let t = 1150; t <= 2000; t += 50) expect(idsOf(m.frame(undefined, t))).toEqual(["a"]);
    expect(m.moving).toBe(false);
  });

  it("keeps a label that is gone for less than the hold time, where it is", () => {
    const m = new LabelMotion({ duration: 300, holdTime: 400, moveDelay: 400 });
    const a = lab("a", [0, 0, 10, 10], [0, 0]);
    const b = lab("b", [30, 0, 10, 10], [30, 0]);
    m.target(result(a, b), undefined, 0);
    m.target(result(a), undefined, 1000);
    expect(m.frame(undefined, 1300).opacity.has("b")).toBe(false);
    m.target(result(a, lab("b", [30, 5, 10, 10], [30, 0])), undefined, 1350);
    for (let t = 1350; t <= 1700; t += 50) {
      const f = m.frame(undefined, t);
      expect(f.opacity.has("b")).toBe(false);
      expect(boxOf(f, "b")!.y).toBe(0); // until its new place has held for the move delay
    }
    const y = boxOf(m.frame(undefined, 1850), "b")!.y; // gliding since 1750
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(5);
  });

  it("moves a label only once its new place has held for the move delay", () => {
    const m = new LabelMotion({ duration: 300, moveDelay: 400 });
    const at12 = lab("a", [12, 0, 30, 20], [10, 5]);
    m.target(result(at12), undefined, 0);
    m.target(result(lab("a", [22, 0, 30, 20], [10, 5])), undefined, 1000);
    expect(m.moving).toBe(true);
    expect(boxOf(m.frame(undefined, 1200), "a")!.x).toBe(12);
    // back within the delay: it never moves
    m.target(result(at12), undefined, 1300);
    for (let t = 1300; t <= 2000; t += 100) expect(boxOf(m.frame(undefined, t), "a")!.x).toBe(12);
    expect(m.moving).toBe(false);
    // moved twice within the delay: one glide, to the last place, 400 ms after the first move
    m.target(result(lab("a", [22, 0, 30, 20], [10, 5])), undefined, 3000);
    m.target(result(lab("a", [32, 0, 30, 20], [10, 5])), undefined, 3200);
    expect(boxOf(m.frame(undefined, 3399), "a")!.x).toBe(12);
    m.frame(undefined, 3400);
    expect(boxOf(m.frame(undefined, 3550), "a")!.x).toBeGreaterThan(12);
    expect(boxOf(m.frame(undefined, 4500), "a")!.x).toBe(32);
    expect(m.moving).toBe(false);
  });

  it("moves a label at once when a label at its new place needs the room", () => {
    const m = new LabelMotion({ duration: 300, moveDelay: 400, appearDelay: 250 });
    m.target(result(lab("a", [0, 0, 20, 10], [0, 0]), lab("b", [30, 0, 20, 10], [30, 0])), undefined, 0);
    // b moves up; a new label c takes b's place
    m.target(result(lab("a", [0, 0, 20, 10], [0, 0]), lab("b", [30, -12, 20, 10], [30, 0]), lab("c", [30, 0, 20, 10], [40, 5])), undefined, 1000);
    expect(boxOf(m.frame(undefined, 1249), "b")!.y).toBe(0);
    m.frame(undefined, 1250); // c's turn: b goes
    const f = m.frame(undefined, 1350);
    expect(boxOf(f, "b")!.y).toBeLessThan(0);
    expect(f.opacity.get("c")).toBeCloseTo(1 / 3, 9);
  });

  it("moves a label at once when it covers another item's anchor", () => {
    const m = new LabelMotion({ duration: 300, moveDelay: 400 });
    m.target(result(lab("a", [12, 0, 30, 10], [10, 5]), lab("b", [62, 45, 20, 10], [60, 50])), undefined, 0);
    // b's point moves into a's label; the solve puts a on the other side of its point
    const moved = at(["a", 10, 5], ["b", 25, 5]);
    m.target(result(lab("a", [-32, 0, 30, 10], [10, 5]), lab("b", [27, 10, 20, 10], [25, 5])), moved, 1000);
    m.frame(moved, 1000);
    expect(m.frame(moved, 1075).opacity.get("a")).toBeCloseTo(0.5, 9); // fades out, twice as fast
    m.frame(moved, 1150);
    const f = m.frame(moved, 1300);
    expect(boxOf(f, "a")!.x).toBe(-32); // and in on the other side
    expect(f.opacity.get("a")).toBeCloseTo(0.5, 9);
  });

  it("fades a label out and in where it jumps further than two label heights, unless it jumps back", () => {
    const m = new LabelMotion({ duration: 300, moveDelay: 0 });
    const right = lab("a", [12, 0, 30, 10], [10, 5]);
    const left = lab("a", [-32, 0, 30, 10], [10, 5], { anchor_side: "left" });
    m.target(result(right), undefined, 0);
    m.target(result(left), undefined, 1000);
    let f = m.frame(undefined, 1075);
    expect(boxOf(f, "a")!.x).toBe(12); // fades out where it is, twice as fast
    expect(f.opacity.get("a")).toBeCloseTo(0.5, 9);
    expect(idsOf(m.frame(undefined, 1150))).toEqual([]);
    f = m.frame(undefined, 1300);
    expect(boxOf(f, "a")!.x).toBe(-32); // and in at the new place
    expect(f.opacity.get("a")).toBeCloseTo(0.5, 9);
    expect(m.frame(undefined, 1450).opacity.has("a")).toBe(false);
    expect(m.moving).toBe(false);
    // flips back and forth: it comes back where it is
    m.target(result(right), undefined, 2000);
    expect(m.frame(undefined, 2075).opacity.get("a")).toBeCloseTo(0.5, 9);
    m.target(result(left), undefined, 2075);
    f = m.frame(undefined, 2150);
    expect(boxOf(f, "a")!.x).toBe(-32);
    expect(f.opacity.get("a")).toBeCloseTo(0.75, 9);
    expect(m.frame(undefined, 2300).opacity.has("a")).toBe(false);
  });

  it("hides the less important of two labels that meet for 150 ms until it has been clear for the appear delay", () => {
    const m = new LabelMotion({ duration: 300, appearDelay: 200 });
    m.target(result(lab("a", [0, 0, 20, 10], [0, 0], rank(0)), lab("b", [30, 0, 20, 10], [30, 0], rank(1))), undefined, 0);
    expect(m.frame(at(["a", 0, 0], ["b", 30, 0]), 0).opacity.size).toBe(0);
    // b's point moves onto a's label: a new solve usually separates them soon
    const met = at(["a", 0, 0], ["b", 15, 0]);
    expect(m.frame(met, 100).opacity.size).toBe(0);
    expect(m.frame(met, 249).opacity.size).toBe(0);
    m.frame(met, 250); // it did not: b makes way
    expect(m.frame(met, 325).opacity.get("b")).toBeCloseTo(0.5, 9);
    expect(idsOf(m.frame(met, 400))).toEqual(["a"]);
    expect(m.moving).toBe(false);
    // clear again: it waits, then fades in
    const apart = at(["a", 0, 0], ["b", 30, 0]);
    expect(idsOf(m.frame(apart, 450))).toEqual(["a"]);
    expect(m.moving).toBe(true);
    expect(idsOf(m.frame(apart, 650))).toEqual(["a"]);
    expect(m.frame(apart, 800).opacity.get("b")).toBeCloseTo(0.5, 9);
    expect(m.frame(apart, 950).opacity.size).toBe(0);
    // the more important label stays, whichever moves
    const met2 = at(["a", 25, 0], ["b", 30, 0]);
    for (const t of [1000, 1150, 1300]) m.frame(met2, t);
    expect(idsOf(m.frame(met2, 1400))).toEqual(["a"]);
  });

  it("shows a hidden label again when a new result moves it clear", () => {
    const m = new LabelMotion({ duration: 300, appearDelay: 200 });
    const a = lab("a", [0, 0, 20, 10], [0, 0], rank(0));
    m.target(result(a, lab("b", [30, 0, 20, 10], [30, 0], rank(1))), undefined, 0);
    const met = at(["a", 0, 0], ["b", 15, 0]);
    for (const t of [100, 250, 400]) m.frame(met, t);
    expect(m.moving).toBe(false);
    // solved for the moved point: b goes below it, clear of a
    m.target(result(a, lab("b", [15, 12, 20, 10], [15, 0], rank(1))), met, 500);
    expect(m.moving).toBe(true);
    m.frame(met, 500);
    expect(m.frame(met, 850).opacity.get("b")).toBeCloseTo(0.5, 9);
    expect(boxOf(m.frame(met, 1000), "b")).toEqual({ x: 15, y: 12, w: 20, h: 10 });
  });

  it("fades out a lingering label that a new one needs room from before showing the new one", () => {
    const m = new LabelMotion({ duration: 300, appearDelay: 200, holdTime: 400 });
    m.target(result(lab("a", [0, 0, 20, 10], [0, 0]), lab("b", [30, 0, 20, 10], [30, 0])), undefined, 0);
    m.target(result(lab("a", [0, 0, 20, 10], [0, 0]), lab("c", [34, 2, 20, 10], [32, 0])), undefined, 1000);
    expect(idsOf(m.frame(undefined, 1100))).toEqual(["b", "a"]); // b lingers, c waits
    m.frame(undefined, 1200); // c's turn: b makes way
    expect(m.frame(undefined, 1275).opacity.get("b")).toBeCloseTo(0.5, 9);
    expect(idsOf(m.frame(undefined, 1350))).toEqual(["a"]); // b is gone: c starts
    const f = m.frame(undefined, 1500);
    expect(f.opacity.get("c")).toBeCloseTo(0.5, 9);
    expect(idsOf(f)).toEqual(["a", "c"]);
  });

  it("attaches leaders to the gliding box and fades out a leader that is no longer needed", () => {
    const m = new LabelMotion({ duration: 300, jump: Infinity, moveDelay: 0 });
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

  it("keeps a label in a column where the column is while its point moves", () => {
    const m = new LabelMotion();
    const leader = { points: [[10, 10], [80, 10]] as [number, number][], style: "straight" as const, port: [80, 10] as [number, number] };
    m.target(result(lab("a", [80, 5, 30, 10], [10, 10], { model: "fan", anchor_side: "distant", leader })), undefined, 0);
    const p = m.frame(at(["a", 10, 30]), 10).result.placements[0]!;
    expect(p.box).toEqual({ x: 80, y: 5, w: 30, h: 10 });
    expect(p.leader!.points).toEqual([[10, 30], [80, 10]]); // the leader follows the point
    // back next to its point, after the move delay: out of the column, in next to the point
    const here = at(["a", 10, 30]);
    m.target(result(lab("a", [12, 25, 30, 10], [10, 30])), here, 1000);
    let f = m.frame(here, 1575);
    expect(boxOf(f, "a")!.x).toBe(80);
    expect(f.opacity.get("a")).toBeCloseTo(0.5, 9);
    m.frame(here, 1650);
    f = m.frame(here, 1800);
    expect(boxOf(f, "a")).toEqual({ x: 12, y: 25, w: 30, h: 10 });
    expect(f.opacity.get("a")).toBeCloseTo(0.5, 9);
  });

  it("scales the text with a box that shrinks", () => {
    const m = new LabelMotion({ duration: 300, moveDelay: 0 });
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
