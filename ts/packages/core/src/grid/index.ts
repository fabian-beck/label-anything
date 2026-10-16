/**
 * Per-class coverage grids with summed-area tables (spec §4.1, ADR 0005); port of
 * `rust/crates/la-core/src/grid/mod.rs`.
 *
 * @module
 */

import { toIndex } from "../math.js";
import { P, Rect } from "../geom/index.js";

/** Grid geometry in canvas pixels. */
export class GridSpec {
  readonly ox: number;
  readonly oy: number;
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;

  constructor(ox: number, oy: number, cell: number, cols: number, rows: number) {
    this.ox = ox;
    this.oy = oy;
    this.cell = cell;
    this.cols = cols;
    this.rows = rows;
  }

  /** Grid covering `extent` with the given cell size. */
  static covering(extent: Rect, cell: number): GridSpec {
    const c = toIndex(Math.ceil(extent.w() / cell));
    const r = toIndex(Math.ceil(extent.h() / cell));
    return new GridSpec(extent.x0, extent.y0, cell, c > 1 ? c : 1, r > 1 ? r : 1);
  }

  cells(): number {
    return this.cols * this.rows;
  }

  /** Continuous cell coordinates of a canvas point. */
  toCell(p: P): [number, number] {
    return [(p.x - this.ox) / this.cell, (p.y - this.oy) / this.cell];
  }

  /** Canvas rectangle of cell (col, row). */
  cellRect(col: number, row: number): Rect {
    const x = this.ox + col * this.cell;
    const y = this.oy + row * this.cell;
    return new Rect(x, y, x + this.cell, y + this.cell);
  }

  /** Canvas center of cell (col, row). */
  cellCenter(col: number, row: number): P {
    return new P(this.ox + (col + 0.5) * this.cell, this.oy + (row + 0.5) * this.cell);
  }

  /** The extent covered by the grid. */
  extent(): Rect {
    return new Rect(this.ox, this.oy, this.ox + this.cols * this.cell, this.oy + this.rows * this.cell);
  }

  /** Integer cell range `[c0, c1) × [r0, r1)` of cells touched by `r`, clamped. */
  cellRange(r: Rect): [number, number, number, number] {
    cellRangeInto(this, r);
    return [RANGE[0]!, RANGE[1]!, RANGE[2]!, RANGE[3]!];
  }

  /** `self == o` (field equality). */
  eq(o: GridSpec): boolean {
    return this.ox === o.ox && this.oy === o.oy && this.cell === o.cell && this.cols === o.cols && this.rows === o.rows;
  }
}

/** Output of {@link cellRangeInto}: `[c0, c1, r0, r1]`. */
const RANGE = new Float64Array(4);

/** `g.cellRange(r)` into {@link RANGE} without allocating. */
function cellRangeInto(g: GridSpec, r: Rect): void {
  const u0 = (r.x0 - g.ox) / g.cell;
  const v0 = (r.y0 - g.oy) / g.cell;
  const u1 = (r.x1 - g.ox) / g.cell;
  const v1 = (r.y1 - g.oy) / g.cell;
  const c0 = clampFloor(u0, g.cols);
  const r0 = clampFloor(v0, g.rows);
  const c1 = clampCeil(u1, g.cols);
  const r1 = clampCeil(v1, g.rows);
  RANGE[0] = c0;
  RANGE[1] = c1 > c0 ? c1 : c0;
  RANGE[2] = r0;
  RANGE[3] = r1 > r0 ? r1 : r0;
}

function clampFloor(v: number, n: number): number {
  if (v <= 0) return 0;
  if (v >= n) return n;
  return toIndex(Math.floor(v));
}

function clampCeil(v: number, n: number): number {
  if (v <= 0) return 0;
  if (v >= n) return n;
  return toIndex(Math.ceil(v));
}

/** Axis parts of {@link Sat.integral}: cells `[start, end)` and weights, 3 per axis. */
const XI = new Int32Array(6);
const XW = new Float64Array(3);
const YI = new Int32Array(6);
const YW = new Float64Array(3);

/** Summed-area table of a `u8` coverage grid (wrapping `u32`). */
export class Sat {
  readonly cols: number;
  readonly rows: number;
  /** `(rows + 1) × (cols + 1)` prefix sums, row-major. */
  private readonly data: Uint32Array;
  /** Whether any cell is non-zero. */
  readonly nonempty: boolean;

  private constructor(cols: number, rows: number, data: Uint32Array, nonempty: boolean) {
    this.cols = cols;
    this.rows = rows;
    this.data = data;
    this.nonempty = nonempty;
  }

  /** Build the table of a `cols × rows` coverage grid (row-major). */
  static fromCoverage(cols: number, rows: number, cov: Uint8Array): Sat {
    if (cov.length < cols * rows) throw new RangeError("coverage shorter than cols * rows");
    const w = cols + 1;
    const data = new Uint32Array(w * (rows + 1));
    let nonempty = false;
    for (let r = 0; r < rows; r++) {
      let rowSum = 0;
      const src = r * cols;
      const prev = r * w;
      const cur = (r + 1) * w;
      for (let c = 0; c < cols; c++) {
        const v = cov[src + c]!;
        if (v !== 0) nonempty = true;
        rowSum = (rowSum + v) >>> 0;
        data[cur + c + 1] = (data[prev + c + 1]! + rowSum) >>> 0;
      }
    }
    return new Sat(cols, rows, data, nonempty);
  }

  /** Sum of cells `[c0, c1) × [r0, r1)` (bounds must be within the grid). */
  block(c0: number, c1: number, r0: number, r1: number): number {
    if (c1 <= c0 || r1 <= r0) return 0;
    const d = this.data;
    const w = this.cols + 1;
    // wrapping u32 arithmetic: the intermediate sum is exact (|.| < 2^34)
    return (d[r1 * w + c1]! - d[r1 * w + c0]! - d[r0 * w + c1]! + d[r0 * w + c0]!) >>> 0;
  }

  /** Value of one cell. */
  cell(c: number, r: number): number {
    return this.block(c, c + 1, r, r + 1) & 0xff;
  }

  /**
   * Exact integral of the piecewise-constant coverage over `rect` (spec §4.1), in units
   * of "coverage-cells" (0..255 per fully covered cell).
   */
  integral(g: GridSpec, rect: Rect): number {
    if (!this.nonempty) return 0;
    const cols = this.cols;
    const rows = this.rows;
    const u0 = clamp01((rect.x0 - g.ox) / g.cell, cols);
    const u1 = clamp01((rect.x1 - g.ox) / g.cell, cols);
    const v0 = clamp01((rect.y0 - g.oy) / g.cell, rows);
    const v1 = clamp01((rect.y1 - g.oy) / g.cell, rows);
    if (u1 <= u0 || v1 <= v0) return 0;
    axisParts(u0, u1, cols, XI, XW);
    axisParts(v0, v1, rows, YI, YW);
    let total = 0;
    for (let j = 0; j < 3; j++) {
      const wy = YW[j]!;
      if (wy === 0) continue;
      const ya = YI[2 * j]!;
      const yb = YI[2 * j + 1]!;
      for (let i = 0; i < 3; i++) {
        const wx = XW[i]!;
        if (wx === 0) continue;
        const s = this.block(XI[2 * i]!, XI[2 * i + 1]!, ya, yb);
        if (s !== 0) total += wx * wy * s;
      }
    }
    return total;
  }

  /** Covered area of `rect` in px² (coverage-weighted). */
  coveredArea(g: GridSpec, rect: Rect): number {
    return this.integral(g, rect) * ((g.cell * g.cell) / 255);
  }

  /** Whether `rect` overlaps any non-zero cell (with positive overlap area). */
  any(g: GridSpec, rect: Rect): boolean {
    if (!this.nonempty) return false;
    cellRangeInto(g, rect);
    const c0 = RANGE[0]!;
    const c1 = RANGE[1]!;
    const r0 = RANGE[2]!;
    const r1 = RANGE[3]!;
    if (c1 <= c0 || r1 <= r0) return false;
    // cells touched with positive area: the closed range from cell_range is exact
    // because rect edges exactly on cell boundaries round inward via floor/ceil.
    return this.block(c0, c1, r0, r1) !== 0;
  }
}

function clamp01(v: number, n: number): number {
  if (v < 0) return 0;
  if (v > n) return n;
  return v;
}

/**
 * Split the interval `[a, b]` (cell units, `0 <= a < b <= n`) into up to three parts:
 * the partial first cell, the full interior cells and the partial last cell. Part `k` is
 * cells `[cells[2k], cells[2k + 1])` with weight `w[k]`; unused parts have weight 0
 * (their cells are stale and never read).
 */
function axisParts(a: number, b: number, n: number, cells: Int32Array, w: Float64Array): void {
  w[0] = 0;
  w[1] = 0;
  w[2] = 0;
  const i0 = toIndex(Math.floor(a));
  if (i0 >= n) return;
  const bf = Math.floor(b);
  const i1 = toIndex(bf); // cell containing b, or n when b == n
  if (i1 === i0) {
    cells[0] = i0;
    cells[1] = i0 + 1;
    w[0] = b - a;
    return;
  }
  cells[0] = i0;
  cells[1] = i0 + 1;
  w[0] = i0 + 1 - a;
  cells[2] = i0 + 1;
  cells[3] = i1;
  w[1] = 1;
  if (i1 < n && b > bf) {
    cells[4] = i1;
    cells[5] = i1 + 1;
    w[2] = b - bf;
  }
}

/** Quantize a coverage fraction to 0..=255 (a positive fraction never maps to 0). */
export function quantize(f: number): number {
  if (f <= 0) return 0;
  const q = Math.floor(f * 255 + 0.5);
  if (q < 1) return 1;
  if (q > 255) return 255;
  return toIndex(q);
}
