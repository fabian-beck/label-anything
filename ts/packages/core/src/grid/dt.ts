/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher 2012) on the grid and
 * its local maxima, the free-space seeds of spec §4.7 (port of
 * `rust/crates/la-core/src/grid/dt.rs`).
 *
 * @module
 */

import { P } from "../geom/index.js";
import type { GridSpec } from "./index.js";

const INF = 1e20;

/**
 * 1-D squared distance transform of `f[0..n]` into `d[0..n]` (lower envelope of
 * parabolas); `v` and `z` are scratch buffers of at least `n` and `n + 1` entries.
 */
function dt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  if (n === 0) return;
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    const fq = f[q]! + q * q;
    let p = v[k]!;
    let s = (fq - (f[p]! + p * p)) / (2 * q - 2 * p);
    while (s <= z[k]!) {
      k -= 1;
      p = v[k]!;
      s = (fq - (f[p]! + p * p)) / (2 * q - 2 * p);
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k += 1;
    const p = v[k]!;
    const dq = q - p;
    d[q] = dq * dq + f[p]!;
  }
}

/**
 * Distance (in px) from every cell center to the nearest occupied cell center.
 * `occupied(i)` tells whether cell `i` (row-major) is an obstacle. Cells far from any
 * obstacle get a large value (≥ 1e9) when nothing is occupied.
 */
export function distanceTransform(g: GridSpec, occupied: (i: number) => boolean): Float64Array {
  const cols = g.cols;
  const rows = g.rows;
  const grid = new Float64Array(cols * rows);
  for (let i = 0; i < grid.length; i++) grid[i] = occupied(i) ? 0 : INF;
  const n = cols > rows ? cols : rows;
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  // columns: the squared distance to the nearest occupied cell of the column, by a
  // downward and an upward sweep over the rows (the 1-D transform of this binary input:
  // the same exact integers; columns without an occupied cell stay INF, which the row
  // pass treats like the envelope's >= 1e20 values). Mirrors the Rust sweeps.
  const near = new Int32Array(cols).fill(-1);
  for (let r = 0; r < rows; r++) {
    const o = r * cols;
    for (let c = 0; c < cols; c++) {
      if (grid[o + c] === 0) near[c] = r;
      else if (near[c]! >= 0) {
        const dr = r - near[c]!;
        grid[o + c] = dr * dr;
      }
    }
  }
  near.fill(-1);
  for (let r = rows - 1; r >= 0; r--) {
    const o = r * cols;
    for (let c = 0; c < cols; c++) {
      if (grid[o + c] === 0) near[c] = r;
      else if (near[c]! >= 0) {
        const dr = near[c]! - r;
        if (dr * dr < grid[o + c]!) grid[o + c] = dr * dr;
      }
    }
  }
  // rows
  for (let r = 0; r < rows; r++) {
    const o = r * cols;
    for (let c = 0; c < cols; c++) f[c] = grid[o + c]!;
    dt1d(f, cols, d, v, z);
    for (let c = 0; c < cols; c++) {
      const sq = d[c]!;
      grid[o + c] = sq >= INF * 0.5 ? 1e9 : Math.sqrt(sq) * g.cell;
    }
  }
  return grid;
}

/** A free-space seed: `[cell center, clearance in px, col, row]`. */
export type Seed = [p: P, v: number, col: number, row: number];

/**
 * Local maxima of a distance transform (the free-space seeds of spec §4.7): cells with
 * clearance `minV <= v < 1e9` that no 8-neighbour exceeds; on plateaus an equal
 * neighbour earlier in row-major order suppresses the cell. Returns the seeds in
 * row-major order.
 */
export function dtMaxima(g: GridSpec, dt: Float64Array, minV: number): Seed[] {
  const out: Seed[] = [];
  const cols = g.cols;
  const rows = g.rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = dt[r * cols + c]!;
      if (v < minV || v >= 1e9) continue;
      let isMax = true;
      outer: for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          const w = dt[rr * cols + cc]!;
          if (w > v || (w === v && (dr < 0 || (dr === 0 && dc < 0)))) {
            isMax = false;
            break outer;
          }
        }
      }
      if (isMax) out.push([g.cellCenter(c, r), v, c, r]);
    }
  }
  return out;
}
