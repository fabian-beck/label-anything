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
  }
}

/** `floor(cov·255 + 1/2)` clamped to 255; a positive coverage never quantizes to 0. */
export function quantize(cov: number): number {
  const q = Math.floor(cov * 255 + 0.5);
  return q >= 255 ? 255 : q >= 1 ? q : cov > 0 ? 1 : 0;
}

/**
 * Streams raster rows (ascending) into `k` coverage grids with the summation order
 * above, keeping only the grid rows touched by the current raster row as accumulators.
 */
export class Resampler {
  private readonly cap: number;
  private readonly acc: Float64Array;
  private readonly slotRow: Float64Array;
  private readonly h: Float64Array;
  private readonly dirtyLo: Int32Array;
  private readonly dirtyHi: Int32Array;
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
    this.h = new Float64Array(k * gcols);
    this.dirtyLo = new Int32Array(k).fill(0x7fffffff);
    this.dirtyHi = new Int32Array(k);
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
    const cols = this.cols;
    const a = cols.offs[px]!;
    const b = cols.offs[px + 1]!;
    if (a === b) return;
    const base = cls * this.gcols;
    const h = this.h;
    for (let t = a; t < b; t++) h[base + cols.cells[t]!] += v * cols.weights[t]!;
    this.markDirty(cls, a, b);
  }

  /** Adds value 1 of pixel `px` to class `cls` (`h += w`; identical to `add(.., 1)`). */
  addOne(cls: number, px: number): void {
    const cols = this.cols;
    const a = cols.offs[px]!;
    const b = cols.offs[px + 1]!;
    if (a === b) return;
    const base = cls * this.gcols;
    const h = this.h;
    for (let t = a; t < b; t++) h[base + cols.cells[t]!] += cols.weights[t]!;
    this.markDirty(cls, a, b);
  }

  private markDirty(cls: number, a: number, b: number): void {
    const first = this.cols.cells[a]!;
    const last = this.cols.cells[b - 1]! + 1;
    if (first < this.dirtyLo[cls]!) this.dirtyLo[cls] = first;
    if (last > this.dirtyHi[cls]!) this.dirtyHi[cls] = last;
  }

  /** Ends raster row `py`: `cov[gy][gx] += wy · h[gx]` for its grid rows, then clears `h`. */
  endRow(py: number): void {
    const rows = this.rows;
    const a = rows.offs[py]!;
    const b = rows.offs[py + 1]!;
    const { gcols, k, cap, acc, h } = this;
    for (let cls = 0; cls < k; cls++) {
      const lo = this.dirtyLo[cls]!;
      const hi = this.dirtyHi[cls]!;
      if (lo >= hi) continue;
      const hrow = cls * gcols;
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
      h.fill(0, hrow + lo, hrow + hi);
      this.dirtyLo[cls] = 0x7fffffff;
      this.dirtyHi[cls] = 0;
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
        out[o + gx] = quantize(acc[base + gx]!);
        acc[base + gx] = 0;
      }
    }
    this.slotRow[slot] = -1;
  }

  /** Finalizes all remaining rows and returns the `k` quantized grids. */
  finish(): Uint8Array[] {
    while (this.nextFinal < this.grows) this.finalize(this.nextFinal++);
    return this.out;
  }
}

/** Clamped sliding-window maximum of radius `r` over `line[0..n]` into `res`. */
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

/**
 * Applies a 3×3 maximum filter `times` times in place (cells outside the grid ignored),
 * as one clamped `(2t+1)²` window maximum computed separably in O(cells).
 */
export function dilate(grid: Uint8Array, cols: number, rows: number, times: number): void {
  if (times <= 0 || cols === 0 || rows === 0) return;
  const n = Math.max(cols, rows);
  const r = Math.min(times, n);
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
