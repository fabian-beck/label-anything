/**
 * Geometry primitives: points, rectangles, segments, affine maps (port of
 * `rust/crates/la-core/src/geom/mod.rs`).
 *
 * Conventions: canvas pixels, y down. Rectangles are stored as min/max corners.
 * "Overlap" always means overlap of interiors by more than {@link EPS}; touching is
 * allowed.
 *
 * Every segment predicate also has a scalar form (`…XY`) taking coordinates instead of
 * points; the shape kernel and the rasterizer use those in their hot paths, which must
 * not allocate. Both forms compute the same values with the same operations.
 *
 * @module
 */

import { clampf, len2d, maxf, minf } from "../math.js";

/** Geometric tolerance in pixels. Touching within this distance is not an overlap. */
export const EPS = 1e-6;

/** A point or vector in canvas pixels (immutable). */
export class P {
  /** x in canvas pixels. */
  readonly x: number;
  /** y in canvas pixels (down). */
  readonly y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  /** Dot product. */
  dot(o: P): number {
    return this.x * o.x + this.y * o.y;
  }

  /** 2-D cross product `x·o.y − y·o.x`. */
  cross(o: P): number {
    return this.x * o.y - this.y * o.x;
  }

  /** Euclidean length. */
  len(): number {
    return len2d(this.x, this.y);
  }

  /** Squared length. */
  len2(): number {
    return this.x * this.x + this.y * this.y;
  }

  /** Unit vector (the zero vector stays zero). */
  norm(): P {
    const l = this.len();
    return l > 0 ? new P(this.x / l, this.y / l) : new P(0, 0);
  }

  /** Perpendicular (rotated +90° in math orientation; clockwise on screen with y down). */
  perp(): P {
    return new P(-this.y, this.x);
  }

  /** Distance to `o`. */
  dist(o: P): number {
    return len2d(this.x - o.x, this.y - o.y);
  }

  /** Linear interpolation `self + (o − self)·t`. */
  lerp(o: P, t: number): P {
    return new P(this.x + (o.x - this.x) * t, this.y + (o.y - this.y) * t);
  }

  /** Rotate by (cos, sin), clockwise on screen for positive angles (SVG convention). */
  rotate(cos: number, sin: number): P {
    return new P(this.x * cos - this.y * sin, this.x * sin + this.y * cos);
  }

  /** Inverse rotation of {@link P.rotate}. */
  unrotate(cos: number, sin: number): P {
    return new P(this.x * cos + this.y * sin, -this.x * sin + this.y * cos);
  }

  /** Both coordinates are finite. */
  isFinite(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y);
  }

  /** `self + o` */
  add(o: P): P {
    return new P(this.x + o.x, this.y + o.y);
  }

  /** `self - o` */
  sub(o: P): P {
    return new P(this.x - o.x, this.y - o.y);
  }

  /** `self * s` */
  mul(s: number): P {
    return new P(this.x * s, this.y * s);
  }

  /** `-self` */
  neg(): P {
    return new P(-this.x, -this.y);
  }

  /** `self == o` (float equality per coordinate: `-0 == 0`, NaN never equal). */
  eq(o: P): boolean {
    return this.x === o.x && this.y === o.y;
  }
}

/** Axis-aligned rectangle `[x0, x1] × [y0, y1]` (immutable). */
export class Rect {
  /** Left edge. */
  readonly x0: number;
  /** Top edge. */
  readonly y0: number;
  /** Right edge. */
  readonly x1: number;
  /** Bottom edge. */
  readonly y1: number;

  constructor(x0: number, y0: number, x1: number, y1: number) {
    this.x0 = x0;
    this.y0 = y0;
    this.x1 = x1;
    this.y1 = y1;
  }

  /** Rectangle from its top-left corner and size. */
  static xywh(x: number, y: number, w: number, h: number): Rect {
    return new Rect(x, y, x + w, y + h);
  }

  /** Rectangle from its center and half sizes. */
  static fromCenter(c: P, hw: number, hh: number): Rect {
    return new Rect(c.x - hw, c.y - hh, c.x + hw, c.y + hh);
  }

  /** An "empty" rectangle for unions. */
  static readonly EMPTY: Rect = new Rect(Infinity, Infinity, -Infinity, -Infinity);

  /** Width `x1 − x0`. */
  w(): number {
    return this.x1 - this.x0;
  }

  /** Height `y1 − y0`. */
  h(): number {
    return this.y1 - this.y0;
  }

  /** Area (0 for inverted rectangles). */
  area(): number {
    return maxf(this.w(), 0) * maxf(this.h(), 0);
  }

  /** Center point. */
  center(): P {
    return new P((this.x0 + this.x1) * 0.5, (this.y0 + this.y1) * 0.5);
  }

  /** Inverted or NaN (`!(x1 >= x0 && y1 >= y0)`). */
  isEmpty(): boolean {
    return !(this.x1 >= this.x0 && this.y1 >= this.y0);
  }

  /** Grown by `d` on every side (shrunk for negative `d`). */
  inflate(d: number): Rect {
    return new Rect(this.x0 - d, this.y0 - d, this.x1 + d, this.y1 + d);
  }

  /** Moved by `d`. */
  translate(d: P): Rect {
    return new Rect(this.x0 + d.x, this.y0 + d.y, this.x1 + d.x, this.y1 + d.y);
  }

  /** Bounding box of both. */
  union(o: Rect): Rect {
    return new Rect(minf(this.x0, o.x0), minf(this.y0, o.y0), maxf(this.x1, o.x1), maxf(this.y1, o.y1));
  }

  /** Bounding box of `self` and `p`. */
  addPoint(p: P): Rect {
    return new Rect(minf(this.x0, p.x), minf(this.y0, p.y), maxf(this.x1, p.x), maxf(this.y1, p.y));
  }

  /** Interiors overlap by more than `EPS` in both axes. */
  overlaps(o: Rect): boolean {
    return this.x0 < o.x1 - EPS && o.x0 < this.x1 - EPS && this.y0 < o.y1 - EPS && o.y0 < this.y1 - EPS;
  }

  /** Closed rectangles intersect (touching counts). */
  touches(o: Rect): boolean {
    return this.x0 <= o.x1 && o.x0 <= this.x1 && this.y0 <= o.y1 && o.y0 <= this.y1;
  }

  /** Intersection (inverted when disjoint). */
  intersection(o: Rect): Rect {
    return new Rect(maxf(this.x0, o.x0), maxf(this.y0, o.y0), minf(this.x1, o.x1), minf(this.y1, o.y1));
  }

  /** Area of the intersection (0 when disjoint). */
  overlapArea(o: Rect): number {
    const w = minf(this.x1, o.x1) - maxf(this.x0, o.x0);
    const h = minf(this.y1, o.y1) - maxf(this.y0, o.y0);
    return w > 0 && h > 0 ? w * h : 0;
  }

  /** `p` lies in the closed rectangle. */
  containsPoint(p: P): boolean {
    return p.x >= this.x0 && p.x <= this.x1 && p.y >= this.y0 && p.y <= this.y1;
  }

  /** `o` lies inside `self` (with tolerance `EPS`). */
  containsRect(o: Rect): boolean {
    return o.x0 >= this.x0 - EPS && o.x1 <= this.x1 + EPS && o.y0 >= this.y0 - EPS && o.y1 <= this.y1 + EPS;
  }

  /** Distance from a point to the rectangle (0 inside). */
  distPoint(p: P): number {
    return rectDistPointXY(this.x0, this.y0, this.x1, this.y1, p.x, p.y);
  }

  /** Closest point of the (closed) rectangle to `p`. */
  closestPoint(p: P): P {
    return new P(clampf(p.x, this.x0, this.x1), clampf(p.y, this.y0, this.y1));
  }

  /** Gap between two rectangles (0 if they touch or overlap). */
  distRect(o: Rect): number {
    const dx = maxf(maxf(o.x0 - this.x1, this.x0 - o.x1), 0);
    const dy = maxf(maxf(o.y0 - this.y1, this.y0 - o.y1), 0);
    return len2d(dx, dy);
  }

  /** Corners in order top-left, top-right, bottom-right, bottom-left. */
  corners(): [P, P, P, P] {
    return [new P(this.x0, this.y0), new P(this.x1, this.y0), new P(this.x1, this.y1), new P(this.x0, this.y1)];
  }

  /** `self == o` (float equality per field). */
  eq(o: Rect): boolean {
    return this.x0 === o.x0 && this.y0 === o.y0 && this.x1 === o.x1 && this.y1 === o.y1;
  }
}

/** `Rect.distPoint` on scalars. */
export function rectDistPointXY(x0: number, y0: number, x1: number, y1: number, px: number, py: number): number {
  const dx = maxf(maxf(x0 - px, 0), px - x1);
  const dy = maxf(maxf(y0 - py, 0), py - y1);
  return len2d(dx, dy);
}

/** The six coefficients `[a, b, c, d, e, f]` of an {@link Affine}. */
export type AffineCoeffs = readonly [number, number, number, number, number, number];

/** Affine map `[a, b, c, d, e, f]`: `x' = a·x + c·y + e`, `y' = b·x + d·y + f`. */
export class Affine {
  /** The coefficients (Rust: the tuple field `.0`). */
  readonly m: AffineCoeffs;

  constructor(m: AffineCoeffs) {
    this.m = m;
  }

  /** The identity map. */
  static readonly IDENTITY: Affine = new Affine([1, 0, 0, 1, 0, 0]);

  /** Image of `p`. */
  apply(p: P): P {
    const m = this.m;
    return new P(m[0] * p.x + m[2] * p.y + m[4], m[1] * p.x + m[3] * p.y + m[5]);
  }

  /** `self ∘ other` (apply `self` first, then `after`). */
  then(after: Affine): Affine {
    const a = this.m;
    const b = after.m;
    return new Affine([
      b[0] * a[0] + b[2] * a[1],
      b[1] * a[0] + b[3] * a[1],
      b[0] * a[2] + b[2] * a[3],
      b[1] * a[2] + b[3] * a[3],
      b[0] * a[4] + b[2] * a[5] + b[4],
      b[1] * a[4] + b[3] * a[5] + b[5],
    ]);
  }

  /** Equal to {@link Affine.IDENTITY}. */
  isIdentity(): boolean {
    return this.eq(Affine.IDENTITY);
  }

  /** `self == o` (float equality per coefficient). */
  eq(o: Affine): boolean {
    for (let i = 0; i < 6; i++) if (this.m[i] !== o.m[i]) return false;
    return true;
  }
}

// ---------------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------------

/** Orientation of the triangle (a, b, c): > 0 counter-clockwise in math orientation. */
export function orient(a: P, b: P, c: P): number {
  return orientXY(a.x, a.y, b.x, b.y, c.x, c.y);
}

/** {@link orient} on scalars: `(b - a).cross(c - a)`. */
export function orientXY(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** Distance from point `p` to segment `ab`. */
export function distPointSeg(p: P, a: P, b: P): number {
  return distPointSegXY(p.x, p.y, a.x, a.y, b.x, b.y);
}

/** {@link distPointSeg} on scalars. */
export function distPointSegXY(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const l2 = abx * abx + aby * aby;
  if (l2 <= 0) return len2d(px - ax, py - ay);
  const t = clampf(((px - ax) * abx + (py - ay) * aby) / l2, 0, 1);
  return len2d(px - (ax + abx * t), py - (ay + aby * t));
}

/** Closest point on segment `ab` to `p`. */
export function closestOnSeg(p: P, a: P, b: P): P {
  const ab = b.sub(a);
  const l2 = ab.len2();
  if (l2 <= 0) return a;
  const t = clampf(p.sub(a).dot(ab) / l2, 0, 1);
  return a.add(ab.mul(t));
}

/** Segments `ab` and `cd` intersect (including touching), with tolerance `EPS`. */
export function segIntersects(a: P, b: P, c: P, d: P): boolean {
  return segSegDist(a, b, c, d) <= EPS;
}

/** Segments cross properly: they intersect in a point that is interior to both. */
export function segCrossProper(a: P, b: P, c: P, d: P): boolean {
  return segCrossProperXY(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
}

/** {@link segCrossProper} on scalars. */
export function segCrossProperXY(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = orientXY(cx, cy, dx, dy, ax, ay);
  const d2 = orientXY(cx, cy, dx, dy, bx, by);
  const d3 = orientXY(ax, ay, bx, by, cx, cy);
  const d4 = orientXY(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Minimum distance between segments `ab` and `cd` (0 if they intersect). */
export function segSegDist(a: P, b: P, c: P, d: P): number {
  return segSegDistXY(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
}

/** {@link segSegDist} on scalars. */
export function segSegDistXY(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  if (segCrossProperXY(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  let m = distPointSegXY(ax, ay, cx, cy, dx, dy);
  m = minf(m, distPointSegXY(bx, by, cx, cy, dx, dy));
  m = minf(m, distPointSegXY(cx, cy, ax, ay, bx, by));
  return minf(m, distPointSegXY(dx, dy, ax, ay, bx, by));
}

/** Length of the part of segment `ab` inside the closed rectangle `r` (Liang–Barsky). */
export function segLenInRect(a: P, b: P, r: Rect): number {
  if (!clipSegRectXY(a.x, a.y, b.x, b.y, r.x0, r.y0, r.x1, r.y1)) return 0;
  return (CLIP[1]! - CLIP[0]!) * a.dist(b);
}

/**
 * Output of {@link clipSegRectXY}: the parameter interval `[CLIP[0], CLIP[1]]` of the
 * last successful clip (overwritten by the next call).
 */
export const CLIP = new Float64Array(2);

/** Liang–Barsky clipping: the parameter interval `[t0, t1]` of `ab` inside `r`. */
export function clipSegRect(a: P, b: P, r: Rect): [number, number] | null {
  if (!clipSegRectXY(a.x, a.y, b.x, b.y, r.x0, r.y0, r.x1, r.y1)) return null;
  return [CLIP[0]!, CLIP[1]!];
}

/**
 * {@link clipSegRect} on scalars (rectangle `[x0, x1] × [y0, y1]`): true when the
 * segment meets the rectangle, with the interval in {@link CLIP}.
 */
export function clipSegRectXY(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  for (let k = 0; k < 4; k++) {
    let p: number;
    let q: number;
    if (k === 0) {
      p = -dx;
      q = ax - x0;
    } else if (k === 1) {
      p = dx;
      q = x1 - ax;
    } else if (k === 2) {
      p = -dy;
      q = ay - y0;
    } else {
      p = dy;
      q = y1 - ay;
    }
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  if (t1 >= t0) {
    CLIP[0] = t0;
    CLIP[1] = t1;
    return true;
  }
  return false;
}

/** Segment `ab` passes through the interior of `r` (shrunk by `EPS`). */
export function segOverlapsRect(a: P, b: P, r: Rect): boolean {
  return segOverlapsRectXY(a.x, a.y, b.x, b.y, r.x0, r.y0, r.x1, r.y1);
}

/** {@link segOverlapsRect} on scalars (rectangle `[x0, x1] × [y0, y1]`). */
export function segOverlapsRectXY(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  // inner = r.inflate(-EPS)
  const d = -EPS;
  const ix0 = x0 - d;
  const iy0 = y0 - d;
  const ix1 = x1 + d;
  const iy1 = y1 + d;
  if (!(ix1 >= ix0 && iy1 >= iy0)) return false;
  if (!clipSegRectXY(ax, ay, bx, by, ix0, iy0, ix1, iy1)) return false;
  const t0 = CLIP[0]!;
  const t1 = CLIP[1]!;
  if ((t1 - t0) * len2d(ax - bx, ay - by) > EPS) return true;
  // inner.contains_point(a.lerp(b, (t0 + t1) * 0.5))
  const t = (t0 + t1) * 0.5;
  const mx = ax + (bx - ax) * t;
  const my = ay + (by - ay) * t;
  return mx >= ix0 && mx <= ix1 && my >= iy0 && my <= iy1;
}

/** Distance between segment `ab` and rectangle `r` (0 if they touch or intersect). */
export function distSegRect(a: P, b: P, r: Rect): number {
  return distSegRectXY(a.x, a.y, b.x, b.y, r.x0, r.y0, r.x1, r.y1);
}

/** {@link distSegRect} on scalars (rectangle `[x0, x1] × [y0, y1]`). */
export function distSegRectXY(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  if (clipSegRectXY(ax, ay, bx, by, x0, y0, x1, y1)) return 0;
  // corners top-left, top-right, bottom-right, bottom-left; edges i → i + 1 (a loop with
  // one call site, which the JIT can inline)
  let m = Infinity;
  for (let i = 0; i < 4; i++) {
    m = minf(m, segSegDistXY(ax, ay, bx, by, cornerX(i, x0, x1), cornerY(i, y0, y1), cornerX(i + 1, x0, x1), cornerY(i + 1, y0, y1)));
  }
  return m;
}

/** x of corner `i % 4` of a rectangle (top-left, top-right, bottom-right, bottom-left). */
export function cornerX(i: number, x0: number, x1: number): number {
  const k = i & 3;
  return k === 0 || k === 3 ? x0 : x1;
}

/** y of corner `i % 4` of a rectangle (top-left, top-right, bottom-right, bottom-left). */
export function cornerY(i: number, y0: number, y1: number): number {
  return (i & 3) < 2 ? y0 : y1;
}

/** Bounding box of a point list. */
export function bboxOf(points: readonly P[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    x0 = minf(x0, p.x);
    y0 = minf(y0, p.y);
    x1 = maxf(x1, p.x);
    y1 = maxf(y1, p.y);
  }
  return new Rect(x0, y0, x1, y1);
}
