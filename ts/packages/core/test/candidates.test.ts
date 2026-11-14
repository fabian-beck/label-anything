// Port of the unit tests of rust/crates/la-core/src/candidates.rs.
import { describe, expect, it } from "vitest";
import { cspacePath, dirOf, pushIn, samplePath, touchCenter, turnOf } from "../src/candidates.js";
import { sinCosDeg } from "../src/math.js";
import { P, Rect } from "../src/geom/index.js";
import { Shape } from "../src/geom/shape.js";
import { posAngle, posFromAngularIndex } from "../src/model/index.js";

function gapTo(shape: Shape, r: Rect, o: number): number {
  return shape.distRect(r) - o;
}

describe("candidates", () => {
  it("cover_of_a_turned_label", () => {
    for (const [hw, hh, deg] of [
      [40, 8, 30],
      [40, 8, -90],
      [5, 20, 45],
      [500, 2, 10],
    ] as [number, number, number][]) {
      const c = new P(100, 50);
      const [sin, cos] = sinCosDeg(deg);
      const [bbox, turn, shape] = turnOf(c, hw, hh, deg, cos, sin);
      expect(turn.upright.eq(Rect.fromCenter(c, hw, hh))).toBe(true);
      expect(turn.cover.length).toBe(Math.min(32, Math.max(1, Math.ceil(hw / hh))));
      // the label lies in its cover, and the cover in the label's bounding box
      for (let k = 0; k <= 40; k++) {
        for (let j = 0; j <= 4; j++) {
          const q = new P(-hw + (2 * hw * k) / 40, -hh + (2 * hh * j) / 4);
          const p = c.add(q.rotate(cos, sin));
          expect(turn.cover.some((b) => b.inflate(1e-9).containsPoint(p)), `${deg}: ${p.x}, ${p.y}`).toBe(true);
        }
      }
      for (const b of turn.cover) expect(bbox.inflate(1e-9).containsRect(b), String(deg)).toBe(true);
      const sb = shape.bbox();
      expect(Math.abs(sb.x0 - bbox.x0) < 1e-9 && Math.abs(sb.y1 - bbox.y1) < 1e-9).toBe(true);
    }
  });

  it("adjacent_touch_circle_tangent", () => {
    const s = Shape.circle(new P(100, 100), 10);
    const o = 2;
    for (let k = 0; k < 8; k++) {
      const p = posFromAngularIndex(k);
      const c = touchCenter(s, o, dirOf(posAngle(p)), 20, 8);
      const r = Rect.fromCenter(c, 20, 8);
      const g = gapTo(s, r, o);
      expect(Math.abs(g), `pos ${p}: gap ${g}`).toBeLessThan(1e-9);
    }
  });

  it("adjacent_rect_matches_bbox_positions", () => {
    const s = Shape.rect(new P(0, 0), 40, 20, 0, 0);
    let c = touchCenter(s, 0, dirOf(45), 10, 5);
    expect(Math.abs(c.x - 30) < 1e-12 && Math.abs(c.y + 15) < 1e-12, `${c.x}, ${c.y}`).toBe(true);
    c = touchCenter(s, 0, dirOf(90), 10, 5);
    expect(Math.abs(c.x) < 1e-12 && Math.abs(c.y + 15) < 1e-12, `${c.x}, ${c.y}`).toBe(true);
  });

  it("slider_samples_touch_the_shape", () => {
    const shapes = [
      Shape.circle(new P(0, 0), 12),
      Shape.ellipse(new P(0, 0), 20, 8, 25),
      Shape.rect(new P(0, 0), 30, 12, 3, 17),
      Shape.polygon(
        [[new P(-20, -10), new P(20, -15), new P(5, 0), new P(25, 12), new P(-15, 10)]],
        false,
        new P(0, 0),
      ),
    ];
    for (const shape of shapes) {
      for (let k = 0; k < 8; k++) {
        const path = cspacePath(shape, 2, 15, 6, k);
        for (const c0 of samplePath(path, 6, shape, 2, 15, 6)) {
          const c = pushIn(shape, 2, c0, 15, 6);
          const r = Rect.fromCenter(c, 15, 6);
          const g = shape.distRect(r) - 2;
          // touches the inflated shape (hull for concave) within tolerance
          expect(g > -1e-6 && g < 0.5, `${shape.kind} k=${k}: gap ${g}`).toBe(true);
        }
      }
    }
  });
});
