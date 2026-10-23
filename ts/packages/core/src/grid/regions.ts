/**
 * The region map (spec §4.8, ADR 0050): the region each grid cell lies in, the borders
 * between regions, and what a label box or a leader has of them; port of
 * `rust/crates/la-core/src/grid/regions.rs`.
 *
 * @module
 */

import { ceilFast, cmpF64, floorFast, maxf, minf, toIndex } from "../math.js";
import { P, type Rect } from "../geom/index.js";
import { GridSpec, Sat } from "./index.js";

/** A fill of the region map: `region` 0 is open space, `k` the `k`-th region. */
export interface RegionFill {
  region: number;
  rings: P[][];
  evenOdd: boolean;
}

/** The areas of a box in the regions it overlaps, in cells (see {@link RegionMap.split}). */
export class Split {
  constructor(
    /** The box's area on the grid, `A = Σ a_r`. */
    readonly area: number,
    /** `Σ a_r²`. */
    readonly squares: number,
    /** The area in regions other than open space and the home region. */
    readonly foreign: number,
  ) {}

  /**
   * `4 · Σ_{r<s} a_r · a_s / A = 2 · (A² − Σ a_r²) / A`: the box's area for a box half in one
   * region and half in another, nothing for a box in one region.
   */
  straddle(): number {
    return this.area > 0 ? maxf((2 * (this.area * this.area - this.squares)) / this.area, 0) : 0;
  }
}

const NO_SPLIT = new Split(0, 0, 0);

/** The regions of the grid cells and the cells on borders. */
export class RegionMap {
  private constructor(
    readonly grid: GridSpec,
    /** The region of every cell, row-major (0 = open). */
    readonly ids: Uint32Array,
    /** Cells with a 4-neighbour in another region (summed-area table of 0/1 flags). */
    private readonly border: Sat,
  ) {}

  /**
   * The map of `fills`, painted in order onto open cells (a cell takes the region of the
   * last fill covering its centre); `null` without fills.
   */
  static of(grid: GridSpec, fills: readonly RegionFill[]): RegionMap | null {
    if (fills.length === 0) return null;
    const ids = new Uint32Array(grid.cells());
    for (const f of fills) paint(grid, ids, f);
    const { cols, rows } = grid;
    const flags = new Uint8Array(grid.cells());
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const k = r * cols + c;
        if (c + 1 < cols && ids[k] !== ids[k + 1]) {
          flags[k] = 1;
          flags[k + 1] = 1;
        }
        if (r + 1 < rows && ids[k] !== ids[k + cols]) {
          flags[k] = 1;
          flags[k + cols] = 1;
        }
      }
    }
    return new RegionMap(grid, ids, Sat.fromCoverage(cols, rows, flags));
  }

  /** The region of the cell containing `p` (open outside the grid). */
  at(p: P): number {
    const g = this.grid;
    const u = (p.x - g.ox) / g.cell;
    const v = (p.y - g.oy) / g.cell;
    if (u >= 0 && v >= 0 && u < g.cols && v < g.rows) return this.ids[toIndex(v) * g.cols + toIndex(u)]!;
    return 0;
  }

  /**
   * The home region of an item (spec §4.8): the region of the cell containing its reference
   * point `at`; when that is open, the region of most cells among those the mark's bounding
   * box `bbox` grown by one cell touches (ties: the lower region), else open.
   */
  home(at: P, bbox: Rect): number {
    const r = this.at(at);
    if (r !== 0) return r;
    const g = this.grid;
    const [c0, c1, r0, r1] = g.cellRange(bbox.inflate(g.cell));
    const ids: number[] = [];
    const counts: number[] = [];
    for (let row = r0; row < r1; row++) {
      for (let col = c0; col < c1; col++) {
        const id = this.ids[row * g.cols + col]!;
        if (id === 0) continue;
        const k = ids.indexOf(id);
        if (k >= 0) counts[k]! += 1;
        else {
          ids.push(id);
          counts.push(1);
        }
      }
    }
    let best = 0;
    let bestN = 0;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k]!;
      const n = counts[k]!;
      if (n > bestN || (n === bestN && id < best)) {
        best = id;
        bestN = n;
      }
    }
    return best;
  }

  /**
   * The areas of `rect` in the regions (in cells: the exact overlap of the box with each
   * cell, summed by the cell's region, row by row), for an item at home in `home`.
   * `scratch` holds the per-region sums (`ids` and `areas`).
   */
  split(rect: Rect, home: number, scratch: SplitScratch): Split {
    const g = this.grid;
    const cols = g.cols;
    const rows = g.rows;
    const u0 = clamp((rect.x0 - g.ox) / g.cell, cols);
    const u1 = clamp((rect.x1 - g.ox) / g.cell, cols);
    const v0 = clamp((rect.y0 - g.oy) / g.cell, rows);
    const v1 = clamp((rect.y1 - g.oy) / g.cell, rows);
    if (u1 <= u0 || v1 <= v0) return NO_SPLIT;
    // cells with positive overlap: [c0, c1) × [r0, r1)
    const c0 = toIndex(u0);
    const r0 = toIndex(v0);
    const c1 = toIndex(ceilFast(u1));
    const r1 = toIndex(ceilFast(v1));
    if (this.border.block(c0, c1, r0, r1) === 0) {
      // no border: one region
      const area = (u1 - u0) * (v1 - v0);
      const id = this.ids[r0 * cols + c0]!;
      return new Split(area, area * area, id !== 0 && id !== home ? area : 0);
    }
    const sIds = scratch.ids;
    const sAreas = scratch.areas;
    sIds.length = 0;
    sAreas.length = 0;
    let area = 0;
    for (let row = r0; row < r1; row++) {
      const wy = minf(v1, row + 1) - maxf(v0, row);
      for (let col = c0; col < c1; col++) {
        const wx = minf(u1, col + 1) - maxf(u0, col);
        const w = wx * wy;
        area += w;
        const id = this.ids[row * cols + col]!;
        const k = sIds.indexOf(id);
        if (k >= 0) sAreas[k] += w;
        else {
          sIds.push(id);
          sAreas.push(w);
        }
      }
    }
    let squares = 0;
    let foreign = 0;
    for (let k = 0; k < sIds.length; k++) {
      const id = sIds[k]!;
      const a = sAreas[k]!;
      squares += a * a;
      if (id !== 0 && id !== home) foreign += a;
    }
    return new Split(area, squares, foreign);
  }

  /**
   * The region borders the polyline `pts` crosses: its vertices and the points dividing each
   * segment into `max(1, ceil(length / cell))` equal steps, in order, and the number of
   * consecutive ones in different regions.
   */
  crossings(pts: readonly P[]): number {
    if (pts.length === 0) return 0;
    let prev = this.at(pts[0]!);
    let n = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const steps = maxf(ceilFast(a.dist(b) / this.grid.cell), 1);
      const kMax = Number.isFinite(steps) ? toU32(steps) : 1;
      for (let k = 1; k <= kMax; k++) {
        const r = this.at(a.lerp(b, k / kMax));
        if (r !== prev) {
          n += 1;
          prev = r;
        }
      }
    }
    return n;
  }
}

/** Reusable per-region sums of {@link RegionMap.split}. */
export interface SplitScratch {
  ids: number[];
  areas: number[];
}

/** Rust `f as u32` for a finite `f ≥ 1`: truncation, saturating at `u32::MAX`. */
function toU32(f: number): number {
  return f >= 4294967295 ? 4294967295 : Math.trunc(f);
}

function clamp(v: number, n: number): number {
  if (v < 0) return 0;
  if (v > n) return n;
  return v;
}

interface Edge {
  ymin: number;
  ymax: number;
  xAtYmin: number;
  slope: number;
  dir: number;
}

/**
 * Paint `fill` onto the cells whose centres it covers (its fill rule; an active edge list per
 * cell row, as the coverage rasterizer does per sample row).
 */
function paint(g: GridSpec, ids: Uint32Array, fill: RegionFill): void {
  const edges: Edge[] = [];
  let ylo = Infinity;
  let yhi = -Infinity;
  for (const ring of fill.rings) {
    const n = ring.length;
    if (n < 3) continue;
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % n]!;
      if (a.y === b.y || !(a.isFinite() && b.isFinite())) continue;
      const up = a.y < b.y;
      const top = up ? a : b;
      const bot = up ? b : a;
      ylo = minf(ylo, top.y);
      yhi = maxf(yhi, bot.y);
      edges.push({ ymin: top.y, ymax: bot.y, xAtYmin: top.x, slope: (bot.x - top.x) / (bot.y - top.y), dir: up ? 1 : -1 });
    }
  }
  if (edges.length === 0) return;
  // stable, as Rust's sort
  edges.sort((p, q) => cmpF64(p.ymin, q.ymin));
  // rows whose centre lies in [ylo, yhi]
  const j0 = maxf(ceilFast((ylo - g.oy) / g.cell - 0.5), 0);
  const j1 = minf(floorFast((yhi - g.oy) / g.cell - 0.5), g.rows - 1);
  if (j0 > j1) return;
  let next = 0;
  let active: number[] = [];
  const xs: [number, number][] = [];
  for (let j = j0; j <= j1; j++) {
    const y = g.oy + (j + 0.5) * g.cell;
    while (next < edges.length && edges[next]!.ymin <= y) {
      active.push(next);
      next += 1;
    }
    active = active.filter((e) => edges[e]!.ymax > y);
    xs.length = 0;
    for (const e of active) {
      const ed = edges[e]!;
      if (ed.ymin <= y && y < ed.ymax) xs.push([ed.xAtYmin + (y - ed.ymin) * ed.slope, ed.dir]);
    }
    xs.sort((p, q) => cmpF64(p[0], q[0]) || p[1] - q[1]);
    if (fill.evenOdd) {
      for (let k = 0; k + 1 < xs.length; k += 2) span(g, ids, j, xs[k]![0], xs[k + 1]![0], fill.region);
    } else {
      let w = 0;
      let start = 0;
      for (const [x, d] of xs) {
        const before = w;
        w += d;
        if (before === 0 && w !== 0) start = x;
        else if (before !== 0 && w === 0) span(g, ids, j, start, x, fill.region);
      }
    }
  }
}

/** Set the cells of row `j` whose centre x lies in `[xa, xb)`. */
function span(g: GridSpec, ids: Uint32Array, j: number, xa: number, xb: number, region: number): void {
  if (xb <= xa) return;
  const k0 = maxf(ceilFast((xa - g.ox) / g.cell - 0.5), 0);
  const k1 = minf(ceilFast((xb - g.ox) / g.cell - 0.5), g.cols);
  if (k1 <= k0) return;
  ids.fill(region, j * g.cols + k0, j * g.cols + k1);
}
