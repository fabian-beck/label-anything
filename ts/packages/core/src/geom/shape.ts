/**
 * The shape kernel (spec §3.3): item marks and positioned obstacle shapes (port of
 * `rust/crates/la-core/src/geom/shape.rs`).
 *
 * Every shape has a reference point, a bounding box, an exact support function (used for
 * shape-aware adjacent and slider candidates, ADR 0008), containment, signed distance,
 * exact rectangle and segment tests, and an outline polygon (exact for polygons and sharp
 * rectangles, a circumscribed approximation for curved shapes) used for rasterization and
 * distances.
 *
 * Rust's `enum Shape` is the union {@link Shape} of four classes discriminated by `kind`;
 * the methods live in {@link ShapeBase} and switch on `kind` like the Rust `match`es. Values
 * that Rust recomputes on every call from the shape's fields (bounding box, curved
 * outline, inner corners of a rounded rectangle) are computed once with the same
 * arithmetic. Containment, distance and overlap tests do not allocate.
 *
 * @module
 */

import { clampf, len2d, maxf, minf, signEps, sinCosDeg, toIndex } from "../math.js";
import {
  EPS,
  P,
  Rect,
  bboxOf,
  distPointSegXY,
  distSegRectXY,
  orientXY,
  rectDistPointXY,
  segCrossProperXY,
  segSegDistXY,
} from "./index.js";
import * as polygon from "./polygon.js";
import type { Ring } from "./polygon.js";

/** Number of outline vertices for curved shapes (per full turn). */
const CURVE_SEGMENTS = 64;

/** Scratch quadrilaterals `[x0, y0, …, x3, y3]` of the allocation-free tests. */
const QA = new Float64Array(8);
const QB = new Float64Array(8);
/** Scratch point of {@link ShapeBase.boundaryPoint}. */
const BP = new Float64Array(2);

/** Polygon (possibly concave, with holes) with an explicit reference point. */
export class PolyShape {
  /** Rings (outer boundary first, then holes). */
  readonly rings: P[][];
  /** Even-odd fill rule (else non-zero). */
  readonly evenOdd: boolean;
  /** Convex hull, counter-clockwise in math orientation. */
  readonly hull: P[];
  /** Bounding box of all rings. */
  readonly bbox: Rect;
  /** Reference point (anchor). */
  readonly reference: P;

  constructor(rings: P[][], evenOdd: boolean, reference: P) {
    const all: P[] = [];
    for (const r of rings) for (const p of r) all.push(p);
    this.rings = rings;
    this.evenOdd = evenOdd;
    this.hull = polygon.convexHull(all);
    this.bbox = bboxOf(all);
    this.reference = reference;
  }
}

/** Unit-ish direction helpers for the 8 fixed positions (screen coordinates, y down). */
export function signDir(d: P): [number, number] {
  return [signEps(d.x, 1e-12), signEps(d.y, 1e-12)];
}

/** A mark or obstacle shape (Rust `enum Shape`), discriminated by `kind`. */
export type Shape = CircleShape | EllipseShape | RoundRectShape | PolygonShape;

/** Constructors of {@link Shape} (Rust `Shape::circle`, `Shape::ellipse`, …). */
export const Shape = {
  /** Circle helper (negative radii become 0). */
  circle(c: P, r: number): Shape {
    return new CircleShape(c, maxf(r, 0));
  },

  /** Ellipse with rotation in degrees (clockwise on screen); `rx == ry` gives a circle. */
  ellipse(c: P, rx: number, ry: number, rotationDeg: number): Shape {
    const [sin, cos] = sinCosDeg(rotationDeg);
    if (Math.abs(rx - ry) <= 0) return new CircleShape(c, rx);
    return new EllipseShape(c, maxf(rx, 0), maxf(ry, 0), cos, sin);
  },

  /** Rectangle centered at `c` with optional corner radius and rotation (degrees). */
  rect(c: P, w: number, h: number, cornerRadius: number, rotationDeg: number): Shape {
    const hw = maxf(w, 0) * 0.5;
    const hh = maxf(h, 0) * 0.5;
    const r = clampf(cornerRadius, 0, minf(hw, hh));
    const [sin, cos] = sinCosDeg(rotationDeg);
    return new RoundRectShape(c, hw, hh, r, cos, sin);
  },

  /** Polygon (rings, fill rule) with an explicit reference point. */
  polygon(rings: P[][], evenOdd: boolean, reference: P): Shape {
    return new PolygonShape(new PolyShape(rings, evenOdd, reference));
  },
};

/** Methods shared by all {@link Shape} variants (Rust `impl Shape`). */
export abstract class ShapeBase {
  /** The reference point (anchor). */
  reference(): P {
    const s = this as unknown as Shape;
    return s.kind === "polygon" ? s.poly.reference : s.c;
  }

  /** Axis-aligned bounding box. */
  bbox(): Rect {
    const s = this as unknown as Shape;
    return s.kind === "polygon" ? s.poly.bbox : s.bb;
  }

  /** Area of the shape. */
  area(): number {
    const s = this as unknown as Shape;
    switch (s.kind) {
      case "circle":
        return Math.PI * s.r * s.r;
      case "ellipse":
        return Math.PI * s.rx * s.ry;
      case "roundRect":
        return 4 * s.hw * s.hh - (4 - Math.PI) * s.r * s.r;
      case "polygon":
        return polygon.area(s.poly.rings, s.poly.evenOdd);
    }
  }

  /** Whether the shape is a (possibly degenerate) disc. */
  isCircle(): boolean {
    return (this as unknown as Shape).kind === "circle";
  }

  /**
   * Support point: the point of the shape that is extreme in direction `d`. For flat
   * sides perpendicular to `d` the point closest to the projection of the reference point
   * is returned (so labels center on flat sides).
   */
  support(d: P): P {
    const s = this as unknown as Shape;
    // dn = d.norm()
    const l = len2d(d.x, d.y);
    const dnx = l > 0 ? d.x / l : 0;
    const dny = l > 0 ? d.y / l : 0;
    switch (s.kind) {
      case "circle":
        return new P(s.c.x + dnx * s.r, s.c.y + dny * s.r);
      case "ellipse": {
        const { c, rx, ry, cos, sin } = s;
        const lx = dnx * cos + dny * sin;
        const ly = -dnx * sin + dny * cos;
        const ax = rx * rx * lx;
        const ay = ry * ry * ly;
        const den = len2d(rx * lx, ry * ly);
        if (den <= 0) return c;
        const qx = ax / den;
        const qy = ay / den;
        return new P(c.x + (qx * cos - qy * sin), c.y + (qx * sin + qy * cos));
      }
      case "roundRect": {
        const { c, hw, hh, r, cos, sin } = s;
        const lx = dnx * cos + dny * sin;
        const ly = -dnx * sin + dny * cos;
        const iw = hw - r;
        const ih = hh - r;
        const sx = signEps(lx, 1e-9);
        const sy = signEps(ly, 1e-9);
        const qx = sx * iw + lx * r;
        const qy = sy * ih + ly * r;
        return new P(c.x + (qx * cos - qy * sin), c.y + (qx * sin + qy * cos));
      }
      case "polygon":
        return supportHull(s.poly.hull, s.poly.reference, new P(dnx, dny));
    }
  }

  /** Support point of the shape inflated by `o` (Minkowski sum with a disc). */
  supportInflated(d: P, o: number): P {
    const p = this.support(d);
    const n = d.norm();
    return new P(p.x + n.x * o, p.y + n.y * o);
  }

  /** Point containment (closed shape). */
  contains(p: P): boolean {
    return this.signedDistanceXY(p.x, p.y) <= 0;
  }

  /** {@link contains} on scalars. */
  containsXY(px: number, py: number): boolean {
    return this.signedDistanceXY(px, py) <= 0;
  }

  /** Signed distance from `p` to the boundary (negative inside). */
  signedDistance(p: P): number {
    return this.signedDistanceXY(p.x, p.y);
  }

  /** {@link signedDistance} on scalars. */
  signedDistanceXY(px: number, py: number): number {
    const s = this as unknown as Shape;
    // (the arms are small functions so that this dispatcher stays inlinable)
    switch (s.kind) {
      case "circle":
        return len2d(px - s.c.x, py - s.c.y) - s.r;
      case "ellipse":
        return ellipseSd(s, px, py);
      case "roundRect":
        return roundRectSd(s, px, py);
      case "polygon":
        return polygonSd(s.poly, px, py);
    }
  }

  /** The open rectangle `r` overlaps the shape's interior by more than `EPS`. */
  overlapsRect(r: Rect): boolean {
    const s = this as unknown as Shape;
    switch (s.kind) {
      case "circle":
        return circleOverlapsRect(s, r);
      case "ellipse":
        return ellipseOverlapsRect(s, r);
      case "roundRect":
        return roundRectOverlapsRect(s, r);
      case "polygon":
        return polygon.overlapsRect(s.poly.rings, s.poly.evenOdd, s.poly.bbox, r);
    }
  }

  /** Distance between the shape and rectangle `r` (0 when they touch or overlap). */
  distRect(r: Rect): number {
    const s = this as unknown as Shape;
    switch (s.kind) {
      case "circle":
        return maxf(rectDistPointXY(r.x0, r.y0, r.x1, r.y1, s.c.x, s.c.y) - s.r, 0);
      case "polygon":
        return polygon.distRect(s.poly.rings, s.poly.evenOdd, s.poly.bbox, r);
      case "roundRect":
        return maxf(convexPolyRectDistance(s.inner, 4, r) - s.r, 0);
      case "ellipse": {
        if (this.overlapsRect(r)) return 0;
        // The signed distance to a convex set is convex along a segment, so a ternary
        // search per rectangle edge finds the exact minimum.
        const { x0, y0, x1, y1 } = r;
        let m = Infinity;
        m = minf(m, minDistOnSegment(this, x0, y0, x1, y0));
        m = minf(m, minDistOnSegment(this, x1, y0, x1, y1));
        m = minf(m, minDistOnSegment(this, x1, y1, x0, y1));
        m = minf(m, minDistOnSegment(this, x0, y1, x0, y0));
        return maxf(m, 0);
      }
    }
  }

  /** Segment `ab` passes within `clearance` of the shape (interior when 0). */
  nearSegment(a: P, b: P, clearance: number): boolean {
    const d = this.distSegmentXY(a.x, a.y, b.x, b.y);
    return d < clearance - EPS || (clearance <= 0 && d < -EPS);
  }

  /**
   * Signed-ish distance between segment `ab` and the shape: 0 if they intersect,
   * otherwise the gap.
   */
  distSegment(a: P, b: P): number {
    return this.distSegmentXY(a.x, a.y, b.x, b.y);
  }

  /** {@link distSegment} on scalars. */
  distSegmentXY(ax: number, ay: number, bx: number, by: number): number {
    const s = this as unknown as Shape;
    if (s.kind === "circle") return maxf(distPointSegXY(s.c.x, s.c.y, ax, ay, bx, by) - s.r, 0);
    if (this.containsXY(ax, ay) || this.containsXY(bx, by)) return 0;
    const outline = outlineRingsOf(s);
    let m = Infinity;
    for (let k = 0; k < outline.length; k++) {
      const ring = outline[k]!;
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const p = ring[i]!;
        const q = ring[(i + 1) % n]!;
        m = minf(m, segSegDistXY(ax, ay, bx, by, p.x, p.y, q.x, q.y));
      }
    }
    return m;
  }

  /**
   * Length of the part of segment `ab` inside the shape (approximate for curved shapes:
   * sampled at `step` px).
   */
  coveredLen(a: P, b: P, step: number): number {
    const len = a.dist(b);
    if (len <= 0) return 0;
    const n = toIndex(maxf(Math.ceil(len / maxf(step, 0.25)), 1));
    let inside = 0;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      if (this.containsXY(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) inside += 1;
    }
    return (len * inside) / n;
  }

  /** First boundary point along the ray from the reference point in direction `dir`. */
  boundaryPoint(dir: P): P {
    BP[0] = dir.x;
    BP[1] = dir.y;
    this.boundaryPointIn(BP);
    return new P(BP[0]!, BP[1]!);
  }

  /**
   * {@link boundaryPoint} in place: the direction in `io[0..2]` is replaced by the point
   * (the same operations, without allocating or passing coordinates as arguments).
   */
  boundaryPointIn(io: Float64Array): void {
    const s = this as unknown as Shape;
    const out = io;
    const dirX = io[0]!;
    const dirY = io[1]!;
    // d = dir.norm()
    const l = len2d(dirX, dirY);
    const dx = l > 0 ? dirX / l : 0;
    const dy = l > 0 ? dirY / l : 0;
    const o = this.reference();
    switch (s.kind) {
      case "circle":
        out[0] = s.c.x + dx * s.r;
        out[1] = s.c.y + dy * s.r;
        return;
      case "ellipse": {
        const { c, rx, ry, cos, sin } = s;
        const lx = dx * cos + dy * sin;
        const ly = -dx * sin + dy * cos;
        const den = (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry);
        if (den <= 0) {
          out[0] = c.x;
          out[1] = c.y;
          return;
        }
        const k = 1 / Math.sqrt(den);
        out[0] = c.x + dx * k;
        out[1] = c.y + dy * k;
        return;
      }
      default: {
        // bisection on the signed distance along the ray (the reference point may be
        // outside concave shapes; then the first exit is searched from there)
        const bb = this.bbox();
        const far = len2d(bb.w(), bb.h()) + len2d(o.x - (bb.x0 + bb.x1) * 0.5, o.y - (bb.y0 + bb.y1) * 0.5) + 1;
        let lo = 0;
        let hi = far;
        if (!this.containsXY(o.x, o.y)) {
          out[0] = o.x;
          out[1] = o.y;
          return;
        }
        for (let i = 0; i < 48; i++) {
          const mid = (lo + hi) * 0.5;
          if (this.containsXY(o.x + dx * mid, o.y + dy * mid)) {
            lo = mid;
          } else {
            hi = mid;
          }
        }
        out[0] = o.x + dx * lo;
        out[1] = o.y + dy * lo;
      }
    }
  }

  /**
   * Outline as rings: exact for polygons and sharp rectangles; curved shapes are
   * approximated by a circumscribed polygon (so the outline contains the shape).
   * Returns fresh arrays.
   */
  outlineRings(): P[][] {
    const s = this as unknown as Shape;
    if (s.kind === "polygon") return s.poly.rings.map((r) => r.slice());
    return [this.outline()];
  }

  /** Outline of convex shapes (for polygons: the convex hull). Returns a fresh array. */
  outline(): P[] {
    return outlineOf(this as unknown as Shape).slice();
  }

  /**
   * The outline rings without copying (the polygon's rings, or the cached outline of a
   * curved shape): for hot paths such as rasterization; never mutate the result.
   */
  outlineRingsView(): readonly Ring[] {
    return outlineRingsOf(this as unknown as Shape);
  }

  /** Translate the shape. */
  translated(d: P): Shape {
    const s = this as unknown as Shape;
    switch (s.kind) {
      case "circle":
        return new CircleShape(s.c.add(d), s.r);
      case "ellipse":
        return new EllipseShape(s.c.add(d), s.rx, s.ry, s.cos, s.sin);
      case "roundRect":
        return new RoundRectShape(s.c.add(d), s.hw, s.hh, s.r, s.cos, s.sin);
      case "polygon":
        return Shape.polygon(
          s.poly.rings.map((r) => r.map((q) => q.add(d))),
          s.poly.evenOdd,
          s.poly.reference.add(d),
        );
    }
  }

  /** The rectangle (with padding `pad`) fits inside the shape. */
  containsRect(r: Rect, pad: number): boolean {
    const s = this as unknown as Shape;
    if (s.kind === "polygon") return polygon.containsRect(s.poly.rings, s.poly.evenOdd, r, pad);
    // convex shapes: all corners inside suffices (rr = r.inflate(pad))
    const x0 = r.x0 - pad;
    const y0 = r.y0 - pad;
    const x1 = r.x1 + pad;
    const y1 = r.y1 + pad;
    return (
      this.signedDistanceXY(x0, y0) <= EPS &&
      this.signedDistanceXY(x1, y0) <= EPS &&
      this.signedDistanceXY(x1, y1) <= EPS &&
      this.signedDistanceXY(x0, y1) <= EPS
    );
  }
}

/** Disc. `r = 0` is a bare point. */
export class CircleShape extends ShapeBase {
  /** Discriminator. */
  readonly kind = "circle" as const;
  /** Center. */
  readonly c: P;
  /** Radius. */
  readonly r: number;
  /** Bounding box (Rust recomputes it per call). */
  readonly bb: Rect;
  /** Outline rings `[outline()]`, computed on first use (internal cache). */
  ol: P[][] | null = null;

  constructor(c: P, r: number) {
    super();
    this.c = c;
    this.r = r;
    this.bb = Rect.fromCenter(c, r, r);
  }
}

/** Ellipse with semi-axes `rx`, `ry`, rotated by (cos, sin) clockwise on screen. */
export class EllipseShape extends ShapeBase {
  /** Discriminator. */
  readonly kind = "ellipse" as const;
  /** Center. */
  readonly c: P;
  /** Semi-axis along the rotated x axis. */
  readonly rx: number;
  /** Semi-axis along the rotated y axis. */
  readonly ry: number;
  /** Cosine of the rotation. */
  readonly cos: number;
  /** Sine of the rotation (clockwise on screen). */
  readonly sin: number;
  /** Bounding box (Rust recomputes it per call). */
  readonly bb: Rect;
  /** Outline rings `[outline()]`, computed on first use (internal cache). */
  ol: P[][] | null = null;

  constructor(c: P, rx: number, ry: number, cos: number, sin: number) {
    super();
    this.c = c;
    this.rx = rx;
    this.ry = ry;
    this.cos = cos;
    this.sin = sin;
    // half extents of a rotated ellipse
    const hx = len2d(rx * cos, ry * sin);
    const hy = len2d(rx * sin, ry * cos);
    this.bb = Rect.fromCenter(c, hx, hy);
  }
}

/** Rectangle with half sizes and corner radius, rotated about its center. */
export class RoundRectShape extends ShapeBase {
  /** Discriminator. */
  readonly kind = "roundRect" as const;
  /** Center. */
  readonly c: P;
  /** Half width. */
  readonly hw: number;
  /** Half height. */
  readonly hh: number;
  /** Corner radius (at most `min(hw, hh)`). */
  readonly r: number;
  /** Cosine of the rotation. */
  readonly cos: number;
  /** Sine of the rotation (clockwise on screen). */
  readonly sin: number;
  /** Bounding box (Rust recomputes it per call). */
  readonly bb: Rect;
  /** Corners of the inner (sharp) rectangle `(hw - r) × (hh - r)`, `[x0, y0, …]`. */
  readonly inner: Float64Array;
  /** Outline rings `[outline()]`, computed on first use (internal cache). */
  ol: P[][] | null = null;

  constructor(c: P, hw: number, hh: number, r: number, cos: number, sin: number) {
    super();
    this.c = c;
    this.hw = hw;
    this.hh = hh;
    this.r = r;
    this.cos = cos;
    this.sin = sin;
    const hx = Math.abs(hw * cos) + Math.abs(hh * sin);
    const hy = Math.abs(hw * sin) + Math.abs(hh * cos);
    this.bb = Rect.fromCenter(c, hx, hy);
    this.inner = new Float64Array(8);
    rotatedRectCornersXY(c, hw - r, hh - r, cos, sin, this.inner);
  }
}

/** Polygon (possibly concave, with holes) with an explicit reference point. */
export class PolygonShape extends ShapeBase {
  /** Discriminator. */
  readonly kind = "polygon" as const;
  /** The polygon data (Rust: the boxed `PolyShape` of `Shape::Polygon`). */
  readonly poly: PolyShape;

  constructor(poly: PolyShape) {
    super();
    this.poly = poly;
  }
}

// Arms of `ShapeBase.signedDistanceXY` and `ShapeBase.overlapsRect`.

function ellipseSd(s: EllipseShape, px: number, py: number): number {
  const { c, cos, sin } = s;
  const dx = px - c.x;
  const dy = py - c.y;
  return ellipseSignedDistance(dx * cos + dy * sin, -dx * sin + dy * cos, s.rx, s.ry);
}

function roundRectSd(s: RoundRectShape, px: number, py: number): number {
  const { c, hw, hh, r, cos, sin } = s;
  const dx = px - c.x;
  const dy = py - c.y;
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;
  const qx = Math.abs(lx) - (hw - r);
  const qy = Math.abs(ly) - (hh - r);
  const outside = len2d(maxf(qx, 0), maxf(qy, 0));
  return outside + minf(maxf(qx, qy), 0) - r;
}

function polygonSd(ps: PolyShape, px: number, py: number): number {
  const d = polygon.distBoundaryXY(ps.rings, px, py);
  return polygon.containsXY(ps.rings, ps.evenOdd, px, py) ? -d : d;
}

function circleOverlapsRect(s: CircleShape, r: Rect): boolean {
  const c = s.c;
  if (s.r <= EPS) {
    // a bare point overlaps only if strictly inside: r.inflate(-EPS).contains_point(c)
    const d = -EPS;
    return c.x >= r.x0 - d && c.x <= r.x1 + d && c.y >= r.y0 - d && c.y <= r.y1 + d;
  }
  return rectDistPointXY(r.x0, r.y0, r.x1, r.y1, c.x, c.y) < s.r - EPS;
}

function ellipseOverlapsRect(s: EllipseShape, r: Rect): boolean {
  if (!s.bb.overlaps(r)) return false;
  // map to the unit circle: the rectangle becomes a parallelogram
  const { c, rx, ry, cos, sin } = s;
  for (let i = 0; i < 4; i++) {
    const kx = i === 0 || i === 3 ? r.x0 : r.x1;
    const ky = i < 2 ? r.y0 : r.y1;
    const dx = kx - c.x;
    const dy = ky - c.y;
    QA[2 * i] = (dx * cos + dy * sin) / rx;
    QA[2 * i + 1] = (-dx * sin + dy * cos) / ry;
  }
  return convexQuadOverlapsUnitDisc(QA, EPS / maxf(minf(rx, ry), EPS));
}

function roundRectOverlapsRect(s: RoundRectShape, r: Rect): boolean {
  if (!s.bb.overlaps(r)) return false;
  // distance between the inner (sharp) rect and `r` < rad
  if (s.r <= 0) {
    rectCorners(r, QB);
    return convexPolygonsOverlap(s.inner, 4, QB, 4, EPS);
  }
  return convexPolyRectDistance(s.inner, 4, r) < s.r - EPS;
}

/** Interiors of two shapes overlap (touching is allowed). */
export function shapesOverlap(a: Shape, b: Shape): boolean {
  if (!a.bbox().overlaps(b.bbox())) return false;
  if (a.kind === "circle") return b.signedDistanceXY(a.c.x, a.c.y) < a.r - EPS;
  if (b.kind === "circle") return a.signedDistanceXY(b.c.x, b.c.y) < b.r - EPS;
  const ra = outlineRingsOf(a);
  const rb = outlineRingsOf(b);
  for (const x of ra) {
    for (const y of rb) {
      const n = x.length;
      const m = y.length;
      for (let i = 0; i < n; i++) {
        const p = x[i]!;
        const q = x[(i + 1) % n]!;
        for (let j = 0; j < m; j++) {
          const u = y[j]!;
          const v = y[(j + 1) % m]!;
          if (segCrossProperXY(p.x, p.y, q.x, q.y, u.x, u.y, v.x, v.y)) return true;
        }
      }
    }
  }
  // no crossing edges: one may contain the other
  const br = b.reference();
  return inside(a, rb) || inside(b, ra) || (a.signedDistance(br) < -EPS && b.contains(br));
}

function inside(s: Shape, rings: readonly Ring[]): boolean {
  for (let k = 0; k < rings.length; k++) {
    const r = rings[k]!;
    for (let i = 0; i < r.length; i++) {
      const p = r[i]!;
      if (s.signedDistanceXY(p.x, p.y) < -EPS) return true;
    }
  }
  return false;
}

/** The outline rings of a shape without copying (internal; callers must not mutate). */
function outlineRingsOf(s: Shape): readonly Ring[] {
  if (s.kind === "polygon") return s.poly.rings;
  if (s.ol === null) s.ol = [computeOutline(s)];
  return s.ol;
}

/** The (cached) outline of a shape; callers must not mutate it. */
function outlineOf(s: Shape): readonly P[] {
  if (s.kind === "polygon") return s.poly.hull;
  return outlineRingsOf(s)[0]!;
}

function computeOutline(s: CircleShape | EllipseShape | RoundRectShape): P[] {
  switch (s.kind) {
    case "circle": {
      const { c, r } = s;
      if (r <= 0) return [c];
      const k = 1 / cosHalfStep(CURVE_SEGMENTS);
      const pts: P[] = [];
      for (let i = 0; i < CURVE_SEGMENTS; i++) {
        const [sn, co] = sinCosDeg((360 * i) / CURVE_SEGMENTS);
        pts.push(new P(c.x + co * r * k, c.y + sn * r * k));
      }
      return pts;
    }
    case "ellipse": {
      const { c, rx, ry, cos, sin } = s;
      const k = 1 / cosHalfStep(CURVE_SEGMENTS);
      const pts: P[] = [];
      for (let i = 0; i < CURVE_SEGMENTS; i++) {
        const [sn, co] = sinCosDeg((360 * i) / CURVE_SEGMENTS);
        const x = co * rx * k;
        const y = sn * ry * k;
        pts.push(new P(c.x + (x * cos - y * sin), c.y + (x * sin + y * cos)));
      }
      return pts;
    }
    case "roundRect": {
      const { c, hw, hh, r, cos, sin } = s;
      if (r <= 0) {
        const q = new Float64Array(8);
        rotatedRectCornersXY(c, hw, hh, cos, sin, q);
        return [new P(q[0]!, q[1]!), new P(q[2]!, q[3]!), new P(q[4]!, q[5]!), new P(q[6]!, q[7]!)];
      }
      const per = CURVE_SEGMENTS / 4;
      const k = 1 / cosHalfStep(CURVE_SEGMENTS);
      const iw = hw - r;
      const ih = hh - r;
      const pts: P[] = [];
      // corners: (+,+) 0..90, (-,+) 90..180, (-,-) 180..270, (+,-) 270..360
      const cxs = [iw, -iw, -iw, iw];
      const cys = [ih, ih, -ih, -ih];
      for (let q = 0; q < 4; q++) {
        for (let j = 0; j <= per; j++) {
          const a = 90 * q + (90 * j) / per;
          const [sn, co] = sinCosDeg(a);
          const px = cxs[q]! + co * r * k;
          const py = cys[q]! + sn * r * k;
          pts.push(new P(c.x + (px * cos - py * sin), c.y + (px * sin + py * cos)));
        }
      }
      return pts;
    }
  }
}

/** Minimum signed distance from the points of segment `ab` to a convex shape. */
function minDistOnSegment(s: ShapeBase, ax: number, ay: number, bx: number, by: number): number {
  let lo = 0;
  let hi = 1;
  const dx = bx - ax;
  const dy = by - ay;
  for (let i = 0; i < 60; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (s.signedDistanceXY(ax + dx * m1, ay + dy * m1) <= s.signedDistanceXY(ax + dx * m2, ay + dy * m2)) {
      hi = m2;
    } else {
      lo = m1;
    }
  }
  const t = (lo + hi) * 0.5;
  return minf(s.signedDistanceXY(ax + dx * t, ay + dy * t), minf(s.signedDistanceXY(ax, ay), s.signedDistanceXY(bx, by)));
}

/** cos(π / n): `1 / cosHalfStep(n)` is the factor of a circumscribed regular n-gon. */
function cosHalfStep(n: number): number {
  return sinCosDeg(180 / n)[1];
}

/** Rust `rotated_rect_corners` into `out` as `[x0, y0, …, x3, y3]`. */
function rotatedRectCornersXY(c: P, hw: number, hh: number, cos: number, sin: number, out: Float64Array): void {
  // c + P(±hw, ±hh).rotate(cos, sin) for (-,-), (+,-), (+,+), (-,+)
  for (let i = 0; i < 4; i++) {
    const x = i === 0 || i === 3 ? -hw : hw;
    const y = i < 2 ? -hh : hh;
    out[2 * i] = c.x + (x * cos - y * sin);
    out[2 * i + 1] = c.y + (x * sin + y * cos);
  }
}

/** `r.corners()` (top-left, top-right, bottom-right, bottom-left) into `out`. */
function rectCorners(r: Rect, out: Float64Array): void {
  out[0] = r.x0;
  out[1] = r.y0;
  out[2] = r.x1;
  out[3] = r.y0;
  out[4] = r.x1;
  out[5] = r.y1;
  out[6] = r.x0;
  out[7] = r.y1;
}

/** Support of a convex hull with flat-side tie-breaking toward the reference point. */
function supportHull(hull: readonly P[], reference: P, d: P): P {
  if (hull.length === 0) return reference;
  let best = -Infinity;
  for (let i = 0; i < hull.length; i++) {
    const s = hull[i]!.dot(d);
    if (s > best) best = s;
  }
  const tol = 1e-9 * maxf(1, Math.abs(best));
  // the support set (one vertex or an edge): indices i with dot >= best - tol
  const n = hull.length;
  let count = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (hull[i]!.dot(d) >= best - tol) {
      if (first < 0) first = i;
      last = i;
      count += 1;
    }
  }
  if (count === 0) throw new Error("support: no support vertex (non-finite direction)");
  if (count === 1) return hull[first]!;
  // flat side: choose the point of the support segment closest to the projection of
  // the reference point
  let lo = hull[first]!;
  let hi = hull[last]!;
  // order the two extreme points along the edge direction perpendicular to d
  const t = d.perp();
  for (let i = 0; i < n; i++) {
    const v = hull[i]!;
    if (!(v.dot(d) >= best - tol)) continue;
    if (v.dot(t) < lo.dot(t)) lo = v;
    if (v.dot(t) > hi.dot(t)) hi = v;
  }
  const rt = clampf(reference.dot(t), lo.dot(t), hi.dot(t));
  const span = hi.dot(t) - lo.dot(t);
  if (span <= 0) return lo;
  return lo.lerp(hi, (rt - lo.dot(t)) / span);
}

/**
 * Signed distance to an axis-aligned ellipse centered at the origin (local frame),
 * using a fixed number of bisection steps (deterministic).
 */
function ellipseSignedDistance(x: number, y: number, a: number, b: number): number {
  if (a <= 0 || b <= 0) return len2d(x, y) - maxf(a, b);
  // Symmetry: work in the first quadrant.
  const px = Math.abs(x);
  const py = Math.abs(y);
  const inside = (px * px) / (a * a) + (py * py) / (b * b) <= 1;
  // Closest point via Eberly's robust bisection on t for (x0, y0) outside or inside.
  const d = ellipseDistFirstQuadrant(a, b, px, py);
  return inside ? -d : d;
}

function ellipseDistFirstQuadrant(a: number, b: number, x: number, y: number): number {
  // Ensure a >= b by swapping axes.
  const swap = !(a >= b);
  const e0 = swap ? b : a;
  const e1 = swap ? a : b;
  const y0 = swap ? y : x;
  const y1 = swap ? x : y;
  if (y1 > 0) {
    if (y0 > 0) {
      const z0 = y0 / e0;
      const z1 = y1 / e1;
      const g = z0 * z0 + z1 * z1 - 1;
      if (g !== 0) {
        const r0 = (e0 / e1) * (e0 / e1);
        const sbar = bisectRoot(r0, z0, z1, g);
        const x0 = (r0 * y0) / (sbar + r0);
        const x1 = y1 / (sbar + 1);
        return len2d(x0 - y0, x1 - y1);
      }
      return 0;
    }
    return Math.abs(y1 - e1);
  }
  const numer0 = e0 * y0;
  const denom0 = e0 * e0 - e1 * e1;
  if (numer0 < denom0) {
    const xde0 = numer0 / denom0;
    const x0 = e0 * xde0;
    const x1 = e1 * Math.sqrt(maxf(1 - xde0 * xde0, 0));
    return len2d(x0 - y0, x1);
  }
  return Math.abs(y0 - e0);
}

function bisectRoot(r0: number, z0: number, z1: number, g: number): number {
  const n0 = r0 * z0;
  let s0 = z1 - 1;
  let s1 = g < 0 ? 0 : len2d(n0, z1) - 1;
  let s = 0;
  for (let i = 0; i < 64; i++) {
    s = (s0 + s1) * 0.5;
    if (s === s0 || s === s1) break;
    const ratio0 = n0 / (s + r0);
    const ratio1 = z1 / (s + 1);
    const gg = ratio0 * ratio0 + ratio1 * ratio1 - 1;
    if (gg > 0) {
      s0 = s;
    } else if (gg < 0) {
      s1 = s;
    } else {
      break;
    }
  }
  return s;
}

/** A convex quadrilateral (in unit-disc space) overlaps the open unit disc. */
function convexQuadOverlapsUnitDisc(q: Float64Array, eps: number): boolean {
  // distance from origin to the convex quad < 1 - eps
  if (pointInConvex(q, 4, 0, 0)) return true;
  let m = Infinity;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    m = minf(m, distPointSegXY(0, 0, q[2 * i]!, q[2 * i + 1]!, q[2 * j]!, q[2 * j + 1]!));
  }
  return m < 1 - eps;
}

function pointInConvex(poly: Float64Array, n: number, px: number, py: number): boolean {
  let pos = false;
  let neg = false;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const o = orientXY(poly[2 * i]!, poly[2 * i + 1]!, poly[2 * j]!, poly[2 * j + 1]!, px, py);
    if (o > 0) {
      pos = true;
    } else if (o < 0) {
      neg = true;
    }
    if (pos && neg) return false;
  }
  return true;
}

/** Separating-axis overlap test for two convex polygons (interiors overlap by > eps). */
function convexPolygonsOverlap(a: Float64Array, na: number, b: Float64Array, nb: number, eps: number): boolean {
  for (let pass = 0; pass < 2; pass++) {
    const poly = pass === 0 ? a : b;
    const n = pass === 0 ? na : nb;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ex = poly[2 * j]! - poly[2 * i]!;
      const ey = poly[2 * j + 1]! - poly[2 * i + 1]!;
      // axis = e.perp().norm()
      const l = len2d(-ey, ex);
      const ax = l > 0 ? -ey / l : 0;
      const ay = l > 0 ? ex / l : 0;
      if (ax * ax + ay * ay === 0) continue;
      if (na === 4 && nb === 4) {
        // the common case (rectangles), unrolled
        if (separatedQuads(a, b, ax, ay, eps)) return false;
        continue;
      }
      // amin = minf(amin, s) etc.: the accumulators start at ±inf and only take values
      // of s that are not NaN, so the NaN branch of minf/maxf can never apply
      let amin = Infinity;
      let amax = -Infinity;
      for (let k = 0; k < na; k++) {
        const s = a[2 * k]! * ax + a[2 * k + 1]! * ay;
        if (s < amin) amin = s;
        if (s > amax) amax = s;
      }
      let bmin = Infinity;
      let bmax = -Infinity;
      for (let k = 0; k < nb; k++) {
        const s = b[2 * k]! * ax + b[2 * k + 1]! * ay;
        if (s < bmin) bmin = s;
        if (s > bmax) bmax = s;
      }
      if (amax <= bmin + eps || bmax <= amin + eps) return false;
    }
  }
  return true;
}

/**
 * The projections of two quadrilaterals onto `(ax, ay)` are separated (the body of
 * {@link convexPolygonsOverlap} for 4 + 4 points, unrolled: same operations, same order).
 */
function separatedQuads(a: Float64Array, b: Float64Array, ax: number, ay: number, eps: number): boolean {
  const s0 = a[0]! * ax + a[1]! * ay;
  const s1 = a[2]! * ax + a[3]! * ay;
  const s2 = a[4]! * ax + a[5]! * ay;
  const s3 = a[6]! * ax + a[7]! * ay;
  let amin = s0 < Infinity ? s0 : Infinity;
  let amax = s0 > -Infinity ? s0 : -Infinity;
  if (s1 < amin) amin = s1;
  if (s1 > amax) amax = s1;
  if (s2 < amin) amin = s2;
  if (s2 > amax) amax = s2;
  if (s3 < amin) amin = s3;
  if (s3 > amax) amax = s3;
  const t0 = b[0]! * ax + b[1]! * ay;
  const t1 = b[2]! * ax + b[3]! * ay;
  const t2 = b[4]! * ax + b[5]! * ay;
  const t3 = b[6]! * ax + b[7]! * ay;
  let bmin = t0 < Infinity ? t0 : Infinity;
  let bmax = t0 > -Infinity ? t0 : -Infinity;
  if (t1 < bmin) bmin = t1;
  if (t1 > bmax) bmax = t1;
  if (t2 < bmin) bmin = t2;
  if (t2 > bmax) bmax = t2;
  if (t3 < bmin) bmin = t3;
  if (t3 > bmax) bmax = t3;
  return amax <= bmin + eps || bmax <= amin + eps;
}

/** Distance between a convex polygon and a rectangle (0 if overlapping/touching). */
function convexPolyRectDistance(poly: Float64Array, n: number, r: Rect): number {
  rectCorners(r, QB);
  if (n >= 3 && convexPolygonsOverlap(poly, n, QB, 4, 0)) return 0;
  let m = Infinity;
  if (n === 1) return rectDistPointXY(r.x0, r.y0, r.x1, r.y1, poly[0]!, poly[1]!);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    m = minf(m, distSegRectXY(poly[2 * i]!, poly[2 * i + 1]!, poly[2 * j]!, poly[2 * j + 1]!, r.x0, r.y0, r.x1, r.y1));
  }
  return m;
}
