// Port of the unit tests of rust/crates/la-core/src/geom/polygon.rs.
import { describe, expect, it } from "vitest";
import { P, Rect } from "../../src/geom/index.js";
import {
  area,
  contains,
  containsRect,
  convexHull,
  distRect,
  edges,
  mainAxis,
  overlapsRect,
  polylabel,
  ringCentroid,
  roomRect,
  signedArea,
} from "../../src/geom/polygon.js";
import { sinCosDeg } from "../../src/math.js";

function square(x: number, y: number, s: number): P[] {
  return [new P(x, y), new P(x + s, y), new P(x + s, y + s), new P(x, y + s)];
}

/** A `w` × `h` rectangle around (`cx`, `cy`), turned by `deg` (clockwise on screen). */
function slab(cx: number, cy: number, w: number, h: number, deg: number): P[] {
  const [sin, cos] = sinCosDeg(deg);
  return (
    [
      [-w, -h],
      [w, -h],
      [w, h],
      [-w, h],
    ] as [number, number][]
  ).map(([x, y]) => new P(cx, cy).add(new P(x * 0.5, y * 0.5).rotate(cos, sin)));
}

describe("area labels (spec §6.5)", () => {
  it("main_axis_follows_the_long_side", () => {
    const o = new P(0, 0);
    for (const deg of [-60, -35, 0, 20, 45, 80]) {
      const a = mainAxis([slab(300, 200, 200, 40, deg)], o)!;
      expect(Math.abs(a - deg), String(deg)).toBeLessThan(1e-9);
    }
    // an upright strip: 90°, whichever way it is wound
    const up = slab(10, 10, 20, 300, 0);
    expect(mainAxis([up], o)).toBe(90);
    expect(mainAxis([up.slice().reverse()], o)).toBe(90);
    // compact and degenerate polygons have none
    expect(mainAxis([square(5, 5, 40)], o)).toBeNull();
    expect(mainAxis([slab(0, 0, 50, 40, 30)], o)).toBeNull();
    expect(mainAxis([[o, new P(10, 0), new P(20, 0)]], o)).toBeNull();
    expect(mainAxis([], o)).toBeNull();
    // a hole (wound the other way) counts: two blocks side by side have an axis
    const outer = slab(0, 0, 100, 80, 0);
    const hole = slab(0, 0, 30, 76, 0).reverse();
    expect(mainAxis([outer], o)).toBeNull();
    expect(Math.abs(mainAxis([outer, hole], o)!)).toBeLessThan(1e-9);
  });

  it("room_rect_is_the_distance_from_the_boundary", () => {
    const sq = [square(0, 0, 100)];
    expect(roomRect(sq, new Rect(40, 45, 60, 55))).toBe(40);
    expect(roomRect(sq, new Rect(10, 45, 60, 55))).toBe(10);
    expect(roomRect(sq, new Rect(0, 45, 60, 55))).toBe(0);
    // a hole counts
    const holed = [square(0, 0, 100), square(70, 40, 10)];
    expect(roomRect(holed, new Rect(40, 45, 60, 55))).toBe(10);
  });
});

describe("geom::polygon", () => {
  it("containment_rules", () => {
    const outer = square(0, 0, 10);
    const hole = square(3, 3, 4);
    const rings = [outer, hole];
    expect(contains(rings, true, new P(1, 1))).toBe(true);
    expect(contains(rings, true, new P(5, 5))).toBe(false);
    // non-zero with same orientation: hole is filled
    expect(contains(rings, false, new P(5, 5))).toBe(true);
    const rev = hole.slice().reverse();
    expect(contains([outer, rev], false, new P(5, 5))).toBe(false);
  });

  it("hull_square_with_inner_points", () => {
    const pts = square(0, 0, 10);
    pts.push(new P(5, 5));
    pts.push(new P(5, 0));
    const h = convexHull(pts);
    expect(h.length).toBe(4);
  });

  it("rect_tests", () => {
    const poly = [square(0, 0, 10)];
    const bb = Rect.xywh(0, 0, 10, 10);
    expect(overlapsRect(poly, false, bb, Rect.xywh(5, 5, 10, 10))).toBe(true);
    expect(overlapsRect(poly, false, bb, Rect.xywh(10, 0, 5, 5))).toBe(false);
    expect(overlapsRect(poly, false, bb, Rect.xywh(2, 2, 1, 1))).toBe(true);
    expect(containsRect(poly, false, Rect.xywh(2, 2, 3, 3), 0.5)).toBe(true);
    expect(containsRect(poly, false, Rect.xywh(8, 2, 3, 3), 0)).toBe(false);
    expect(Math.abs(distRect(poly, false, bb, Rect.xywh(13, 0, 2, 2)) - 3)).toBeLessThan(1e-12);
  });

  it("polylabel_square_center", () => {
    const [p, d] = polylabel([square(0, 0, 10)], false, 0.1);
    expect(Math.abs(p.x - 5) < 0.2 && Math.abs(p.y - 5) < 0.2).toBe(true);
    expect(Math.abs(d - 5)).toBeLessThan(0.2);
  });

  it("polylabel_l_shape", () => {
    const l = [new P(0, 0), new P(100, 0), new P(100, 20), new P(20, 20), new P(20, 100), new P(0, 100)];
    const [p, d] = polylabel([l], false, 0.5);
    expect(contains([l], false, p)).toBe(true);
    expect(d).toBeGreaterThanOrEqual(9);
  });

  it("areas_centroids_and_edges", () => {
    const sq = square(0, 0, 10);
    expect(signedArea(sq)).toBe(100);
    expect(signedArea(sq.slice().reverse())).toBe(-100);
    expect(area([sq, square(3, 3, 4)], true)).toBe(84);
    expect(area([sq, square(3, 3, 4).reverse()], false)).toBe(84);
    expect(ringCentroid(sq).eq(new P(5, 5))).toBe(true);
    // degenerate ring: vertex mean
    expect(ringCentroid([new P(0, 0), new P(2, 0), new P(4, 0)]).eq(new P(2, 0))).toBe(true);
    expect([...edges([square(0, 0, 1)])].length).toBe(4);
    expect(convexHull([new P(1, 1), new P(1, 1), new P(NaN, 0)]).length).toBe(1);
  });
});
