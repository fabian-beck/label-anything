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
  overlapsRect,
  polylabel,
  ringCentroid,
  signedArea,
} from "../../src/geom/polygon.js";

function square(x: number, y: number, s: number): P[] {
  return [new P(x, y), new P(x + s, y), new P(x + s, y + s), new P(x, y + s)];
}

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
