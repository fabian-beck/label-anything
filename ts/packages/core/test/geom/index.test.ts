// Port of the unit tests of rust/crates/la-core/src/geom/mod.rs.
import { describe, expect, it } from "vitest";
import {
  Affine,
  P,
  Rect,
  bboxOf,
  clipSegRect,
  distSegRect,
  segCrossProper,
  segLenInRect,
  segOverlapsRect,
  segSegDist,
} from "../../src/geom/index.js";

describe("geom", () => {
  it("rect_overlap_touching_is_not_overlap", () => {
    const a = Rect.xywh(0, 0, 10, 10);
    const b = Rect.xywh(10, 0, 10, 10);
    expect(a.overlaps(b)).toBe(false);
    expect(a.touches(b)).toBe(true);
    const c = Rect.xywh(9, 9, 10, 10);
    expect(a.overlaps(c)).toBe(true);
    expect(a.overlapArea(c)).toBe(1);
  });

  it("segment_distances", () => {
    const d = segSegDist(new P(0, 0), new P(10, 0), new P(0, 3), new P(10, 3));
    expect(Math.abs(d - 3)).toBeLessThan(1e-12);
    expect(segCrossProper(new P(0, 0), new P(10, 10), new P(0, 10), new P(10, 0))).toBe(true);
    expect(segCrossProper(new P(0, 0), new P(5, 5), new P(5, 5), new P(10, 0))).toBe(false);
  });

  it("clip_segment", () => {
    const r = Rect.xywh(0, 0, 10, 10);
    const l = segLenInRect(new P(-5, 5), new P(15, 5), r);
    expect(Math.abs(l - 10)).toBeLessThan(1e-12);
    expect(segOverlapsRect(new P(-5, 5), new P(15, 5), r)).toBe(true);
    expect(segOverlapsRect(new P(-5, 10), new P(15, 10), r)).toBe(false);
    expect(distSegRect(new P(12, -5), new P(12, 15), r)).toBe(2);
    expect(clipSegRect(new P(-5, 5), new P(15, 5), r)).toEqual([0.25, 0.75]);
    expect(clipSegRect(new P(-5, -5), new P(-1, 15), r)).toBeNull();
  });

  it("affine_compose", () => {
    const a = new Affine([2, 0, 0, 2, 1, 1]);
    const b = new Affine([1, 0, 0, -1, 0, 100]);
    const c = a.then(b);
    const p = new P(3, 4);
    expect(c.apply(p).eq(b.apply(a.apply(p)))).toBe(true);
    expect(Affine.IDENTITY.isIdentity()).toBe(true);
    expect(c.isIdentity()).toBe(false);
  });

  it("bbox_and_empty_rect", () => {
    expect(Rect.EMPTY.isEmpty()).toBe(true);
    expect(bboxOf([]).eq(Rect.EMPTY)).toBe(true);
    const bb = bboxOf([new P(3, -1), new P(-2, 4), new P(0, 0)]);
    expect(bb.eq(new Rect(-2, -1, 3, 4))).toBe(true);
    expect(Rect.EMPTY.union(bb).eq(bb)).toBe(true);
    expect(bb.area()).toBe(25);
    expect(new Rect(5, 5, 0, 0).area()).toBe(0);
  });
});
