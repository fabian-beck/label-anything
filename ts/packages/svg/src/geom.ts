// Affine matrices and bounding boxes. Mirrors geom.rs (same operation order).

import type { Point } from "./types.js";

/** `x' = a·x + c·y + e`, `y' = b·x + d·y + f` (SVG matrix order). */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function affine(a: number, b: number, c: number, d: number, e: number, f: number): Affine {
  return { a, b, c, d, e, f };
}

export function translate(tx: number, ty: number): Affine {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

export function scale(sx: number, sy: number): Affine {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

export function rotate(deg: number): Affine {
  const r = (deg * Math.PI) / 180;
  const s = Math.sin(r);
  const c = Math.cos(r);
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
}

export function skewX(deg: number): Affine {
  return { a: 1, b: 0, c: Math.tan((deg * Math.PI) / 180), d: 1, e: 0, f: 0 };
}

export function skewY(deg: number): Affine {
  return { a: 1, b: Math.tan((deg * Math.PI) / 180), c: 0, d: 1, e: 0, f: 0 };
}

function isIdentity(m: Affine): boolean {
  return m === IDENTITY || (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0);
}

/** `m · o` (apply `o` first). Multiplication by the identity is skipped (as in Rust). */
export function mul(m: Affine, o: Affine): Affine {
  if (isIdentity(o)) return m;
  if (isIdentity(m)) return o;
  return {
    a: m.a * o.a + m.c * o.b,
    b: m.b * o.a + m.d * o.b,
    c: m.a * o.c + m.c * o.d,
    d: m.b * o.c + m.d * o.d,
    e: m.a * o.e + m.c * o.f + m.e,
    f: m.b * o.e + m.d * o.f + m.f,
  };
}

export function apply(m: Affine, x: number, y: number): Point {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

/** `√|det|`: the mean scale used for stroke widths. */
export function meanScale(m: Affine): number {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
}

/** Largest singular value of `L · M`, `L` = linear part of `m`, `M = [[m00, m01], [m10, m11]]`. */
export function maxScale(m: Affine, m00: number, m01: number, m10: number, m11: number): number {
  const p00 = m.a * m00 + m.c * m10;
  const p01 = m.a * m01 + m.c * m11;
  const p10 = m.b * m00 + m.d * m10;
  const p11 = m.b * m01 + m.d * m11;
  const s = p00 * p00 + p01 * p01 + p10 * p10 + p11 * p11;
  const det = p00 * p11 - p01 * p10;
  const disc = s * s - 4 * det * det;
  const root = disc > 0 ? Math.sqrt(disc) : 0;
  return Math.sqrt((s + root) / 2);
}

/** Axis-aligned bounding box. */
export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function bboxAdd(b: BBox, p: Point): void {
  if (p[0] < b.x0) b.x0 = p[0];
  if (p[0] > b.x1) b.x1 = p[0];
  if (p[1] < b.y0) b.y0 = p[1];
  if (p[1] > b.y1) b.y1 = p[1];
}

/** Grows `a` (in place) to contain `b`. */
export function bboxExtend(a: BBox, b: BBox): void {
  if (b.x0 < a.x0) a.x0 = b.x0;
  if (b.y0 < a.y0) a.y0 = b.y0;
  if (b.x1 > a.x1) a.x1 = b.x1;
  if (b.y1 > a.y1) a.y1 = b.y1;
}

export function bboxUnion(a: BBox | null, b: BBox | null): BBox | null {
  if (a === null) return b;
  if (b === null) return a;
  return {
    x0: b.x0 < a.x0 ? b.x0 : a.x0,
    y0: b.y0 < a.y0 ? b.y0 : a.y0,
    x1: b.x1 > a.x1 ? b.x1 : a.x1,
    y1: b.y1 > a.y1 ? b.y1 : a.y1,
  };
}

export function bboxOfPoints(pts: readonly Point[]): BBox | null {
  if (pts.length === 0) return null;
  const p0 = pts[0]!;
  const b: BBox = { x0: p0[0], y0: p0[1], x1: p0[0], y1: p0[1] };
  for (let i = 1; i < pts.length; i++) bboxAdd(b, pts[i]!);
  return b;
}
