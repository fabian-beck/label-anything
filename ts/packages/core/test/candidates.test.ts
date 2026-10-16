// Port of the unit tests of rust/crates/la-core/src/candidates.rs.
import { describe, expect, it } from "vitest";
import { cspacePath, dirOf, pushIn, samplePath, touchCenter } from "../src/candidates.js";
import { P, Rect } from "../src/geom/index.js";
import { Shape } from "../src/geom/shape.js";
import { posAngle, posFromAngularIndex } from "../src/model/index.js";

function gapTo(shape: Shape, r: Rect, o: number): number {
  return shape.distRect(r) - o;
}

describe("candidates", () => {
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
