/**
 * Polygon utilities: area, containment, hull, distances, intersection tests, polylabel
 * (port of `rust/crates/la-core/src/geom/polygon.rs`).
 *
 * A polygon is a list of rings (`P[][]`); rings are implicitly closed. With the non-zero
 * rule the first ring is usually the outer boundary and the rest are holes (their
 * orientation does not matter for even-odd).
 *
 * @module
 */

import { cmpF64, maxf, minf } from "../math.js";
import {
  EPS,
  P,
  Rect,
  bboxOf,
  cornerX,
  cornerY,
  distPointSegXY,
  orientXY,
  segCrossProperXY,
  segOverlapsRectXY,
  segSegDistXY,
} from "./index.js";

/** A ring: implicitly closed list of vertices. */
export type Ring = readonly P[];

/**
 * Signed area (shoelace), positive for counter-clockwise rings in math orientation
 * (clockwise on screen with y down).
 */
export function signedArea(ring: Ring): number {
  const n = ring.length;
  if (n < 3) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s * 0.5;
}

/** Winding number of `p` with respect to one ring. */
export function winding(ring: Ring, p: P): number {
  return windingXY(ring, p.x, p.y);
}

function windingXY(ring: Ring, px: number, py: number): number {
  const n = ring.length;
  let w = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    if (a.y <= py) {
      if (b.y > py && orientXY(a.x, a.y, b.x, b.y, px, py) > 0) w += 1;
    } else if (b.y <= py && orientXY(a.x, a.y, b.x, b.y, px, py) < 0) {
      w -= 1;
    }
  }
  return w;
}

/** Point-in-polygon for multi-ring polygons with the non-zero or even-odd rule. */
export function contains(rings: readonly Ring[], evenOdd: boolean, p: P): boolean {
  return containsXY(rings, evenOdd, p.x, p.y);
}

/** {@link contains} on scalars. */
export function containsXY(rings: readonly Ring[], evenOdd: boolean, px: number, py: number): boolean {
  if (evenOdd) {
    let inside = false;
    for (let k = 0; k < rings.length; k++) {
      const r = rings[k]!;
      const n = r.length;
      for (let i = 0; i < n; i++) {
        const a = r[i]!;
        const b = r[(i + 1) % n]!;
        if (a.y > py !== b.y > py) {
          const x = a.x + ((py - a.y) / (b.y - a.y)) * (b.x - a.x);
          if (px < x) inside = !inside;
        }
      }
    }
    return inside;
  }
  let w = 0;
  for (let k = 0; k < rings.length; k++) w += windingXY(rings[k]!, px, py);
  return w !== 0;
}

/** Distance from `p` to the polygon boundary (unsigned). */
export function distBoundary(rings: readonly Ring[], p: P): number {
  return distBoundaryXY(rings, p.x, p.y);
}

/** {@link distBoundary} on scalars. */
export function distBoundaryXY(rings: readonly Ring[], px: number, py: number): number {
  let m = Infinity;
  for (let k = 0; k < rings.length; k++) {
    const r = rings[k]!;
    const n = r.length;
    for (let i = 0; i < n; i++) {
      const a = r[i]!;
      const b = r[(i + 1) % n]!;
      m = minf(m, distPointSegXY(px, py, a.x, a.y, b.x, b.y));
    }
  }
  return m;
}

function cmpPoints(a: P, b: P): number {
  return cmpF64(a.x, b.x) || cmpF64(a.y, b.y);
}

function orientP(a: P, b: P, c: P): number {
  return orientXY(a.x, a.y, b.x, b.y, c.x, c.y);
}

/**
 * Convex hull (Andrew's monotone chain). Returns vertices counter-clockwise in math
 * orientation, without collinear points. Deterministic for identical input.
 */
export function convexHull(points: readonly P[]): P[] {
  const all: P[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (p.isFinite()) all.push(p);
  }
  all.sort(cmpPoints); // stable, like Rust's sort_by
  // dedup: drop consecutive equal points
  const pts: P[] = [];
  for (let i = 0; i < all.length; i++) {
    const p = all[i]!;
    if (pts.length === 0 || !pts[pts.length - 1]!.eq(p)) pts.push(p);
  }
  if (pts.length < 3) return pts;
  const lower: P[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    while (lower.length >= 2 && orientP(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: P[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && orientP(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  for (let i = 0; i < upper.length; i++) lower.push(upper[i]!);
  return lower;
}

/** All edges of a multi-ring polygon as segment pairs `[r[i], r[(i + 1) % n]]`. */
export function* edges(rings: readonly Ring[]): Generator<[P, P]> {
  for (const r of rings) {
    const n = r.length;
    for (let i = 0; i < n; i++) yield [r[i]!, r[(i + 1) % n]!];
  }
}

/** The open rectangle `r` intersects the polygon's interior (overlap > `EPS`). */
export function overlapsRect(rings: readonly Ring[], evenOdd: boolean, bbox: Rect, r: Rect): boolean {
  if (!bbox.overlaps(r)) return false;
  // inner = r.inflate(-EPS)
  const d = -EPS;
  const ix0 = r.x0 - d;
  const iy0 = r.y0 - d;
  const ix1 = r.x1 + d;
  const iy1 = r.y1 + d;
  if (!(ix1 >= ix0 && iy1 >= iy0)) return false;
  // 1. A polygon edge passes through the rectangle interior.
  for (let k = 0; k < rings.length; k++) {
    const ring = rings[k]!;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % n]!;
      if (segOverlapsRectXY(a.x, a.y, b.x, b.y, ix0, iy0, ix1, iy1)) return true;
    }
  }
  // 2. No edge enters the rectangle: either the rectangle is inside the polygon or
  //    disjoint (or the polygon is inside the rectangle).
  if (containsXY(rings, evenOdd, (ix0 + ix1) * 0.5, (iy0 + iy1) * 0.5)) return true;
  // 3. Polygon inside rectangle: any vertex strictly inside.
  for (let k = 0; k < rings.length; k++) {
    const ring = rings[k]!;
    if (ring.length > 0) {
      const v = ring[0]!;
      if (v.x >= ix0 && v.x <= ix1 && v.y >= iy0 && v.y <= iy1) return true;
    }
  }
  return false;
}

/**
 * Rectangle `r` lies completely inside the polygon (with clearance `pad` from the
 * boundary).
 */
export function containsRect(rings: readonly Ring[], evenOdd: boolean, r: Rect, pad: number): boolean {
  // rr = r.inflate(pad); corners top-left, top-right, bottom-right, bottom-left
  const x0 = r.x0 - pad;
  const y0 = r.y0 - pad;
  const x1 = r.x1 + pad;
  const y1 = r.y1 + pad;
  if (!containsXY(rings, evenOdd, x0, y0)) return false;
  if (!containsXY(rings, evenOdd, x1, y0)) return false;
  if (!containsXY(rings, evenOdd, x1, y1)) return false;
  if (!containsXY(rings, evenOdd, x0, y1)) return false;
  for (let k = 0; k < rings.length; k++) {
    const ring = rings[k]!;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % n]!;
      // Any boundary edge entering the rectangle invalidates containment.
      if (segOverlapsRectXY(a.x, a.y, b.x, b.y, x0, y0, x1, y1)) return false;
      for (let c = 0; c < 4; c++) {
        const cx = cornerX(c, x0, x1);
        const cy = cornerY(c, y0, y1);
        if (segCrossProperXY(a.x, a.y, b.x, b.y, cx, cy, cornerX(c + 1, x0, x1), cornerY(c + 1, y0, y1))) return false;
      }
    }
  }
  return true;
}

/** Distance between the polygon (as an area) and a rectangle; 0 if they overlap or touch. */
export function distRect(rings: readonly Ring[], evenOdd: boolean, bbox: Rect, r: Rect): number {
  if (overlapsRect(rings, evenOdd, bbox, r)) return 0;
  const { x0, y0, x1, y1 } = r;
  let m = Infinity;
  for (let k = 0; k < rings.length; k++) {
    const ring = rings[k]!;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % n]!;
      for (let c = 0; c < 4; c++) {
        const cx = cornerX(c, x0, x1);
        const cy = cornerY(c, y0, y1);
        m = minf(m, segSegDistXY(a.x, a.y, b.x, b.y, cx, cy, cornerX(c + 1, x0, x1), cornerY(c + 1, y0, y1)));
      }
    }
  }
  return m;
}

/** A polylabel cell: center, half size, signed distance, potential, sequence number. */
interface Cell {
  c: P;
  h: number;
  d: number;
  max: number;
  seq: number;
}

/** Rust `Cell::cmp`: max-heap on potential; ties: lower sequence number first. */
function cellCmp(a: Cell, b: Cell): number {
  const c = cmpF64(a.max, b.max);
  if (c !== 0) return c;
  return b.seq < a.seq ? -1 : b.seq > a.seq ? 1 : 0;
}

/** Binary max-heap of cells under {@link cellCmp} (pop order equals Rust's `BinaryHeap`). */
class CellHeap {
  private readonly a: Cell[] = [];

  push(c: Cell): void {
    const a = this.a;
    let i = a.length;
    a.push(c);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cellCmp(a[i]!, a[p]!) <= 0) break;
      const t = a[i]!;
      a[i] = a[p]!;
      a[p] = t;
      i = p;
    }
  }

  pop(): Cell | null {
    const a = this.a;
    if (a.length === 0) return null;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < n && cellCmp(a[l]!, a[m]!) > 0) m = l;
        if (r < n && cellCmp(a[r]!, a[m]!) > 0) m = r;
        if (m === i) break;
        const t = a[i]!;
        a[i] = a[m]!;
        a[m] = t;
        i = m;
      }
    }
    return top;
  }
}

/**
 * Polylabel: the pole of inaccessibility (point inside the polygon farthest from its
 * boundary), with the given precision. Returns the point and its distance.
 *
 * Deterministic: the queue is ordered by (potential, insertion index).
 */
export function polylabel(rings: readonly Ring[], evenOdd: boolean, precision: number): [P, number] {
  const bb = bboxOf(rings.length > 0 ? rings[0]! : []);
  if (bb.isEmpty()) return [new P(0, 0), 0];
  const w = bb.w();
  const h = bb.h();
  const cell = minf(w, h);
  if (cell <= 0) return [bb.center(), 0];
  const sdist = (p: P): number => {
    const d = distBoundaryXY(rings, p.x, p.y);
    return containsXY(rings, evenOdd, p.x, p.y) ? d : -d;
  };
  const sqrt2 = Math.SQRT2;
  const mk = (c: P, h: number, seq: number): Cell => {
    const d = sdist(c);
    return { c, h, d, max: d + h * sqrt2, seq };
  };
  let seq = 0;
  const queue = new CellHeap();
  const half = cell * 0.5;
  let y = bb.y0;
  while (y < bb.y1) {
    let x = bb.x0;
    while (x < bb.x1) {
      queue.push(mk(new P(x + half, y + half), half, seq));
      seq += 1;
      x += cell;
    }
    y += cell;
  }
  // Initial best: centroid, then bbox center (their sequence number u64::MAX is never
  // compared: they are not queued).
  const centroid = ringCentroid(rings[0]!);
  let best = mk(centroid, 0, Infinity);
  const bc = mk(bb.center(), 0, Infinity);
  if (bc.d > best.d) best = bc;
  let iterations = 0;
  for (let c = queue.pop(); c !== null; c = queue.pop()) {
    iterations += 1;
    if (iterations > 100_000) break;
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precision) continue;
    const h2 = c.h * 0.5;
    for (let k = 0; k < 4; k++) {
      const dx = k === 0 || k === 2 ? -1 : 1;
      const dy = k < 2 ? -1 : 1;
      queue.push(mk(new P(c.c.x + dx * h2, c.c.y + dy * h2), h2, seq));
      seq += 1;
    }
  }
  return [best.c, maxf(best.d, 0)];
}

/** Area centroid of a ring (falls back to the vertex mean for degenerate rings). */
export function ringCentroid(ring: Ring): P {
  const n = ring.length;
  if (n === 0) return new P(0, 0);
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % n]!;
    const f = p.x * q.y - q.x * p.y;
    a += f;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  if (Math.abs(a) < 1e-12) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx = sx + ring[i]!.x;
      sy = sy + ring[i]!.y;
    }
    const k = 1 / n;
    return new P(sx * k, sy * k);
  }
  return new P(cx / (3 * a), cy / (3 * a));
}

/**
 * Total absolute area of a multi-ring polygon under its fill rule, approximated by the
 * signed-area sum for non-zero (outer minus holes when holes are oppositely oriented)
 * and by |outer| − Σ|holes| for even-odd.
 */
export function area(rings: readonly Ring[], evenOdd: boolean): number {
  if (rings.length === 0) return 0;
  if (evenOdd) {
    let a = Math.abs(signedArea(rings[0]!));
    for (let k = 1; k < rings.length; k++) a -= Math.abs(signedArea(rings[k]!));
    return maxf(a, 0);
  }
  let s = 0;
  for (let k = 0; k < rings.length; k++) s += signedArea(rings[k]!);
  return Math.abs(s);
}
