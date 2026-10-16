/**
 * Own vector rasterizer (spec §4.2): 4 × 4 supersampling per cell into sample bit masks,
 * union by OR, plus conservative "touch" marking along boundaries (port of
 * `rust/crates/la-core/src/grid/raster.rs`).
 *
 * Sample `(sx, sy)` of cell `(col, row)` sits at
 * `(ox + (4·col + sx + 0.5)·c/4, oy + (4·row + sy + 0.5)·c/4)` and maps to bit `4·sy + sx`.
 * Bit 16 marks a cell touched by geometry.
 *
 * Primitives do not allocate: the polygon fill keeps its edge and crossing lists in
 * module-level typed arrays that grow on demand.
 *
 * @module
 */

import { cmpF64, len2d, maxf, minf, toIndex } from "../math.js";
import type { P } from "../geom/index.js";
import type { Shape } from "../geom/shape.js";
import { GridSpec, quantize } from "./index.js";

const TOUCH = 1 << 16;

/** {@link MaskRaster.touchSegment} clips segments to the grid grown by this many cells. */
export const TOUCH_MARGIN = 2;

/** Segment `[u0, v0, u1, v1]` in cell units being clipped by {@link clipSlab}. */
const SEG = new Float64Array(4);

/**
 * Clip the segment in {@link SEG} to the slab `lo <= c <= hi` of the coordinate at index
 * `c` (`c + 2` for the second endpoint; the other coordinate at `o`, `o + 2`); false
 * when it lies outside. A clipped endpoint gets `c` exactly on the bound and `o`
 * interpolated from the unclipped endpoints. Endpoints inside the slab are unchanged.
 */
function clipSlab(c: number, o: number, lo: number, hi: number): boolean {
  const a0 = SEG[c]!;
  const b0 = SEG[o]!;
  const a1 = SEG[c + 2]!;
  const b1 = SEG[o + 2]!;
  if ((a0 < lo && a1 < lo) || (a0 > hi && a1 > hi)) return false;
  if (a0 < lo) {
    SEG[o] = b0 + (b1 - b0) * ((lo - a0) / (a1 - a0));
    SEG[c] = lo;
  } else if (a0 > hi) {
    SEG[o] = b0 + (b1 - b0) * ((hi - a0) / (a1 - a0));
    SEG[c] = hi;
  }
  if (a1 < lo) {
    SEG[o + 2] = b1 + (b0 - b1) * ((lo - a1) / (a0 - a1));
    SEG[c + 2] = lo;
  } else if (a1 > hi) {
    SEG[o + 2] = b1 + (b0 - b1) * ((hi - a1) / (a0 - a1));
    SEG[c + 2] = hi;
  }
  return true;
}

// Polygon fill scratch: edges in input order (E_*), sorted by ymin (S_*), the active edge
// list and the crossings of one sample row (XS_*), with merge-sort buffers.
let cap = 0;
let E_YMIN: Float64Array = new Float64Array(0);
let E_YMAX: Float64Array = new Float64Array(0);
let E_X: Float64Array = new Float64Array(0);
let E_SLOPE: Float64Array = new Float64Array(0);
let E_DIR: Int8Array = new Int8Array(0);
let S_YMIN: Float64Array = new Float64Array(0);
let S_YMAX: Float64Array = new Float64Array(0);
let S_X: Float64Array = new Float64Array(0);
let S_SLOPE: Float64Array = new Float64Array(0);
let S_DIR: Int8Array = new Int8Array(0);
let ORD: Int32Array = new Int32Array(0);
let ORD_TMP: Int32Array = new Int32Array(0);
let ACTIVE: Int32Array = new Int32Array(0);
let XS_X: Float64Array = new Float64Array(0);
let XS_D: Int8Array = new Int8Array(0);
let XS_X2: Float64Array = new Float64Array(0);
let XS_D2: Int8Array = new Int8Array(0);

function growFloat(a: Float64Array, n: number): Float64Array {
  const b = new Float64Array(n);
  b.set(a);
  return b;
}

function growInt8(a: Int8Array, n: number): Int8Array {
  const b = new Int8Array(n);
  b.set(a);
  return b;
}

/** Make room for `n` edges (keeping the edges stored so far). */
function ensureEdges(n: number): void {
  if (n <= cap) return;
  const c = n > 2 * cap ? n : 2 * cap;
  E_YMIN = growFloat(E_YMIN, c);
  E_YMAX = growFloat(E_YMAX, c);
  E_X = growFloat(E_X, c);
  E_SLOPE = growFloat(E_SLOPE, c);
  E_DIR = growInt8(E_DIR, c);
  S_YMIN = new Float64Array(c);
  S_YMAX = new Float64Array(c);
  S_X = new Float64Array(c);
  S_SLOPE = new Float64Array(c);
  S_DIR = new Int8Array(c);
  ORD = new Int32Array(c);
  ORD_TMP = new Int32Array(c);
  ACTIVE = new Int32Array(c);
  XS_X = new Float64Array(c);
  XS_D = new Int8Array(c);
  XS_X2 = new Float64Array(c);
  XS_D2 = new Int8Array(c);
  cap = c;
}

/** Stable sort of the edge indices `ORD[0..n]` by `E_YMIN` (Rust: `sort_by(cmp_f64)`). */
function sortEdges(n: number): void {
  for (let i = 0; i < n; i++) ORD[i] = i;
  if (n <= 32) {
    for (let i = 1; i < n; i++) {
      const e = ORD[i]!;
      const key = E_YMIN[e]!;
      let k = i - 1;
      while (k >= 0 && cmpF64(E_YMIN[ORD[k]!]!, key) > 0) {
        ORD[k + 1] = ORD[k]!;
        k -= 1;
      }
      ORD[k + 1] = e;
    }
    return;
  }
  let src = ORD;
  let dst = ORD_TMP;
  for (let width = 1; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = lo + width < n ? lo + width : n;
      const hi = lo + 2 * width < n ? lo + 2 * width : n;
      let i = lo;
      let j = mid;
      let k = lo;
      while (i < mid && j < hi) {
        // take from the left on ties: stable
        if (cmpF64(E_YMIN[src[j]!]!, E_YMIN[src[i]!]!) < 0) dst[k++] = src[j++]!;
        else dst[k++] = src[i++]!;
      }
      while (i < mid) dst[k++] = src[i++]!;
      while (j < hi) dst[k++] = src[j++]!;
    }
    const t = src;
    src = dst;
    dst = t;
  }
  if (src !== ORD) for (let i = 0; i < n; i++) ORD[i] = src[i]!;
}

/** `cmp_f64(x).then(dir)` of two crossings. */
function cmpCross(xa: number, da: number, xb: number, db: number): number {
  return cmpF64(xa, xb) || (da < db ? -1 : da > db ? 1 : 0);
}

/** Stable sort of the crossings `XS_X/XS_D[0..n]` by (x, dir). */
function sortCrossings(n: number): void {
  if (n <= 32) {
    for (let i = 1; i < n; i++) {
      const x = XS_X[i]!;
      const d = XS_D[i]!;
      let k = i - 1;
      while (k >= 0 && cmpCross(XS_X[k]!, XS_D[k]!, x, d) > 0) {
        XS_X[k + 1] = XS_X[k]!;
        XS_D[k + 1] = XS_D[k]!;
        k -= 1;
      }
      XS_X[k + 1] = x;
      XS_D[k + 1] = d;
    }
    return;
  }
  let sx = XS_X;
  let sd = XS_D;
  let tx = XS_X2;
  let td = XS_D2;
  for (let width = 1; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = lo + width < n ? lo + width : n;
      const hi = lo + 2 * width < n ? lo + 2 * width : n;
      let i = lo;
      let j = mid;
      let k = lo;
      while (i < mid && j < hi) {
        if (cmpCross(sx[j]!, sd[j]!, sx[i]!, sd[i]!) < 0) {
          tx[k] = sx[j]!;
          td[k++] = sd[j++]!;
        } else {
          tx[k] = sx[i]!;
          td[k++] = sd[i++]!;
        }
      }
      while (i < mid) {
        tx[k] = sx[i]!;
        td[k++] = sd[i++]!;
      }
      while (j < hi) {
        tx[k] = sx[j]!;
        td[k++] = sd[j++]!;
      }
    }
    const t = sx;
    sx = tx;
    tx = t;
    const u = sd;
    sd = td;
    td = u;
  }
  if (sx !== XS_X) {
    for (let i = 0; i < n; i++) {
      XS_X[i] = sx[i]!;
      XS_D[i] = sd[i]!;
    }
  }
}

/** Number of samples of each count 0..16 as quantized coverage. */
const Q16 = new Uint8Array(17);
for (let s = 1; s <= 16; s++) Q16[s] = quantize(s / 16);

/** Accumulates the union of primitives of one class. */
export class MaskRaster {
  /** The grid. */
  readonly spec: GridSpec;
  private readonly mask: Uint32Array;
  /** Sample spacing in px. */
  private readonly step: number;
  /** Output of {@link sampleRowRange}. */
  private j0 = 0;
  private j1 = 0;

  constructor(spec: GridSpec) {
    this.spec = spec;
    this.mask = new Uint32Array(spec.cells());
    this.step = spec.cell / 4;
  }

  /** y of sample row `j`. */
  private sampleY(j: number): number {
    return this.spec.oy + (j + 0.5) * this.step;
  }

  /** Range `[j0, j1]` of sample rows whose y lies in `[y0, y1]` (`j0 > j1` when empty). */
  private sampleRowRange(y0: number, y1: number): void {
    const a0 = Math.ceil((y0 - this.spec.oy) / this.step - 0.5);
    const b0 = Math.floor((y1 - this.spec.oy) / this.step - 0.5);
    const n = this.spec.rows * 4;
    const a = a0 < 0 ? 0 : a0;
    const b = b0 > n - 1 ? n - 1 : b0;
    if (b < a) {
      this.j0 = 1;
      this.j1 = 0;
    } else {
      this.j0 = toIndex(a);
      this.j1 = toIndex(b);
    }
  }

  /** Set the samples of row `j` with x in `[xa, xb)`. */
  private span(j: number, xa: number, xb: number): void {
    if (xb <= xa) return;
    const sc = this.spec.cols * 4;
    let k0 = Math.ceil((xa - this.spec.ox) / this.step - 0.5);
    let k1 = Math.ceil((xb - this.spec.ox) / this.step - 0.5); // exclusive
    if (k0 < 0) k0 = 0;
    if (k1 > sc) k1 = sc;
    if (k1 <= k0) return;
    // sample indices stay far below 2^31 (the mask array could not be allocated otherwise)
    const row = j >>> 2;
    const sy = j & 3;
    const base = row * this.spec.cols;
    const mask = this.mask;
    const kEnd = toIndex(k1);
    let k = toIndex(k0);
    while (k < kEnd) {
      const col = k >>> 2;
      const sx0 = k & 3;
      const lim = (col + 1) * 4;
      const end = lim < kEnd ? lim : kEnd;
      const sx1 = end - col * 4;
      // bits sx0..sx1 in row sy
      mask[base + col] |= ((1 << (sx1 - sx0)) - 1) << (sx0 + 4 * sy);
      k = end;
    }
  }

  /** Mark the cell containing `(px, py)` as touched. */
  private touchPoint(px: number, py: number): void {
    const s = this.spec;
    const u = (px - s.ox) / s.cell;
    const v = (py - s.oy) / s.cell;
    if (u >= 0 && v >= 0 && u < s.cols && v < s.rows) {
      this.mask[Math.trunc(v) * s.cols + Math.trunc(u)] |= TOUCH;
    }
  }

  /**
   * Mark all cells crossed by segment `ab` (supercover DDA). The parts of the segment
   * more than {@link TOUCH_MARGIN} cells outside the grid are clipped off first;
   * segments with a non-finite endpoint touch nothing.
   */
  touchSegment(a: P, b: P): void {
    this.touchSegmentXY(a.x, a.y, b.x, b.y);
  }

  /** {@link touchSegment} on scalars. */
  touchSegmentXY(ax: number, ay: number, bx: number, by: number): void {
    const sp = this.spec;
    SEG[0] = (ax - sp.ox) / sp.cell;
    SEG[1] = (ay - sp.oy) / sp.cell;
    SEG[2] = (bx - sp.ox) / sp.cell;
    SEG[3] = (by - sp.oy) / sp.cell;
    if (!(Number.isFinite(SEG[0]) && Number.isFinite(SEG[1]) && Number.isFinite(SEG[2]) && Number.isFinite(SEG[3]))) {
      return;
    }
    const lo = -TOUCH_MARGIN;
    if (!clipSlab(0, 1, lo, sp.cols + TOUCH_MARGIN) || !clipSlab(1, 0, lo, sp.rows + TOUCH_MARGIN)) return;
    const u0 = SEG[0]!;
    const v0 = SEG[1]!;
    const u1 = SEG[2]!;
    const v1 = SEG[3]!;
    const cols = sp.cols;
    const rows = sp.rows;
    // `+ 0` turns -0 into +0 like Rust's `as i64`
    let cx = Math.floor(u0) + 0;
    let cy = Math.floor(v0) + 0;
    const ex = Math.floor(u1) + 0;
    const ey = Math.floor(v1) + 0;
    const dx = u1 - u0;
    const dy = v1 - v0;
    const stepx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tmx = dx > 0 ? (cx + 1 - u0) / dx : dx < 0 ? (u0 - cx) / -dx : Infinity;
    let tmy = dy > 0 ? (cy + 1 - v0) / dy : dy < 0 ? (v0 - cy) / -dy : Infinity;
    const maxSteps = Math.abs(ex - cx) + Math.abs(ey - cy) + 2;
    const mask = this.mask;
    for (let s = 0; s <= maxSteps; s++) {
      if (cx >= 0 && cy >= 0 && cx < cols && cy < rows) mask[cy * cols + cx] |= TOUCH;
      if (cx === ex && cy === ey) break;
      if (tmx < tmy) {
        tmx += tdx;
        cx += stepx;
      } else {
        tmy += tdy;
        cy += stepy;
      }
    }
  }

  /** Disc of radius `r` centered at `c`. */
  disc(c: P, r: number): void {
    this.discXY(c.x, c.y, r);
  }

  /** {@link disc} on scalars. */
  discXY(cx: number, cy: number, r: number): void {
    this.touchPoint(cx, cy);
    if (r <= 0) return;
    this.sampleRowRange(cy - r, cy + r);
    const j0 = this.j0;
    const j1 = this.j1;
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) {
      const dy = this.sampleY(j) - cy;
      const h2 = r2 - dy * dy;
      if (h2 >= 0) {
        const h = Math.sqrt(h2);
        this.span(j, cx - h, cx + h);
      }
    }
  }

  /** Axis-aligned rectangle. */
  rect(x0: number, y0: number, x1: number, y1: number): void {
    this.touchPoint((x0 + x1) * 0.5, (y0 + y1) * 0.5);
    this.touchSegmentXY(x0, y0, x1, y0);
    this.touchSegmentXY(x1, y0, x1, y1);
    this.touchSegmentXY(x1, y1, x0, y1);
    this.touchSegmentXY(x0, y1, x0, y0);
    this.sampleRowRange(y0, y1);
    const j0 = this.j0;
    const j1 = this.j1;
    for (let j = j0; j <= j1; j++) {
      const y = this.sampleY(j);
      if (y >= y0 && y < y1) this.span(j, x0, x1);
    }
  }

  /** Capsule: all points within `hw` of segment `ab` (a stroked line segment). */
  capsule(a: P, b: P, hw: number): void {
    this.capsuleXY(a.x, a.y, b.x, b.y, hw);
  }

  /** {@link capsule} on scalars. */
  capsuleXY(ax: number, ay: number, bx: number, by: number, hw: number): void {
    this.touchSegmentXY(ax, ay, bx, by);
    if (hw <= 0) return;
    const y0 = minf(ay, by) - hw;
    const y1 = maxf(ay, by) + hw;
    this.sampleRowRange(y0, y1);
    const j0 = this.j0;
    const j1 = this.j1;
    const dx = bx - ax;
    const dy = by - ay;
    const l = len2d(dx, dy);
    const h2 = hw * hw;
    for (let j = j0; j <= j1; j++) {
      const y = this.sampleY(j);
      let lo = Infinity;
      let hi = -Infinity;
      // end discs
      const dya = y - ay;
      const qa = h2 - dya * dya;
      if (qa >= 0) {
        const s = Math.sqrt(qa);
        lo = minf(lo, ax - s);
        hi = maxf(hi, ax + s);
      }
      const dyb = y - by;
      const qb = h2 - dyb * dyb;
      if (qb >= 0) {
        const s = Math.sqrt(qb);
        lo = minf(lo, bx - s);
        hi = maxf(hi, bx + s);
      }
      // the band |cross(p - a, u)| <= hw, 0 <= dot(p - a, u) <= l
      if (l > 0) {
        const ux = dx / l;
        const uy = dy / l;
        // p = (x, y): cross = (x-ax)*uy - (y-ay)*ux ; dot = (x-ax)*ux + (y-ay)*uy
        const ry = y - ay;
        let xlo = -Infinity;
        let xhi = Infinity;
        // |t*uy - ry*ux| <= hw with t = x - ax
        if (uy !== 0) {
          const t1 = (-hw + ry * ux) / uy;
          const t2 = (hw + ry * ux) / uy;
          xlo = maxf(xlo, minf(t1, t2));
          xhi = minf(xhi, maxf(t1, t2));
        } else if (Math.abs(ry * ux) > hw) {
          xlo = 1;
          xhi = 0;
        }
        // 0 <= t*ux + ry*uy <= l
        if (ux !== 0) {
          const t1 = (0 - ry * uy) / ux;
          const t2 = (l - ry * uy) / ux;
          xlo = maxf(xlo, minf(t1, t2));
          xhi = minf(xhi, maxf(t1, t2));
        } else {
          const s = ry * uy;
          if (s < 0 || s > l) {
            xlo = 1;
            xhi = 0;
          }
        }
        if (xhi >= xlo) {
          lo = minf(lo, xlo + ax);
          hi = maxf(hi, xhi + ax);
        }
      }
      if (hi > lo) this.span(j, lo, hi);
    }
  }

  /** Polygon fill (multi-ring, non-zero or even-odd) with an active edge list. */
  polygon(rings: readonly (readonly P[])[], evenOdd: boolean): void {
    let ne = 0;
    let ylo = Infinity;
    let yhi = -Infinity;
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r]!;
      const n = ring.length;
      if (n < 2) {
        if (n === 1) this.touchPoint(ring[0]!.x, ring[0]!.y);
        continue;
      }
      ensureEdges(ne + n);
      for (let i = 0; i < n; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % n]!;
        this.touchSegmentXY(a.x, a.y, b.x, b.y);
        if (a.y === b.y) continue;
        const up = a.y < b.y;
        const top = up ? a : b;
        const bot = up ? b : a;
        ylo = minf(ylo, top.y);
        yhi = maxf(yhi, bot.y);
        E_YMIN[ne] = top.y;
        E_YMAX[ne] = bot.y;
        E_X[ne] = top.x;
        E_SLOPE[ne] = (bot.x - top.x) / (bot.y - top.y);
        E_DIR[ne] = up ? 1 : -1;
        ne += 1;
      }
    }
    if (ne === 0) return;
    sortEdges(ne);
    for (let i = 0; i < ne; i++) {
      const e = ORD[i]!;
      S_YMIN[i] = E_YMIN[e]!;
      S_YMAX[i] = E_YMAX[e]!;
      S_X[i] = E_X[e]!;
      S_SLOPE[i] = E_SLOPE[e]!;
      S_DIR[i] = E_DIR[e]!;
    }
    this.sampleRowRange(ylo, yhi);
    const j0 = this.j0;
    const j1 = this.j1;
    let next = 0;
    let nActive = 0;
    for (let j = j0; j <= j1; j++) {
      const y = this.sampleY(j);
      while (next < ne && S_YMIN[next]! <= y) {
        ACTIVE[nActive++] = next;
        next += 1;
      }
      // retain the edges with ymax > y (order kept)
      let w = 0;
      for (let k = 0; k < nActive; k++) {
        const e = ACTIVE[k]!;
        if (S_YMAX[e]! > y) ACTIVE[w++] = e;
      }
      nActive = w;
      let nx = 0;
      for (let k = 0; k < nActive; k++) {
        const e = ACTIVE[k]!;
        const ymin = S_YMIN[e]!;
        if (ymin <= y && y < S_YMAX[e]!) {
          XS_X[nx] = S_X[e]! + (y - ymin) * S_SLOPE[e]!;
          XS_D[nx] = S_DIR[e]!;
          nx += 1;
        }
      }
      sortCrossings(nx);
      if (evenOdd) {
        for (let k = 0; k + 1 < nx; k += 2) this.span(j, XS_X[k]!, XS_X[k + 1]!);
      } else {
        let wn = 0;
        let start = 0;
        for (let k = 0; k < nx; k++) {
          const x = XS_X[k]!;
          const before = wn;
          wn += XS_D[k]!;
          if (before === 0 && wn !== 0) {
            start = x;
          } else if (before !== 0 && wn === 0) {
            this.span(j, start, x);
          }
        }
      }
    }
  }

  /** Rasterize a mark shape (its true geometry; curved shapes via their outline). */
  shape(s: Shape): void {
    switch (s.kind) {
      case "circle":
        this.discXY(s.c.x, s.c.y, s.r);
        break;
      case "polygon":
        this.polygon(s.poly.rings, s.poly.evenOdd);
        break;
      default:
        this.polygon(s.outlineRingsView(), false);
    }
  }

  /** Final `u8` coverage (0..255; touched cells without samples get 1). */
  intoCoverage(): Uint8Array {
    const mask = this.mask;
    const out = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) {
      const m = mask[i]!;
      // popcount of the 16 sample bits
      let v = m & 0xffff;
      v = v - ((v >>> 1) & 0x5555);
      v = (v & 0x3333) + ((v >>> 2) & 0x3333);
      v = (v + (v >>> 4)) & 0x0f0f;
      const s = (v + (v >>> 8)) & 0x1f;
      out[i] = s > 0 ? Q16[s]! : (m & TOUCH) !== 0 ? 1 : 0;
    }
    return out;
  }
}
