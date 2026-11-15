// Port of rust/crates/la-core/tests/line_labels.rs: labels of line anchors (spec §6.5a,
// ADR placement/lines): along the line, on it or beside it, turned along it.
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { solveWith, validate } from "../src/place.js";

/** No clock: the solve is deterministic. */
const NO_CLOCK: Env = {};

type Pt = [number, number];
type Boxed = { box: { x: number; y: number; w: number; h: number }; rotation?: number; model: string; anchor_side: string };
type Placed = Boxed & { id: string; placed: boolean; displacement?: number; anchor: Pt };
type Res = { stats: Record<string, unknown>; placements: Placed[]; candidates: Boxed[] };
type Obj = Record<string, unknown>;

function problem(points: Pt[], anchor: Obj = {}, extra: Obj = {}, item: Obj = {}): Obj {
  return {
    version: "1",
    canvas: { width: 400, height: 300 },
    items: [
      {
        id: "a",
        anchor: { type: "line", points, ...anchor },
        label: { type: "text", text: "Line", width: 60, height: 14, padding: 0 },
        ...item,
      },
    ] as unknown[],
    output: { candidates: true },
    ...extra,
  };
}

function solve(p: Obj): Res {
  return solveWith(p, NO_CLOCK, "rust") as unknown as Res;
}

/** The corners of a placement's or candidate's box, turned by its rotation. */
function corners(p: Boxed): Pt[] {
  const { x, y, w, h } = p.box;
  const [cx, cy] = [x + w / 2, y + h / 2];
  const a = ((p.rotation ?? 0) * Math.PI) / 180;
  const [s, c] = [Math.sin(a), Math.cos(a)];
  return (
    [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ] as Pt[]
  ).map(([px, py]) => [cx + (px - cx) * c - (py - cy) * s, cy + (px - cx) * s + (py - cy) * c]);
}

function center(p: Boxed): Pt {
  return [p.box.x + p.box.w / 2, p.box.y + p.box.h / 2];
}

/** The distance of `p` from the segment `a`–`b`. */
function distSeg(p: Pt, a: Pt, b: Pt): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

const node = (x: number, y: number, r: number): Obj => ({
  id: "node",
  anchor: { type: "point", x, y, mark: { shape: "circle", r } },
  label: { type: "text", text: "N", width: 8, height: 8, padding: 0 },
});

describe("line labels", () => {
  it("a_label_stands_above_the_middle_of_a_horizontal_line", () => {
    const p = solve(problem([[50, 150], [350, 150]])).placements[0]!;
    expect(p.placed).toBe(true);
    expect(p.model).toBe("internal");
    expect(p.anchor_side).toBe("top");
    expect(p.rotation).toBeUndefined();
    expect(p.anchor).toEqual([200, 150]);
    // centered on the middle, its lower edge the offset (1 px) above the stroke (1 px)
    expect(Math.abs(p.box.x - 170)).toBeLessThan(1e-9);
    expect(Math.abs(p.box.y - (150 - 0.5 - 1 - 14))).toBeLessThan(1e-9);
  });

  it("a_label_is_turned_along_a_slanted_line_and_reads_from_the_left", () => {
    // the same edge given in either direction: 30° down to the right
    const a = (30 * Math.PI) / 180;
    const [dx, dy] = [Math.cos(a) * 120, Math.sin(a) * 120];
    const fwd: Pt[] = [[200 - dx, 150 - dy], [200 + dx, 150 + dy]];
    for (const line of [fwd, [fwd[1]!, fwd[0]!]]) {
      const p = solve(problem(line)).placements[0]!;
      expect(Math.abs(p.rotation! - 30)).toBeLessThan(1e-9);
      expect(p.anchor_side).toBe("top");
      // every corner keeps clear of the line, the lower ones at the offset
      const ds = corners(p).map((q) => distSeg(q, line[0]!, line[1]!));
      expect(Math.abs(ds[3]! - 1.5)).toBeLessThan(1e-6);
      expect(Math.abs(ds[2]! - 1.5)).toBeLessThan(1e-6);
      expect(Math.abs(ds[0]! - 15.5)).toBeLessThan(1e-6);
      // above: the label's center has the smaller y at its x
      const [cx, cy] = center(p);
      expect(Math.abs(cx - 200)).toBeLessThan(10);
      expect(cy).toBeLessThan(150 + (cx - 200) * Math.tan(a));
    }
  });

  it("a_vertical_line_reads_upwards", () => {
    const p = solve(problem([[200, 40], [200, 260]])).placements[0]!;
    expect(p.rotation).toBe(-90);
    // above the line as the label reads: to its left
    expect(center(p)[0]).toBeLessThan(200);
  });

  it("line_rotation_limits_the_lines_whose_labels_are_turned", () => {
    const steep: Pt[] = [[150, 40], [250, 260]];
    const p = solve(problem(steep, {}, { placement: { line_rotation: 0 } })).placements[0]!;
    expect(p.rotation).toBeUndefined();
    expect(p.model).toBe("internal");
    // the upright box touches the line's clearance with a corner
    const d = Math.min(...corners(p).map((q) => distSeg(q, steep[0]!, steep[1]!)));
    expect(Math.abs(d - 1.5)).toBeLessThan(1e-6);
    // a line steeper than the limit gets an upright label, a flatter one a turned label
    expect(solve(problem(steep, {}, { placement: { line_rotation: 45 } })).placements[0]!.rotation).toBeUndefined();
    const flat: Pt[] = [[60, 100], [340, 200]];
    expect(solve(problem(flat, {}, { placement: { line_rotation: 45 } })).placements[0]!.rotation!).toBeGreaterThan(15);
  });

  it("a_label_goes_on_a_line_that_is_wide_enough_or_when_asked", () => {
    const line: Pt[] = [[50, 150], [350, 150]];
    // a street 20 px wide takes its 14 px label
    const p = solve(problem(line, { width: 20 })).placements[0]!;
    expect(p.anchor_side).toBe("internal");
    expect(center(p)).toEqual([200, 150]);
    // a thin line does when the item prefers it
    expect(solve(problem(line, {}, {}, { placement: { internal: "prefer" } })).placements[0]!.anchor_side).toBe("internal");
    // and never with `never`
    const never = solve(problem(line, { width: 20 }, { placement: { internal: "never" } }));
    expect(never.placements[0]!.anchor_side).toBe("top");
    expect(never.candidates.every((c) => c.anchor_side !== "internal")).toBe(true);
  });

  it("position_order_chooses_the_side", () => {
    const line: Pt[] = [[50, 150], [350, 150]];
    const p = solve(problem(line, {}, { placement: { position_order: ["bottom", "top"] } })).placements[0]!;
    expect(p.anchor_side).toBe("bottom");
    expect(Math.abs(p.box.y - 151.5)).toBeLessThan(1e-9);
    const only = solve(problem(line, {}, { placement: { position_order: ["bottom"] } }));
    expect(only.candidates.every((c) => c.anchor_side === "bottom")).toBe(true);
  });

  it("places_are_spread_along_the_line_and_a_blocked_middle_is_left", () => {
    const line: Pt[] = [[20, 150], [380, 150]];
    const cands = solve(problem(line)).candidates;
    // nine places, above and below
    expect(cands.length).toBe(18);
    const xs = cands.map((c) => center(c)[0]);
    expect(xs[0]).toBe(200);
    expect(Math.abs(Math.min(...xs) - 50)).toBeLessThan(1e-9);
    expect(Math.abs(Math.max(...xs) - 350)).toBeLessThan(1e-9);
    // a mark in the middle of the line moves the label along it
    const p = problem(line);
    (p.items as unknown[]).push(node(200, 150, 12));
    const r = solve(p);
    expect(r.stats.placed).toBe(2);
    expect(r.stats.hard_violations).toBe(0);
    const q = r.placements[0]!;
    expect(q.model).toBe("internal");
    expect(Math.abs(center(q)[0] - 200)).toBeGreaterThan(30);
  });

  it("a_label_keeps_off_a_corner_of_its_line", () => {
    // an orthogonal edge: no label over the corner, none against the leg behind it
    const line: Pt[] = [[40, 200], [220, 200], [220, 60]];
    const r = solve(problem(line));
    for (const c of r.candidates) {
      for (let k = 0; k < 2; k++) {
        // the box's nearest point to each leg is 1.5 px away at least: test its corners
        // and its center
        const d = Math.min(...[...corners(c), center(c)].map((q) => distSeg(q, line[k]!, line[k + 1]!)));
        expect(d).toBeGreaterThanOrEqual(1.5 - 1e-6);
      }
    }
    expect(r.placements[0]!.model).toBe("internal");
  });

  it("a_line_bent_everywhere_has_its_label_beside_the_dot", () => {
    // a zigzag with teeth higher than the label and shorter than it is wide
    const line: Pt[] = [];
    for (let k = 0; k <= 150; k++) line.push([50 + 2 * k, k % 2 === 0 ? 140 : 160]);
    const r = solve(problem(line));
    expect(r.placements[0]!.placed).toBe(true);
    expect(r.placements[0]!.model).not.toBe("internal");
    expect(r.candidates.every((c) => c.model !== "internal")).toBe(true);
  });

  it("a_line_shorter_than_its_label_is_labeled_at_its_middle", () => {
    const r = solve(problem([[190, 150], [210, 150]]));
    expect(r.candidates.length).toBe(2);
    expect(r.placements[0]!.model).toBe("internal");
    expect(center(r.placements[0]!)[0]).toBe(200);
  });

  it("a_line_label_keeps_its_place_as_a_warm_start", () => {
    const p = problem([[60, 60], [340, 230]]);
    // a mark that moves the label off the middle
    (p.items as unknown[]).push(node(200, 145, 14));
    const first = solve(p);
    const again = { ...p, warm_start: { placements: first.placements } };
    const second = solve(again);
    const [a, b] = [first.placements[0]!, second.placements[0]!];
    expect(b.box).toEqual(a.box);
    expect(b.rotation).toBe(a.rotation);
    expect(b.displacement).toBe(0);
    // the whole drawing moves: the label moves with its line
    const moved = {
      ...again,
      items: [
        { ...(p.items as Obj[])[0]!, anchor: { type: "line", points: [[77, 51], [357, 221]] } },
        node(217, 136, 14),
      ],
    };
    const c = solve(moved).placements[0]!;
    expect(Math.abs(center(c)[0] - center(a)[0] - 17)).toBeLessThan(1e-6);
    expect(Math.abs(center(c)[1] - center(a)[1] + 9)).toBeLessThan(1e-6);
    expect(c.rotation).toBe(a.rotation);
  });

  it("in_a_window_the_places_lie_on_the_piece_in_view", () => {
    // a street far longer than the view, which shows its right end
    const r = solve(problem([[-2000, 150], [300, 150]], {}, { canvas: { width: 400, height: 300, overscan: 0 } }));
    const p = r.placements[0]!;
    expect(p.model).toBe("internal");
    expect(center(p)[0]).toBe(150);
    expect(p.anchor).toEqual([-850, 150]);
  });

  it("line_labels_and_node_labels_share_a_graph", () => {
    const nodes: [string, number, number][] = [["a", 80, 70], ["b", 320, 90], ["c", 200, 240]];
    const items: Obj[] = nodes.map(([id, x, y]) => ({
      id,
      anchor: { type: "point", x, y, mark: { shape: "circle", r: 8 } },
      label: { type: "text", text: `Node ${id}` },
    }));
    for (const [i, j] of [[0, 1], [1, 2], [2, 0]] as [number, number][]) {
      items.push({
        id: `${nodes[i]![0]}${nodes[j]![0]}`,
        anchor: { type: "line", points: [[nodes[i]![1], nodes[i]![2]], [nodes[j]![1], nodes[j]![2]]] },
        label: { type: "text", text: "relates to" },
      });
    }
    const r = solve({ version: "1", canvas: { width: 400, height: 300 }, preset: "graph", items });
    expect(r.stats.placed).toBe(6);
    expect(r.stats.hard_violations).toBe(0);
    for (const p of r.placements.slice(3)) {
      expect(p.model).toBe("internal");
      expect(typeof p.rotation).toBe("number");
    }
  });

  it("a_line_without_length_is_invalid", () => {
    const rep = validate(problem([[10, 10], [10, 10]]));
    expect(rep.valid).toBe(false);
    expect(rep.errors[0]!.code).toBe("invalid_value");
    expect(rep.errors[0]!.pointer).toBe("/items/0/anchor/points");
  });
});
