// Flattening of path segments and basic shapes into polylines in canvas pixels.
// Mirrors flatten.rs (same formulas and operation order): Béziers by Wang's formula on the
// transformed control points, arcs/ellipses by the sagitta formula on the largest singular
// value of CTM · R(φ) · diag(rx, ry); all sample points lie on the exact curve.

import { type Affine, apply, maxScale } from "./geom.js";
import type { Seg } from "./path.js";
import type { Point } from "./types.js";

export const MAX_CURVE_SEGMENTS = 4096;
const TAU = 2 * Math.PI;
const HALF_PI = Math.PI / 2;

/** A flattened subpath (≥ 2 distinct points; closed subpaths do not repeat the first point). */
export interface Subpath {
  pts: Point[];
  closed: boolean;
}

/** Segments of a sweep (radians) on a circle of radius `r` (canvas px). */
export function arcSegments(r: number, sweep: number, tol: number): number {
  const sw = Math.abs(sweep);
  if (!(r > 0) || !Number.isFinite(sw) || sw === 0) return 1;
  const x = 1 - tol / r;
  const step = x <= -1 ? TAU : 2 * Math.acos(x);
  let n = Math.ceil(sw / step);
  const minN = Math.ceil(sw / HALF_PI);
  if (!(n >= minN)) n = minN;
  if (n < 1) return 1;
  if (n > MAX_CURVE_SEGMENTS) return MAX_CURVE_SEGMENTS;
  return n;
}

function bezierSegments(m: number, k: number, tol: number): number {
  const n = Math.ceil(Math.sqrt((k * m) / tol));
  if (!(n >= 1)) return 1;
  if (n > MAX_CURVE_SEGMENTS) return MAX_CURVE_SEGMENTS;
  return n;
}

function hyp2(x: number, y: number): number {
  return x * x + y * y;
}

export class Flattener {
  private out: Subpath[] = [];
  private cur: Point[] = [];
  private sx = 0;
  private sy = 0;
  private px = 0;
  private py = 0;
  finite = true;

  constructor(
    private readonly ctm: Affine,
    private readonly tol: number,
  ) {}

  push(p: Point): void {
    if (!(Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
      this.finite = false;
      return;
    }
    const n = this.cur.length;
    if (n > 0) {
      const last = this.cur[n - 1]!;
      if (last[0] === p[0] && last[1] === p[1]) return;
    }
    this.cur.push(p);
  }

  private finish(closed: boolean): void {
    const pts = this.cur;
    this.cur = [];
    if (closed && pts.length > 1) {
      const f = pts[0]!;
      const l = pts[pts.length - 1]!;
      if (f[0] === l[0] && f[1] === l[1]) pts.pop();
    }
    if (pts.length >= 2) this.out.push({ pts, closed });
  }

  private ensureStarted(): void {
    if (this.cur.length === 0) this.push(apply(this.ctm, this.px, this.py));
  }

  moveTo(x: number, y: number): void {
    this.finish(false);
    this.sx = x;
    this.sy = y;
    this.px = x;
    this.py = y;
    this.push(apply(this.ctm, x, y));
  }

  lineTo(x: number, y: number): void {
    this.ensureStarted();
    this.push(apply(this.ctm, x, y));
    this.px = x;
    this.py = y;
  }

  quadTo(x1: number, y1: number, x: number, y: number): void {
    this.ensureStarted();
    const p0 = apply(this.ctm, this.px, this.py);
    const p1 = apply(this.ctm, x1, y1);
    const p2 = apply(this.ctm, x, y);
    const m = Math.sqrt(hyp2(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]));
    const n = bezierSegments(m, 0.25, this.tol);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const mt = 1 - t;
      const a = mt * mt;
      const b = 2 * mt * t;
      const c = t * t;
      this.push([a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]]);
    }
    this.push(p2);
    this.px = x;
    this.py = y;
  }

  cubicTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    this.ensureStarted();
    const p0 = apply(this.ctm, this.px, this.py);
    const p1 = apply(this.ctm, x1, y1);
    const p2 = apply(this.ctm, x2, y2);
    const p3 = apply(this.ctm, x, y);
    const d1 = hyp2(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]);
    const d2 = hyp2(p1[0] - 2 * p2[0] + p3[0], p1[1] - 2 * p2[1] + p3[1]);
    const m = Math.sqrt(d1 > d2 ? d1 : d2);
    const n = bezierSegments(m, 0.75, this.tol);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const mt = 1 - t;
      const a = mt * mt * mt;
      const b = 3 * mt * mt * t;
      const c = 3 * mt * t * t;
      const d = t * t * t;
      this.push([
        a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
        a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
      ]);
    }
    this.push(p3);
    this.px = x;
    this.py = y;
  }

  /** SVG elliptical arc (implementation notes F.6.5/F.6.6), sampled on the exact ellipse. */
  arcTo(rx0: number, ry0: number, rot: number, large: boolean, sweep: boolean, x: number, y: number): void {
    const x0 = this.px;
    const y0 = this.py;
    if (x0 === x && y0 === y) return;
    let rx = Math.abs(rx0);
    let ry = Math.abs(ry0);
    if (rx === 0 || ry === 0) {
      this.lineTo(x, y);
      return;
    }
    this.ensureStarted();
    const phi = (rot * Math.PI) / 180;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const dx2 = (x0 - x) / 2;
    const dy2 = (y0 - y) / 2;
    const x1p = cosPhi * dx2 + sinPhi * dy2;
    const y1p = -sinPhi * dx2 + cosPhi * dy2;
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    let coef = 0;
    if (lambda > 1) {
      // Radii scaled up: the ellipse just fits, its center is the chord midpoint
      // (computing it would cancel catastrophically).
      const s = Math.sqrt(lambda);
      rx *= s;
      ry *= s;
    } else {
      const rx2 = rx * rx;
      const ry2 = ry * ry;
      const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
      const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
      if (den > 0 && num > 0) coef = Math.sqrt(num / den);
    }
    if (large === sweep) coef = -coef;
    const cxp = coef * ((rx * y1p) / ry);
    const cyp = coef * -((ry * x1p) / rx);
    const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
    const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;
    const ux = (x1p - cxp) / rx;
    const uy = (y1p - cyp) / ry;
    const vx = (-x1p - cxp) / rx;
    const vy = (-y1p - cyp) / ry;
    const theta1 = Math.atan2(uy, ux);
    let dtheta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    if (!sweep && dtheta > 0) dtheta -= TAU;
    else if (sweep && dtheta < 0) dtheta += TAU;
    const r = maxScale(this.ctm, cosPhi * rx, -sinPhi * ry, sinPhi * rx, cosPhi * ry);
    const n = arcSegments(r, dtheta, this.tol);
    for (let k = 1; k < n; k++) {
      const t = theta1 + (dtheta * k) / n;
      const st = Math.sin(t);
      const ct = Math.cos(t);
      const px = cx + rx * ct * cosPhi - ry * st * sinPhi;
      const py = cy + rx * ct * sinPhi + ry * st * cosPhi;
      this.push(apply(this.ctm, px, py));
    }
    this.push(apply(this.ctm, x, y));
    this.px = x;
    this.py = y;
  }

  close(): void {
    if (this.cur.length > 0) this.finish(true);
    this.px = this.sx;
    this.py = this.sy;
  }

  run(segs: readonly Seg[]): void {
    for (const s of segs) {
      switch (s.k) {
        case "M":
          this.moveTo(s.x, s.y);
          break;
        case "L":
          this.lineTo(s.x, s.y);
          break;
        case "Q":
          this.quadTo(s.x1, s.y1, s.x, s.y);
          break;
        case "C":
          this.cubicTo(s.x1, s.y1, s.x2, s.y2, s.x, s.y);
          break;
        case "A":
          this.arcTo(s.rx, s.ry, s.rot, s.large, s.sweep, s.x, s.y);
          break;
        case "Z":
          this.close();
          break;
      }
    }
  }

  /** Quarter ellipse arc from angle `t0` (center `c`, radii `rx`, `ry`), ending exactly at `end`. */
  corner(cx: number, cy: number, rx: number, ry: number, t0: number, ex: number, ey: number): void {
    const r = maxScale(this.ctm, rx, 0, 0, ry);
    const n = arcSegments(r, HALF_PI, this.tol);
    for (let k = 1; k < n; k++) {
      const t = t0 + (HALF_PI * k) / n;
      this.push(apply(this.ctm, cx + rx * Math.cos(t), cy + ry * Math.sin(t)));
    }
    this.push(apply(this.ctm, ex, ey));
    this.px = ex;
    this.py = ey;
  }

  finishAll(): Subpath[] | null {
    this.finish(false);
    return this.finite ? this.out : null;
  }
}

/** Rectangle with optional rounded corners (rx, ry already clamped). */
export function rect(
  ctm: Affine,
  tol: number,
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number,
  ry: number,
): Subpath[] | null {
  const f = new Flattener(ctm, tol);
  if (rx > 0 && ry > 0) {
    f.moveTo(x + rx, y);
    f.lineTo(x + w - rx, y);
    f.corner(x + w - rx, y + ry, rx, ry, -HALF_PI, x + w, y + ry);
    f.lineTo(x + w, y + h - ry);
    f.corner(x + w - rx, y + h - ry, rx, ry, 0, x + w - rx, y + h);
    f.lineTo(x + rx, y + h);
    f.corner(x + rx, y + h - ry, rx, ry, HALF_PI, x, y + h - ry);
    f.lineTo(x, y + ry);
    f.corner(x + rx, y + ry, rx, ry, Math.PI, x + rx, y);
  } else {
    f.moveTo(x, y);
    f.lineTo(x + w, y);
    f.lineTo(x + w, y + h);
    f.lineTo(x, y + h);
  }
  f.close();
  return f.finishAll();
}

/** Full ellipse starting at angle 0, clockwise on screen. */
export function ellipse(ctm: Affine, tol: number, cx: number, cy: number, rx: number, ry: number): Subpath[] | null {
  const r = maxScale(ctm, rx, 0, 0, ry);
  const n = arcSegments(r, TAU, tol);
  const f = new Flattener(ctm, tol);
  f.moveTo(cx + rx, cy);
  for (let k = 1; k < n; k++) {
    const t = (TAU * k) / n;
    f.push(apply(ctm, cx + rx * Math.cos(t), cy + ry * Math.sin(t)));
  }
  f.close();
  return f.finishAll();
}

/** Polyline / polygon from a flat coordinate list (an odd trailing value is ignored). */
export function poly(ctm: Affine, tol: number, coords: readonly number[], closed: boolean): Subpath[] | null {
  const f = new Flattener(ctm, tol);
  for (let k = 0; k + 1 < coords.length; k += 2) {
    if (k === 0) f.moveTo(coords[0]!, coords[1]!);
    else f.lineTo(coords[k]!, coords[k + 1]!);
  }
  if (closed) f.close();
  return f.finishAll();
}

/** Path data. */
export function path(ctm: Affine, tol: number, segs: readonly Seg[]): Subpath[] | null {
  const f = new Flattener(ctm, tol);
  f.run(segs);
  return f.finishAll();
}
