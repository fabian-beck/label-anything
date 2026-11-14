// Port of rust/crates/la-core/tests/area_labels.rs: labels of area anchors (spec §6.5,
// ADR placement/areas): inside the polygon, at places spread over the part the label fits
// in, turned along a slanted polygon.
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { areaAngle } from "../src/model/index.js";
import { placeWith } from "../src/place.js";

/** No clock: the solve is deterministic. */
const NO_CLOCK: Env = {};

type Pt = [number, number];
type Boxed = { box: { x: number; y: number; w: number; h: number }; rotation?: number; model: string };
type Res = {
  stats: Record<string, unknown>;
  placements: (Boxed & { id: string; placed: boolean; displacement?: number })[];
  candidates: Boxed[];
};

/** A `w` × `h` rectangle around (`cx`, `cy`), turned by `deg` (clockwise on screen). */
function slab(cx: number, cy: number, w: number, h: number, deg: number): Pt[] {
  const a = (deg * Math.PI) / 180;
  const [s, c] = [Math.sin(a), Math.cos(a)];
  return (
    [
      [-w, -h],
      [w, -h],
      [w, h],
      [-w, h],
    ] as Pt[]
  ).map(([x, y]) => [cx + (x / 2) * c - (y / 2) * s, cy + (x / 2) * s + (y / 2) * c]);
}

function problem(polygon: Pt[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "1",
    canvas: { width: 400, height: 300 },
    items: [
      {
        id: "a",
        anchor: { type: "area", polygon },
        label: { type: "text", text: "Area", width: 60, height: 14, padding: 0 },
      },
    ] as unknown[],
    output: { candidates: true },
    ...extra,
  };
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

/** Even-odd point in polygon. */
function inside(poly: Pt[], [x, y]: Pt): boolean {
  let odd = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if (a[1] > y !== b[1] > y && x < a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) odd = !odd;
  }
  return odd;
}

const solve = (p: unknown): Res => placeWith(p, NO_CLOCK, "rust") as Res;

describe("labels of area anchors", () => {
  it("candidates_of_a_roomy_area_are_inside_it_and_apart", () => {
    const poly = slab(200, 150, 300, 200, 0);
    const r = solve(problem(poly));
    expect(r.candidates.length).toBeGreaterThanOrEqual(5);
    for (const c of r.candidates) {
      expect(c.model).toBe("internal"); // no place beside the pole
      expect(corners(c).every((q) => inside(poly, q))).toBe(true);
    }
    // the first is the middle of the rectangle: the pole, where the label lacks nothing
    expect(Math.abs(r.candidates[0]!.box.x - 170)).toBeLessThan(0.5);
    expect(Math.abs(r.candidates[0]!.box.y - 143)).toBeLessThan(0.5);
    // and the others are spread over the area, not around it
    const xs = r.candidates.map((c) => c.box.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(120);
    expect(r.placements[0]!.model).toBe("internal");
    expect(r.placements[0]!.rotation).toBeUndefined();
  });

  it("a_label_is_turned_along_a_slanted_area_it_fits_no_other_way", () => {
    const poly = slab(200, 150, 260, 24, -35);
    const p = solve(problem(poly)).placements[0]!;
    expect(p.model).toBe("internal");
    expect(Math.abs(p.rotation! + 35)).toBeLessThan(1e-6);
    expect(p.box.w).toBe(60);
    expect(p.box.h).toBe(14);
    const c = corners(p);
    expect(c.every((q) => inside(poly, q))).toBe(true);
    // in the middle of the strip
    expect(Math.abs(c.reduce((s, q) => s + q[0], 0) / 4 - 200)).toBeLessThan(1);
    expect(Math.abs(c.reduce((s, q) => s + q[1], 0) / 4 - 150)).toBeLessThan(1);
  });

  it("rotation_is_limited_and_can_be_turned_off", () => {
    const poly = slab(200, 150, 260, 24, -35);
    const off = solve(problem(poly, { placement: { area_rotation: 0 } })).placements[0]!;
    expect(off.rotation).toBeUndefined();
    expect(off.model).not.toBe("internal"); // the label fits no upright place
    // a strip at 70° wide enough for a label at 20°
    const steep = slab(200, 150, 260, 70, 70);
    const p = solve(problem(steep, { placement: { area_rotation: 20 } })).placements[0]!;
    expect(p.rotation).toBe(20);
    expect(corners(p).every((q) => inside(steep, q))).toBe(true);
  });

  it("a_label_that_fits_nowhere_inside_stands_beside_the_pole", () => {
    const r = solve(problem(slab(200, 150, 30, 12, 0)));
    expect(r.candidates.every((c) => c.model !== "internal")).toBe(true);
    expect(r.placements[0]!.model).toBe("adjacent");
  });

  it("a_turned_label_keeps_its_place_as_a_warm_start", () => {
    const poly = slab(200, 150, 260, 24, -35);
    const first = solve(problem(poly));
    const again = solve(problem(poly, { warm_start: { placements: first.placements } }));
    const p = first.placements[0]!;
    const q = again.placements[0]!;
    expect(q.box).toEqual(p.box);
    expect(q.rotation).toBe(p.rotation);
    expect(q.displacement).toBe(0);
    // the warm-start label stays turned where turning is off now
    const kept = solve(problem(poly, { warm_start: { placements: first.placements }, placement: { area_rotation: 0 } }));
    expect(kept.placements[0]!.rotation).toBe(p.rotation);
  });

  it("a_turned_label_gives_way_to_marks_and_labels_exactly", () => {
    // a point right beside the strip's label, inside the label's bounding box: the label
    // stays, since neither the mark nor its label touch the turned box
    const prob = problem(slab(200, 150, 260, 24, -35));
    (prob.items as unknown[]).push({
      id: "pt",
      anchor: { type: "point", x: 222, y: 164 },
      label: { type: "text", text: "P", width: 8, height: 8, padding: 0 },
    });
    const r = solve(prob);
    expect(r.stats.placed).toBe(2);
    expect(r.stats.hard_violations).toBe(0);
    const a = r.placements[0]!;
    expect(typeof a.rotation).toBe("number");
    // the mark's center is not on the turned label
    const c = corners(a);
    const cross = (i: number, q: Pt): number => {
      const p0 = c[i]!;
      const p1 = c[(i + 1) % 4]!;
      return (p1[0] - p0[0]) * (q[1] - p0[1]) - (p1[1] - p0[1]) * (q[0] - p0[0]);
    };
    expect([0, 1, 2, 3].some((i) => cross(i, [222, 164]) < 0)).toBe(true);
  });

  it("area_angle_limits", () => {
    expect(areaAngle(null, 45)).toBeNull();
    expect(areaAngle(30, 45)).toBe(30);
    expect(areaAngle(-30, 45)).toBe(-30);
    // steeper than the limit: the limit
    expect(areaAngle(70, 45)).toBe(45);
    expect(areaAngle(-70, 45)).toBe(-45);
    // nearly horizontal: upright
    expect(areaAngle(9.9, 45)).toBeNull();
    expect(areaAngle(-9.9, 45)).toBeNull();
    expect(areaAngle(10, 45)).toBe(10);
    // vertical reads upwards
    expect(areaAngle(90, 90)).toBe(-90);
    expect(areaAngle(90, 45)).toBe(-45);
    // off
    expect(areaAngle(30, 0)).toBeNull();
    expect(areaAngle(NaN, 45)).toBeNull();
  });
});
