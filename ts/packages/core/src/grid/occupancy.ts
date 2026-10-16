/**
 * Occupancy grids for quick, exact rejection of label boxes (placed labels, item marks);
 * port of `rust/crates/la-core/src/grid/occupancy.rs`.
 *
 * The row bitsets use 32-bit words (Rust: 64-bit); the set of occupied cells and every
 * answer are the same.
 *
 * @module
 */

import { EPS, Rect } from "../geom/index.js";
import type { Shape } from "../geom/shape.js";
import { clampf, maxf, toIndex } from "../math.js";

/**
 * Margin of the quick rejection test (2 × `EPS`, so that a hit implies an overlap in the
 * sense of `Rect.overlaps`).
 */
export const OCC_MARGIN = 2 * EPS;

/** Output of {@link Occupancy.span}: `[start, end)`. */
const SPAN = new Int32Array(2);

/** A query window `[c0, c1, r0, r1]` (cell index ranges `c0..c1` × `r0..r1`). */
export type Window = Int32Array;

/** A new {@link Window} buffer. */
export function newWindow(): Window {
  return new Int32Array(4);
}

/**
 * Fine grid counting, per cell, the placed rectangular labels whose interior contains the
 * cell center, mirrored in a per-row bitset of non-zero cells. A candidate box whose
 * interior contains an occupied cell center (with margin) overlaps a placed label: an
 * exact rejection test (placed labels in `State.quickBlocked`, item marks in
 * `Obstacles.itemOcc`) that misses only overlaps thinner than a cell.
 */
export class Occupancy {
  private readonly ox: number;
  private readonly oy: number;
  private readonly cell: number;
  private readonly invCell: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly count: Uint16Array;
  /** `words` u32 per row; bit `c % 32` of word `c / 32` of row `r` = `count[r * cols + c] > 0`. */
  private readonly bits: Uint32Array;
  private readonly words: number;
  /**
   * For grids that no longer change ({@link freeze}): summed-area table of the occupied
   * cells, `(cols + 1) × (rows + 1)`, so that a window query is O(1).
   */
  private sat: Uint32Array | null = null;
  /** Scratch window of {@link blocked}. */
  private readonly win = newWindow();
  /** Scratch box of {@link blocked} and {@link window}. */
  private readonly box = new Float64Array(4);

  constructor(extent: Rect) {
    // about 1M cells at most, and never finer than 2 px
    const area = maxf(extent.w() * extent.h(), 1);
    const cell = maxf(2, Math.sqrt(area / 1.0e6));
    const cols = clampCount(toIndex(Math.ceil(extent.w() / cell)));
    const rows = clampCount(toIndex(Math.ceil(extent.h() / cell)));
    const words = (cols + 31) >>> 5;
    this.ox = extent.x0;
    this.oy = extent.y0;
    this.cell = cell;
    this.invCell = 1 / cell;
    this.cols = cols;
    this.rows = rows;
    this.count = new Uint16Array(cols * rows);
    this.bits = new Uint32Array(words * rows);
    this.words = words;
  }

  /**
   * Cells `k` (along one axis) whose centers `o + (k + 0.5)·cell` lie inside `(a, b)`
   * shrunk by the margin, as a half-open index range in {@link SPAN}. Mark and query use
   * the same computation; its rounding error (~1e-13 px) is far below the margin, so a
   * cell center counted inside both a placed label and a candidate implies an overlap.
   */
  private span(o: number, n: number, a: number, b: number): void {
    // t0 < k < t1: k from floor(t0) + 1 to ceil(t1) (exclusive), clamped to 0..n.
    // Integer arithmetic on values clamped to ±4.5e15 (< 2^52, where floor and ceil are
    // exact; anything beyond lies off the grid either way). A NaN converts to 0.
    const t0 = clampf((a + OCC_MARGIN - o) * this.invCell - 0.5, -4.5e15, 4.5e15);
    const t1 = clampf((b - OCC_MARGIN - o) * this.invCell - 0.5, -4.5e15, 4.5e15);
    const i0 = t0 === t0 ? Math.trunc(t0) : 0;
    const fr = i0 - (i0 > t0 ? 1 : 0) + 1;
    const f = fr > 0 ? fr : 0;
    const i1 = t1 === t1 ? Math.trunc(t1) : 0;
    const lr = i1 + (i1 < t1 ? 1 : 0);
    const l = lr < n ? lr : n;
    if (l <= f) {
      SPAN[0] = 0;
      SPAN[1] = 0;
      return;
    }
    SPAN[0] = f;
    SPAN[1] = l;
  }

  /** Builds the summed-area table of a grid that will not change any more (marking again drops it). */
  freeze(): void {
    const w = this.cols + 1;
    const sat = new Uint32Array(w * (this.rows + 1));
    for (let r = 0; r < this.rows; r++) {
      let run = 0;
      for (let c = 0; c < this.cols; c++) {
        run += this.count[r * this.cols + c]! > 0 ? 1 : 0;
        sat[(r + 1) * w + c + 1] = sat[r * w + c + 1]! + run;
      }
    }
    this.sat = sat;
  }

  /** Add (or remove) a rectangle: cells whose centers lie strictly inside it. */
  mark(r: Rect, add: boolean): void {
    this.sat = null;
    this.span(this.ox, this.cols, r.x0, r.x1);
    const c0 = SPAN[0]!;
    const c1 = SPAN[1]!;
    this.span(this.oy, this.rows, r.y0, r.y1);
    const r0 = SPAN[0]!;
    const r1 = SPAN[1]!;
    const count = this.count;
    const bits = this.bits;
    for (let row = r0; row < r1; row++) {
      const base = row * this.cols;
      const wbase = row * this.words;
      for (let c = c0; c < c1; c++) {
        let v = count[base + c]!;
        v = add ? (v < 65535 ? v + 1 : v) : v > 0 ? v - 1 : 0;
        count[base + c] = v;
        const bit = 1 << (c & 31);
        if (v > 0) bits[wbase + (c >>> 5)] |= bit;
        else bits[wbase + (c >>> 5)] &= ~bit;
      }
    }
  }

  /** Whether any occupied cell center lies strictly inside `r`. */
  blocked(r: Rect): boolean {
    const b = this.box;
    b[0] = r.x0;
    b[1] = r.y0;
    b[2] = r.x1;
    b[3] = r.y1;
    return this.windowBox(b, this.win) && this.blockedIn(this.win);
  }

  /** {@link blocked} of the box `[b[0], b[2]] × [b[1], b[3]]`. */
  blockedBox(b: Float64Array): boolean {
    return this.windowBox(b, this.win) && this.blockedIn(this.win);
  }

  /**
   * The cells whose centers lie strictly inside `r`, into `w`; false if there are none.
   * Grids with the same cells ({@link sameCells}) can share a window.
   */
  window(r: Rect, w: Window): boolean {
    const b = this.box;
    b[0] = r.x0;
    b[1] = r.y0;
    b[2] = r.x1;
    b[3] = r.y1;
    return this.windowBox(b, w);
  }

  /**
   * {@link window} of the box `[b[0], b[2]] × [b[1], b[3]]`. The box comes in a typed
   * array (hot callers: the candidate filter) and the spans of {@link span} are computed
   * inline, so that no coordinate is passed as a (boxed) argument.
   */
  windowBox(b: Float64Array, w: Window): boolean {
    const inv = this.invCell;
    // columns: span(ox, cols, b[0], b[2])
    const tx0 = clampf((b[0]! + OCC_MARGIN - this.ox) * inv - 0.5, -4.5e15, 4.5e15);
    const tx1 = clampf((b[2]! - OCC_MARGIN - this.ox) * inv - 0.5, -4.5e15, 4.5e15);
    const ix0 = tx0 === tx0 ? Math.trunc(tx0) : 0;
    const fx = ix0 - (ix0 > tx0 ? 1 : 0) + 1;
    const c0 = fx > 0 ? fx : 0;
    const ix1 = tx1 === tx1 ? Math.trunc(tx1) : 0;
    const lx = ix1 + (ix1 < tx1 ? 1 : 0);
    const c1 = lx < this.cols ? lx : this.cols;
    if (c1 <= c0) return false;
    // rows: span(oy, rows, b[1], b[3])
    const ty0 = clampf((b[1]! + OCC_MARGIN - this.oy) * inv - 0.5, -4.5e15, 4.5e15);
    const ty1 = clampf((b[3]! - OCC_MARGIN - this.oy) * inv - 0.5, -4.5e15, 4.5e15);
    const iy0 = ty0 === ty0 ? Math.trunc(ty0) : 0;
    const fy = iy0 - (iy0 > ty0 ? 1 : 0) + 1;
    const r0 = fy > 0 ? fy : 0;
    const iy1 = ty1 === ty1 ? Math.trunc(ty1) : 0;
    const ly = iy1 + (iy1 < ty1 ? 1 : 0);
    const r1 = ly < this.rows ? ly : this.rows;
    if (r1 <= r0) return false;
    w[0] = c0;
    w[1] = c1;
    w[2] = r0;
    w[3] = r1;
    return true;
  }

  /** Whether the two grids have the same cells. */
  sameCells(o: Occupancy): boolean {
    return this.ox === o.ox && this.oy === o.oy && this.cell === o.cell && this.cols === o.cols && this.rows === o.rows;
  }

  /** Whether any cell of the window is occupied. */
  blockedIn(win: Window): boolean {
    const c0 = win[0]!;
    const c1 = win[1]!;
    const r0 = win[2]!;
    const r1 = win[3]!;
    const sat = this.sat;
    if (sat !== null) {
      const s = this.cols + 1;
      const n = sat[r1 * s + c1]! - sat[r0 * s + c1]! - (sat[r1 * s + c0]! - sat[r0 * s + c0]!);
      return n !== 0;
    }
    const stride = this.words;
    const bits = this.bits;
    const w0 = c0 >>> 5;
    const w1 = (c1 - 1) >>> 5;
    const first = (0xffffffff << (c0 & 31)) >>> 0;
    const last = 0xffffffff >>> (31 - ((c1 - 1) & 31));
    if (w0 === w1) {
      // the common case: the window lies in one word of every row
      const m = (first & last) >>> 0;
      for (let k = r0 * stride + w0; k < r1 * stride; k += stride) if ((bits[k]! & m) !== 0) return true;
      return false;
    }
    for (let row = r0; row < r1; row++) {
      const base = row * stride;
      if ((bits[base + w0]! & first) !== 0 || (bits[base + w1]! & last) !== 0) return true;
      for (let k = base + w0 + 1; k < base + w1; k++) if (bits[k] !== 0) return true;
    }
    return false;
  }

  /** Add a shape: cells whose centers lie strictly inside it (by more than the margin). */
  markShape(s: Shape): void {
    this.sat = null;
    const bb = s.bbox();
    this.span(this.ox, this.cols, bb.x0, bb.x1);
    const c0 = SPAN[0]!;
    const c1 = SPAN[1]!;
    this.span(this.oy, this.rows, bb.y0, bb.y1);
    const r0 = SPAN[0]!;
    const r1 = SPAN[1]!;
    const cell = this.cell;
    for (let row = r0; row < r1; row++) {
      const y = this.oy + (row + 0.5) * cell;
      for (let c = c0; c < c1; c++) {
        const x = this.ox + (c + 0.5) * cell;
        if (s.signedDistanceXY(x, y) < -OCC_MARGIN) {
          const k = row * this.cols + c;
          const v = this.count[k]!;
          this.count[k] = v < 65535 ? v + 1 : v;
          this.bits[row * this.words + (c >>> 5)] |= 1 << (c & 31);
        }
      }
    }
  }

  /** Whether nothing is marked. */
  isEmpty(): boolean {
    for (let i = 0; i < this.bits.length; i++) if (this.bits[i] !== 0) return false;
    return true;
  }
}

function clampCount(n: number): number {
  return n < 1 ? 1 : n > 4096 ? 4096 : n;
}
