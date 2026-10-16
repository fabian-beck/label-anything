// Port of the unit tests of rust/crates/la-core/src/geom/shape.rs.
import { describe, expect, it } from "vitest";
import { P, Rect } from "../../src/geom/index.js";
import { Shape, shapesOverlap, signDir } from "../../src/geom/shape.js";

describe("geom::shape", () => {
  it("circle_support_is_tangent", () => {
    const s = Shape.circle(new P(10, 10), 5);
    const p = s.support(new P(1, -1));
    const h = 5 / Math.sqrt(2);
    expect(Math.abs(p.x - (10 + h)) < 1e-12 && Math.abs(p.y - (10 - h)) < 1e-12).toBe(true);
  });

  it("rect_support_corners_and_sides", () => {
    const s = Shape.rect(new P(0, 0), 40, 10, 0, 0);
    expect(s.support(new P(1, -1)).eq(new P(20, -5))).toBe(true);
    expect(s.support(new P(0, -1)).eq(new P(0, -5))).toBe(true);
    expect(s.support(new P(1, 0)).eq(new P(20, 0))).toBe(true);
  });

  it("polygon_support_flat_side_centers_on_reference", () => {
    const sq = [new P(0, 0), new P(10, 0), new P(10, 10), new P(0, 10)];
    const s = Shape.polygon([sq], false, new P(3, 5));
    const p = s.support(new P(0, -1));
    expect(Math.abs(p.x - 3) < 1e-12 && Math.abs(p.y) < 1e-12).toBe(true);
  });

  it("ellipse_distance_and_containment", () => {
    const e = Shape.ellipse(new P(0, 0), 10, 5, 0);
    expect(Math.abs(e.signedDistance(new P(12, 0)) - 2)).toBeLessThan(1e-9);
    expect(Math.abs(e.signedDistance(new P(0, 8)) - 3)).toBeLessThan(1e-9);
    expect(e.contains(new P(9, 0))).toBe(true);
    const r = Shape.ellipse(new P(0, 0), 10, 5, 90);
    expect(r.contains(new P(0, 9))).toBe(true);
    expect(r.contains(new P(9, 0))).toBe(false);
  });

  it("rect_overlap_exact", () => {
    const c = Shape.circle(new P(0, 0), 10);
    // touching from the right is not an overlap
    expect(c.overlapsRect(Rect.xywh(10, -5, 10, 10))).toBe(false);
    expect(c.overlapsRect(Rect.xywh(9, -5, 10, 10))).toBe(true);
    // near the 45° diagonal, the corner of a rect placed on the tangent point touches
    let t = c.support(new P(1, -1));
    let r = new Rect(t.x, t.y - 10, t.x + 30, t.y);
    expect(c.overlapsRect(r)).toBe(false);
    const e = Shape.ellipse(new P(0, 0), 10, 5, 30);
    t = e.support(new P(1, -1));
    r = new Rect(t.x, t.y - 10, t.x + 30, t.y);
    expect(e.overlapsRect(r)).toBe(false);
    expect(e.overlapsRect(r.translate(new P(-0.5, 0.5)))).toBe(true);
    const rr = Shape.rect(new P(0, 0), 20, 10, 3, 20);
    t = rr.support(new P(-1, 1));
    r = new Rect(t.x - 30, t.y, t.x, t.y + 10);
    expect(rr.overlapsRect(r)).toBe(false);
    expect(rr.overlapsRect(r.translate(new P(0.3, -0.3)))).toBe(true);
  });

  it("shape_shape_overlap", () => {
    const a = Shape.circle(new P(0, 0), 5);
    const b = Shape.circle(new P(10, 0), 5);
    expect(shapesOverlap(a, b)).toBe(false);
    const c = Shape.circle(new P(9, 0), 5);
    expect(shapesOverlap(a, c)).toBe(true);
    const r = Shape.rect(new P(0, 12), 20, 4, 0, 0);
    expect(shapesOverlap(a, r)).toBe(false);
    const big = Shape.rect(new P(0, 0), 100, 100, 5, 0);
    const small = Shape.rect(new P(1, 1), 2, 2, 0, 30);
    expect(shapesOverlap(big, small)).toBe(true);
    const tri = Shape.polygon([[new P(20, 20), new P(30, 20), new P(25, 28)]], false, new P(25, 22));
    expect(shapesOverlap(small, tri)).toBe(false);
  });

  it("boundary_points", () => {
    const s = Shape.rect(new P(0, 0), 20, 10, 0, 0);
    let b = s.boundaryPoint(new P(1, 0));
    expect(Math.abs(b.x - 10) < 1e-9 && Math.abs(b.y) < 1e-9).toBe(true);
    const e = Shape.ellipse(new P(0, 0), 10, 5, 0);
    b = e.boundaryPoint(new P(0, 1));
    expect(Math.abs(b.y - 5)).toBeLessThan(1e-12);
  });

  it("outline_contains_shape", () => {
    const c = Shape.circle(new P(0, 0), 10);
    const o = c.outline();
    for (const p of o) expect(p.len()).toBeGreaterThanOrEqual(10 - 1e-9);
  });

  it("variants_and_helpers", () => {
    // equal radii make a circle; rect clamps the corner radius; translation keeps kinds
    expect(Shape.ellipse(new P(1, 2), 3, 3, 45).kind).toBe("circle");
    const rr = Shape.rect(new P(0, 0), 10, 4, 9, 0);
    expect(rr.kind === "roundRect" && rr.r === 2).toBe(true);
    const moved = rr.translated(new P(5, 0));
    expect(moved.kind).toBe("roundRect");
    expect(moved.reference().eq(new P(5, 0))).toBe(true);
    expect(moved.bbox().eq(new Rect(0, -2, 10, 2))).toBe(true);
    const poly = Shape.polygon([[new P(0, 0), new P(4, 0), new P(0, 4)]], false, new P(1, 1));
    expect(poly.area()).toBe(8);
    expect(poly.translated(new P(1, 1)).bbox().eq(new Rect(1, 1, 5, 5))).toBe(true);
    expect(poly.outline().length).toBe(3);
    expect(poly.outlineRings()[0]!.length).toBe(3);
    expect(signDir(new P(1e-13, -2))).toEqual([0, -1]);
    // outline() returns a copy: mutating it does not change the shape
    const c = Shape.circle(new P(0, 0), 1);
    c.outline().length = 0;
    expect(c.outline().length).toBe(64);
    expect(Shape.circle(new P(0, 0), -1).outline().length).toBe(1);
  });
});
