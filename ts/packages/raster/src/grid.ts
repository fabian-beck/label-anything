// Area averaging of per-pixel values into a coverage grid (spec §4.6), quantization and
// dilation — the same arithmetic, in the same order, as the Rust crate (grid.rs):
//
//   h[py][gx]   = Σ over px ascending:  h + v(px, py) · wx(px, gx)      (h starts at 0)
//   cov[gy][gx] = Σ over py ascending:  cov + wy(py, gy) · h[py][gx]    (cov starts at 0)
//
// with axis weights `overlap / cell`, `overlap = min(p1, g1) − max(p0, g0)` kept when > 0.

/** The coverage grid geometry in canvas pixels (row-major `cols × rows` square cells). */
export interface GridSpec {
  /** Canvas x of the grid's left edge. */
  readonly originX: number;
  /** Canvas y of the grid's top edge. */
  readonly originY: number;
  /** Cell size in canvas pixels (> 0). */
  readonly cell: number;
  /** Number of columns. */
  readonly cols: number;
  /** Number of rows. */
  readonly rows: number;
}

/**
 * Where a raster lies on the canvas: `scale` raster pixels per canvas pixel (2 = HiDPI)
 * and the canvas position `[x, y]` of the raster's top-left corner.
 */
export interface RasterPlacement {
  readonly scale: number;
  readonly offset: readonly [number, number];
}

function fmin(a: number, b: number): number {
  return a < b ? a : b;
}

function fmax(a: number, b: number): number {
  return a > b ? a : b;
}

/**
 * Two-cell form of an axis (every pixel overlaps at most two adjacent cells): pixel `i`
 * adds `w0[i]` to cell `c0[i]` and `w1[i]` to cell `c0[i] + 1` (0 without a second cell;
 * adding +0 to a non-negative sum leaves it unchanged, so this equals the general form).
 */
interface TwoCells {
  readonly c0: Int32Array;
  readonly w0: Float64Array;
  readonly w1: Float64Array;
}

function twoCells(offs: Int32Array, cells: Int32Array, weights: Float64Array): TwoCells | null {
  const n = offs.length - 1;
  const c0 = new Int32Array(n);
  const w0 = new Float64Array(n);
  const w1 = new Float64Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const a = offs[i]!;
    const count = offs[i + 1]! - a;
    if (count === 0) {
      c0[i] = prev;
    } else if (count === 1 || (count === 2 && cells[a + 1] === cells[a]! + 1)) {
      prev = cells[a]!;
      c0[i] = prev;
      w0[i] = weights[a]!;
      if (count === 2) w1[i] = weights[a + 1]!;
    } else {
      return null;
    }
  }
  return { c0, w0, w1 };
}

/** Overlap weights between the pixels of one raster axis and the cells of one grid axis. */
export class Axis {
  /** `cells[offs[i]..offs[i + 1]]` (ascending) and `weights[..]` belong to pixel `i`. */
  readonly offs: Int32Array;
  readonly cells: Int32Array;
  readonly weights: Float64Array;
  /** Pixels `lo..hi` contain every pixel with at least one pair. */
  readonly lo: number;
  readonly hi: number;
  /** Largest `last cell − first cell + 1` of any pixel. */
  readonly span: number;
  /** The same weights in two-cell form, when possible. */
  readonly two: TwoCells | null;

  constructor(nPx: number, offset: number, scale: number, origin: number, cell: number, nCells: number) {
    const offs = new Int32Array(nPx + 1);
    const cells: number[] = [];
    const weights: number[] = [];
    let lo = nPx;
    let hi = 0;
    let span = 0;
    for (let i = 0; i < nPx; i++) {
      const p0 = offset + i / scale;
      const p1 = offset + (i + 1) / scale;
      const start = cells.length;
      if (nCells > 0) {
        const t = Math.floor((p0 - origin) / cell);
        let j = t > 0 ? (t < nCells - 1 ? t : nCells - 1) : 0;
        while (j > 0 && origin + j * cell > p0) j--;
        while (j < nCells) {
          const g0 = origin + j * cell;
          if (g0 >= p1) break;
          const g1 = origin + (j + 1) * cell;
          const overlap = fmin(p1, g1) - fmax(p0, g0);
          if (overlap > 0) {
            cells.push(j);
            weights.push(overlap / cell);
          }
          j++;
        }
      }
      if (cells.length > start) {
        if (i < lo) lo = i;
        hi = i + 1;
        const s = cells[cells.length - 1]! - cells[start]! + 1;
        if (s > span) span = s;
      }
      offs[i + 1] = cells.length;
    }
    this.offs = offs;
    this.cells = Int32Array.from(cells);
    this.weights = Float64Array.from(weights);
    this.lo = hi === 0 ? 0 : lo;
    this.hi = hi;
    this.span = span;
    this.two = twoCells(this.offs, this.cells, this.weights);
  }
}

/** `floor(cov·255 + 1/2)` clamped to 255; a positive coverage never quantizes to 0. */
export function quantize(cov: number): number {
  const t = cov * 255 + 0.5;
  return t >= 255 ? 255 : t >= 1 ? t | 0 : cov > 0 ? 1 : 0;
}

/**
 * Streams raster rows (ascending) into `k` coverage grids with the summation order
 * above, keeping only the grid rows touched by the current raster row as accumulators.
 */
export class Resampler {
  private readonly cap: number;
  private readonly acc: Float64Array;
  private readonly slotRow: Float64Array;
  /** `k` rows of `gcols + 1` sums (one padding cell for the two-cell form). */
  private readonly h: Float64Array;
  private readonly stride: number;
  /** Per class: first and last pixel added in the current row (−1 = none). */
  private readonly firstPx: Int32Array;
  private readonly lastPx: Int32Array;
  readonly out: Uint8Array[];
  private nextFinal = 0;

  constructor(
    private readonly cols: Axis,
    private readonly rows: Axis,
    private readonly gcols: number,
    private readonly grows: number,
    private readonly k: number,
  ) {
    this.cap = Math.max(rows.span, 1);
    this.acc = new Float64Array(this.cap * k * gcols);
    this.slotRow = new Float64Array(this.cap).fill(-1);
    this.stride = gcols + 1;
    this.h = new Float64Array(k * this.stride);
    this.firstPx = new Int32Array(k).fill(-1);
    this.lastPx = new Int32Array(k);
    this.out = [];
    for (let c = 0; c < k; c++) this.out.push(new Uint8Array(gcols * grows));
  }

  /** Starts raster row `py`; returns `false` (skip the row) if it touches no grid row. */
  beginRow(py: number): boolean {
    const a = this.rows.offs[py]!;
    if (a === this.rows.offs[py + 1]) return false;
    const first = this.rows.cells[a]!;
    while (this.nextFinal < first) this.finalize(this.nextFinal++);
    return true;
  }

  /** Adds value `v` of pixel `px` to class `cls` (`h += v · w`). */
  add(cls: number, px: number, v: number): void {
    const h = this.h;
    const base = cls * this.stride;
    const two = this.cols.two;
    if (two !== null) {
      const c = base + two.c0[px]!;
      h[c] += v * two.w0[px]!;
      h[c + 1] += v * two.w1[px]!;
    } else {
      const cols = this.cols;
      const a = cols.offs[px]!;
      const b = cols.offs[px + 1]!;
      if (a === b) return;
      for (let t = a; t < b; t++) h[base + cols.cells[t]!] += v * cols.weights[t]!;
    }
    if (this.firstPx[cls] === -1) this.firstPx[cls] = px;
    this.lastPx[cls] = px;
  }

  /** Adds value 1 of pixel `px` to class `cls` (`h += w`; identical to `add(.., 1)`). */
  addOne(cls: number, px: number): void {
    const h = this.h;
    const base = cls * this.stride;
    const two = this.cols.two;
    if (two !== null) {
      const c = base + two.c0[px]!;
      h[c] += two.w0[px]!;
      h[c + 1] += two.w1[px]!;
    } else {
      const cols = this.cols;
      const a = cols.offs[px]!;
      const b = cols.offs[px + 1]!;
      if (a === b) return;
      for (let t = a; t < b; t++) h[base + cols.cells[t]!] += cols.weights[t]!;
    }
    if (this.firstPx[cls] === -1) this.firstPx[cls] = px;
    this.lastPx[cls] = px;
  }

  /** Ends raster row `py`: `cov[gy][gx] += wy · h[gx]` for its grid rows, then clears `h`. */
  endRow(py: number): void {
    const rows = this.rows;
    const a = rows.offs[py]!;
    const b = rows.offs[py + 1]!;
    const { gcols, k, cap, acc, h, stride } = this;
    const cols = this.cols;
    const two = cols.two;
    for (let cls = 0; cls < k; cls++) {
      const first = this.firstPx[cls]!;
      if (first === -1) continue;
      const last = this.lastPx[cls]!;
      let lo: number;
      let hi: number;
      if (two !== null) {
        lo = two.c0[first]!;
        hi = Math.min(two.c0[last]! + 2, gcols);
      } else {
        lo = cols.cells[cols.offs[first]!]!;
        hi = cols.cells[cols.offs[last + 1]! - 1]! + 1;
      }
      const hrow = cls * stride;
      for (let t = a; t < b; t++) {
        const gy = rows.cells[t]!;
        const wy = rows.weights[t]!;
        const slot = gy % cap;
        if (this.slotRow[slot] !== gy) {
          if (this.slotRow[slot] !== -1) this.finalize(this.slotRow[slot]!);
          this.slotRow[slot] = gy;
        }
        const base = (slot * k + cls) * gcols;
        for (let gx = lo; gx < hi; gx++) acc[base + gx] += wy * h[hrow + gx]!;
      }
      h.fill(0, hrow + lo, hrow + Math.min(hi + 1, stride));
      this.firstPx[cls] = -1;
    }
  }

  /** Quantizes grid row `gy` (if it holds data) and frees its slot. */
  private finalize(gy: number): void {
    const slot = gy % this.cap;
    if (this.slotRow[slot] !== gy) return;
    const { gcols, k, acc } = this;
    for (let cls = 0; cls < k; cls++) {
      const base = (slot * k + cls) * gcols;
      const out = this.out[cls]!;
      const o = gy * gcols;
      for (let gx = 0; gx < gcols; gx++) {
        const cov = acc[base + gx]!;
        const t = cov * 255 + 0.5;
        out[o + gx] = t >= 255 ? 255 : t >= 1 ? t | 0 : cov > 0 ? 1 : 0;
      }
      acc.fill(0, base, base + gcols);
    }
    this.slotRow[slot] = -1;
  }

  /** Finalizes all remaining rows and returns the `k` quantized grids. */
  finish(): Uint8Array[] {
    while (this.nextFinal < this.grows) this.finalize(this.nextFinal++);
    return this.out;
  }
}

/** Clamped sliding-window maximum of radius `r` over `line[0..n]` into `res` (O(n)). */
function windowMax(line: Uint8Array, n: number, r: number, res: Uint8Array, dq: Int32Array): void {
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < n; i++) {
    const hi = Math.min(i + r, n - 1);
    while (next <= hi) {
      const v = line[next]!;
      while (tail > head && line[dq[tail - 1]!]! <= v) tail--;
      dq[tail++] = next++;
    }
    const lo = i - r;
    while (dq[head]! < lo) head++;
    res[i] = line[dq[head]!]!;
  }
}

/** One clamped 3-wide maximum along every row, in place. */
function max3Rows(grid: Uint8Array, cols: number, rows: number, tmp: Uint8Array): void {
  if (cols < 2) return;
  for (let y = 0; y < rows; y++) {
    const o = y * cols;
    tmp.set(grid.subarray(o, o + cols));
    grid[o] = Math.max(tmp[0]!, tmp[1]!);
    for (let x = 1; x < cols - 1; x++) {
      const a = tmp[x - 1]!;
      const b = tmp[x]!;
      const c = tmp[x + 1]!;
      const m = a > b ? a : b;
      grid[o + x] = m > c ? m : c;
    }
    grid[o + cols - 1] = Math.max(tmp[cols - 2]!, tmp[cols - 1]!);
  }
}

/** One clamped 3-tall maximum along every column, in place, processed row by row. */
function max3Cols(grid: Uint8Array, cols: number, rows: number, prev: Uint8Array, cur: Uint8Array): void {
  if (rows < 2) return;
  prev.set(grid.subarray(0, cols));
  for (let y = 0; y < rows; y++) {
    const o = y * cols;
    cur.set(grid.subarray(o, o + cols));
    if (y + 1 < rows) {
      const n = o + cols;
      for (let x = 0; x < cols; x++) {
        const a = prev[x]!;
        const b = cur[x]!;
        const c = grid[n + x]!;
        const m = a > b ? a : b;
        grid[o + x] = m > c ? m : c;
      }
    } else {
      for (let x = 0; x < cols; x++) {
        const a = prev[x]!;
        const b = cur[x]!;
        grid[o + x] = a > b ? a : b;
      }
    }
    prev.set(cur);
  }
}

/** Radii up to this use repeated 3-tap passes; larger ones the O(cells) deque. */
const DILATE_PASSES_MAX = 8;

/**
 * Applies a 3×3 maximum filter `times` times in place (cells outside the grid ignored):
 * one clamped `(2t+1)²` window maximum, computed separably (rows, then columns).
 */
export function dilate(grid: Uint8Array, cols: number, rows: number, times: number): void {
  if (times <= 0 || cols === 0 || rows === 0) return;
  const n = Math.max(cols, rows);
  const r = Math.min(times, n);
  if (r <= DILATE_PASSES_MAX) {
    const a = new Uint8Array(cols);
    const b = new Uint8Array(cols);
    for (let i = 0; i < r; i++) max3Rows(grid, cols, rows, a);
    for (let i = 0; i < r; i++) max3Cols(grid, cols, rows, a, b);
    return;
  }
  const line = new Uint8Array(n);
  const res = new Uint8Array(n);
  const dq = new Int32Array(n);
  for (let y = 0; y < rows; y++) {
    const o = y * cols;
    line.set(grid.subarray(o, o + cols));
    windowMax(line, cols, r, res, dq);
    grid.set(res.subarray(0, cols), o);
  }
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) line[y] = grid[y * cols + x]!;
    windowMax(line, rows, r, res, dq);
    for (let y = 0; y < rows; y++) grid[y * cols + x] = res[y]!;
  }
}
