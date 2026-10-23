/**
 * Obstacle preparation (spec §4): class policies, coverage grids with SATs, exact
 * primitive indexes and the distance transform of the static hard classes; port of
 * `rust/crates/la-core/src/obstacles.rs`.
 *
 * @module
 */

import { backdropLuma, process as rasterProcess } from "@label-anything/raster";
import {
  EPS,
  P,
  Rect,
  distPointSegXY,
  distSegRectXY,
  rectDistPointXY,
  sampleRangeInRect,
  segOverlapsRectXY,
  segSegDistXY,
} from "./geom/index.js";
import * as polygon from "./geom/polygon.js";
import { Backdrop, GridSpec, Sat } from "./grid/index.js";
import { distanceTransform, dtMaxima, type Seed } from "./grid/dt.js";
import { Occupancy } from "./grid/occupancy.js";
import { RegionMap } from "./grid/regions.js";
import { MaskRaster } from "./grid/raster.js";
import { asF64, get } from "./json.js";
import { clampf, cmpStr, maxf, minf, toIndex } from "./math.js";
import type { Shape } from "./geom/shape.js";
import { type Model, type Prim, primBbox } from "./model/index.js";
import { parseRustF64 } from "./json.js";
import { StaticIndex } from "./spatial.js";

export const AvoidKind = { Hard: 0, Ignore: 1, Soft: 2 } as const;
export type AvoidKind = (typeof AvoidKind)[keyof typeof AvoidKind];

/** Interaction policy of one class with labels or leaders (Rust `enum AvoidW`). */
export class AvoidW {
  private constructor(
    readonly kind: AvoidKind,
    /** The weight of `Soft(w)` (0 otherwise). */
    readonly w: number,
  ) {}

  static readonly HARD = new AvoidW(AvoidKind.Hard, 0);
  static readonly IGNORE = new AvoidW(AvoidKind.Ignore, 0);
  static soft(w: number): AvoidW {
    return new AvoidW(AvoidKind.Soft, w);
  }

  /** `AvoidW::parse` (`undefined`: absent). */
  static parse(v: unknown): AvoidW | null {
    if (v === "hard") return AvoidW.HARD;
    if (v === "ignore") return AvoidW.IGNORE;
    if (typeof v === "number") return v > 0 ? AvoidW.soft(v) : AvoidW.IGNORE;
    return null;
  }

  isHard(): boolean {
    return this.kind === AvoidKind.Hard;
  }

  /** Whether both are the same policy (Rust `==`). */
  equals(o: AvoidW): boolean {
    return this.kind === o.kind && this.w === o.w;
  }

  isSoft(): boolean {
    return this.kind === AvoidKind.Soft;
  }

  isIgnore(): boolean {
    return this.kind === AvoidKind.Ignore;
  }

  weight(): number {
    return this.kind === AvoidKind.Soft ? this.w : 0;
  }
}

/** Own-mark policy for external labels. */
export type OwnMark = { kind: "hard" } | { kind: "ignore" } | { kind: "partial"; f: number };

/** A static obstacle class. */
export interface Class {
  name: string;
  label: AvoidW;
  leader: AvoidW;
  buffer: number;
  relaxable: boolean;
  /** Coverage grid (absent when the class never costs anything on the grid). */
  sat: Sat | null;
  /** Exact primitives exist (vector classes). */
  hasPrims: boolean;
  /** Raster coverage contributes (hard tests must use the grid). */
  hasRaster: boolean;
}

/** Policies of the reserved dynamic classes. */
export interface Dynamic {
  labelLabels: AvoidW;
  labelItems: AvoidW;
  /** Labels vs. the marks of items of lower priority key (`avoid.label.lower_items`, else `items`). */
  labelLower: AvoidW;
  labelEdge: AvoidW;
  leaderLeaders: AvoidW;
  leaderLabels: AvoidW;
  leaderItems: AvoidW;
  /** Leaders vs. the marks of items of lower priority key (`avoid.leader.lower_items`, else `items`). */
  leaderLower: AvoidW;
  /**
   * `avoid.label.lower_items` is given and not hard: a label covering the mark of a less
   * important item conflicts with that item's label.
   */
  lowerCover: boolean;
  bufferItems: number;
  bufferLeaders: number;
  bufferLabels: number;
  ownMark: OwnMark;
}

/**
 * The model's vector primitives that are kept as exact obstacles: their positions in
 * `model.vector` and their class indices (see {@link Obstacles.prims}).
 */
export interface PrimSource {
  vector: readonly (readonly [string, Prim])[];
  at: Int32Array;
  cls: Int32Array;
  n: number;
  extent: Rect;
}

/** Prepared static obstacles. */
export class Obstacles {
  /** {@link prims} and {@link primIndex} once built. */
  private primList: [number, Prim][] | null = null;
  private primIx: StaticIndex | null = null;
  /** {@link itemsSat} and {@link own} once built. */
  private itemsSatCache: Sat | null = null;
  private ownCache: ([GridSpec, Sat] | null)[] | null = null;

  constructor(
    public grid: GridSpec,
    public classes: Class[],
    public dynamic: Dynamic,
    /** The exact vector primitives ({@link prims}), not yet materialized. */
    private readonly primSource: PrimSource,
    /** Item marks. */
    public itemIndex: StaticIndex,
    /**
     * Cells inside item marks, when labels may overlap no mark at all (`label_items` and
     * the own-mark policy hard): quick, exact rejection of non-internal label boxes during
     * candidate generation.
     */
    public itemOcc: Occupancy | null,
    /** The item shapes (for {@link itemsSat} and {@link own}). */
    private readonly itemShapes: readonly Shape[],
    /** Computes the free space ({@link dt}, {@link seeds}, {@link seedIndex}). */
    private readonly freeSource: () => FreeSpace,
    public labelArea: Rect | null,
    public leaderArea: Rect | null,
    public indexCell: number,
    /**
     * The luma behind labels, for the `contrast` cost term (`null` without rasters, with
     * `weights.contrast` 0, or when the backdrop is uniform).
     */
    public backdrop: Backdrop | null,
    /** The region map (`null` without regions, or when the region weights are all 0). */
    public regions: RegionMap | null,
    /** The home region of every item (0 = open; all 0 without a region map). */
    public home: Uint32Array,
  ) {}

  private free: FreeSpace | null = null;

  /**
   * The distance transform of the static hard obstacles, its maxima and their index:
   * only free-space seeds of distant candidates need them, so they are computed on first
   * use (Rust `Obstacles::free_space`).
   */
  private freeSpace(): FreeSpace {
    if (this.free === null) this.free = this.freeSource();
    return this.free;
  }

  /** Distance (px) from each cell center to the nearest static hard obstacle. */
  get dt(): Float64Array {
    return this.freeSpace().dt;
  }

  /** Local maxima of the distance transform: (cell center, clearance, col, row). */
  get seeds(): Seed[] {
    return this.freeSpace().seeds;
  }

  /** Index of {@link seeds}. */
  get seedIndex(): StaticIndex {
    return this.freeSpace().seedIndex;
  }

  /**
   * Exact vector primitives (class index, primitive), in model order. Only hard classes
   * query them, so the list and its index ({@link primIndex}) are built on first use
   * (the same list and index as when built up front).
   */
  prims(): [number, Prim][] {
    let l = this.primList;
    if (l === null) {
      const src = this.primSource;
      l = [];
      for (let k = 0; k < src.n; k++) l.push([src.cls[k]!, src.vector[src.at[k]!]![1]]);
      this.primList = l;
    }
    return l;
  }

  /** Index of the bounding boxes of {@link prims} (built on first use). */
  primIndex(): StaticIndex {
    let ix = this.primIx;
    if (ix === null) {
      ix = new StaticIndex(
        this.prims().map((e) => primBbox(e[1])),
        this.primSource.extent,
        this.indexCell,
      );
      this.primIx = ix;
    }
    return ix;
  }

  /**
   * Whether some relaxable class is hard (otherwise the `soft_overlap` ladder step cannot
   * change anything: every relaxed-feasible candidate is feasible).
   */
  anyRelaxableHard(): boolean {
    return this.classes.some((c) => c.relaxable && (c.label.isHard() || c.leader.isHard()));
  }

  /**
   * Coverage of all item marks. Only soft `items` costs and buffers use it (and
   * {@link own}), so it is built on first use.
   */
  itemsSat(): Sat {
    let s = this.itemsSatCache;
    if (s === null) {
      const g = this.grid;
      const allItems = new MaskRaster(g);
      for (const sh of this.itemShapes) allItems.shape(sh);
      s = Sat.fromCoverage(g.cols, g.rows, allItems.intoCoverage());
      this.itemsSatCache = s;
    }
    return s;
  }

  /**
   * Coverage of item `i`'s own mark on a local grid aligned with {@link grid} (to exclude
   * the own mark from `items` costs); built on first use.
   */
  own(i: number): [GridSpec, Sat] {
    let all = this.ownCache;
    if (all === null) {
      all = new Array<[GridSpec, Sat] | null>(this.itemShapes.length).fill(null);
      this.ownCache = all;
    }
    let o = all[i]!;
    if (o === null) {
      const grid = this.grid;
      const cell = grid.cell;
      const sh = this.itemShapes[i]!;
      const cr = grid.cellRange(sh.bbox().inflate(cell));
      const c0 = cr[0];
      const c1 = cr[1];
      const r0 = cr[2];
      const r1 = cr[3];
      const local = new GridSpec(grid.ox + c0 * cell, grid.oy + r0 * cell, cell, c1 - c0 > 1 ? c1 - c0 : 1, r1 - r0 > 1 ? r1 - r0 : 1);
      const m = new MaskRaster(local);
      m.shape(sh);
      o = [local, Sat.fromCoverage(local.cols, local.rows, m.intoCoverage())];
      all[i] = o;
    }
    return o;
  }

  /** Covered area (px²) of `r` by the mark of item `j`. */
  ownCovered(j: number, r: Rect): number {
    const own = this.own(j);
    return own[1].coveredArea(own[0], r);
  }

  /** Covered area (px²) of `r` by the marks of all items except `i`. */
  otherItemsCovered(i: number, r: Rect): number {
    const all = this.itemsSat().coveredArea(this.grid, r);
    if (all <= 0) return 0;
    const own = this.own(i);
    return maxf(all - own[1].coveredArea(own[0], r), 0);
  }

  /**
   * Mean class coverage (0..1) sampled along segment `ab` once per cell length, times the
   * length.
   */
  coveredLen(sat: Sat, a: P, b: P): number {
    const len = a.dist(b);
    if (len <= 0 || !sat.nonempty) return 0;
    const g = this.grid;
    const step = g.cell;
    const nc = toIndex(Math.ceil(len / step));
    const n = nc > 1 ? nc : 1;
    // only the samples that can fall on the grid (the others never count; the margin of
    // one cell absorbs rounding)
    const area = new Rect(g.ox, g.oy, g.ox + g.cols * step, g.oy + g.rows * step).inflate(step);
    const [k0, k1] = sampleRangeInRect(a, b, n, area);
    let acc = 0;
    for (let k = k0; k < k1; k++) {
      const t = (k + 0.5) / n;
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      const u = (px - g.ox) / g.cell;
      const v = (py - g.oy) / g.cell;
      if (u >= 0 && v >= 0 && u < g.cols && v < g.rows) acc += sat.cell(toIndex(u), toIndex(v)) / 255;
    }
    return (acc * len) / n;
  }
}

/**
 * Most grid cells (spec §4.1): enough for any practical canvas, and SAT sums of `u8`
 * coverage stay exact (below 2³² / 255 ≈ 16.8 M cells).
 */
export const MAX_GRID_CELLS = 16_000_000;

/** Number of cells of the grid covering the model extent with cell size `c`. */
export function gridCells(model: Model, c: number): number {
  return maxf(Math.ceil(model.extent.w() / c), 1) * maxf(Math.ceil(model.extent.h() / c), 1);
}

/**
 * Choose the grid cell size (spec §4.1): `solver.grid_cell`, else `clamp(min_font / 4,
 * 1, 4)` grown (by factors of 1.25) until the grid has at most {@link MAX_GRID_CELLS}
 * cells. The extent must be finite; an explicit cell size may exceed the cell limit
 * (checked by the caller).
 */
export function gridCell(model: Model, minFont: number): number {
  const explicit = model.gridCell;
  if (explicit !== null && explicit > 0) return explicit;
  let c = clampf(minFont / 4, 1, 4);
  if (gridCells(model, c) > MAX_GRID_CELLS) {
    c = maxf(c, Math.sqrt((model.extent.w() * model.extent.h()) / MAX_GRID_CELLS));
    while (gridCells(model, c) > MAX_GRID_CELLS) c *= 1.25;
  }
  return c;
}

export function prepare(model: Model, minFont: number): Obstacles {
  const cell = gridCell(model, minFont);
  const grid = GridSpec.covering(model.extent, cell);
  // class names
  const nameSet = new Set<string>();
  const vector = model.vector;
  for (let k = 0; k < vector.length; k++) nameSet.add(vector[k]![0]);
  const rasterCov: [string, Uint8Array][] = [];
  const rgrid = { originX: grid.ox, originY: grid.oy, cell: grid.cell, cols: grid.cols, rows: grid.rows };
  for (const r of model.rasters) {
    const place = { scale: r.opts.scale, offset: [r.opts.offset.x, r.opts.offset.y] as const };
    for (const cc of rasterProcess(r.img, r.opts.mode, r.opts.class, place, rgrid)) {
      if (cc.class !== "ignore" && cc.coverage.length === grid.cells()) {
        nameSet.add(cc.class);
        rasterCov.push([cc.class, cc.coverage]);
      }
    }
  }
  let backdrop: Backdrop | null = null;
  if (model.weights.contrast > 0 && model.rasters.length > 0) {
    const bg = Backdrop.gridOf(grid);
    const layers = model.rasters.map(
      (r) => [r.img, { scale: r.opts.scale, offset: [r.opts.offset.x, r.opts.offset.y] as const }] as const,
    );
    const bgrid = { originX: bg.ox, originY: bg.oy, cell: bg.cell, cols: bg.cols, rows: bg.rows };
    backdrop = Backdrop.of(bg, backdropLuma(layers, model.background, bgrid));
  }
  // the region map and the home of every item (spec §4.8)
  const w = model.weights;
  const regions = w.straddle > 0 || w.foreign > 0 || w.leaderBorders > 0 ? RegionMap.of(grid, model.regionFills) : null;
  const home = new Uint32Array(model.items.length);
  if (regions !== null) {
    model.items.forEach((it, i) => {
      const r = it.region === null ? undefined : model.regionIds.get(it.region);
      home[i] = r !== undefined ? r : regions.home(it.shape.reference(), it.shape.bbox());
    });
  }
  for (const k of ["ignore", "items", "labels", "leaders", "canvas_edge"]) nameSet.delete(k);
  const names = Array.from(nameSet).sort(cmpStr);
  const pol = (map: Record<string, unknown>, k: string): AvoidW =>
    AvoidW.parse(get(map, k)) ?? AvoidW.parse(get(map, "*")) ?? AvoidW.soft(1);
  const buf = (k: string): number => asF64(get(model.avoidBuffer, k)) ?? 0;
  const classes: Class[] = names.map((n) => ({
    name: n,
    label: pol(model.avoidLabel, n),
    leader: pol(model.avoidLeader, n),
    buffer: buf(n),
    relaxable: model.relaxable.includes(n),
    sat: null,
    hasPrims: false,
    hasRaster: false,
  }));
  const classIndex = new Map<string, number>();
  names.forEach((n, i) => classIndex.set(n, i));
  // rasterize vector primitives per class into masks, collect exact prims
  const masks: (MaskRaster | null)[] = classes.map(() => null);
  // the exact primitives, as positions in `vector` (materialized on demand)
  const primAt = new Int32Array(vector.length);
  const primCls = new Int32Array(vector.length);
  let nPrims = 0;
  for (let k = 0; k < vector.length; k++) {
    const e = vector[k]!;
    const prim = e[1];
    const ci = classIndex.get(e[0]);
    if (ci === undefined) continue;
    const c = classes[ci]!;
    if (c.label.isIgnore() && c.leader.isIgnore() && c.buffer === 0) continue;
    let m = masks[ci]!;
    if (m === null) {
      m = new MaskRaster(grid);
      masks[ci] = m;
    }
    rasterizePrim(m, prim);
    primAt[nPrims] = k;
    primCls[nPrims] = ci;
    nPrims++;
  }
  masks.forEach((m, ci) => {
    if (m !== null) {
      classes[ci]!.hasPrims = true;
      classes[ci]!.sat = Sat.fromCoverage(grid.cols, grid.rows, m.intoCoverage());
    }
  });
  // merge raster coverage (max with vector coverage)
  for (const [cname, cov] of rasterCov) {
    const ci = classIndex.get(cname);
    if (ci === undefined) continue;
    const cl = classes[ci]!;
    cl.hasRaster = true;
    let merged: Uint8Array;
    const s = cl.sat;
    if (s !== null) {
      merged = new Uint8Array(grid.cells());
      for (let i = 0; i < merged.length; i++) {
        const a = s.cell(i % grid.cols, Math.trunc(i / grid.cols));
        const b = cov[i]!;
        merged[i] = a > b ? a : b;
      }
    } else merged = cov;
    cl.sat = Sat.fromCoverage(grid.cols, grid.rows, merged);
  }
  // dynamic/reserved policies
  const om = get(model.avoidLabel, "own_mark");
  let ownMark: OwnMark = { kind: "hard" };
  if (om === "ignore") ownMark = { kind: "ignore" };
  else if (typeof om === "string" && om.startsWith("partial:")) ownMark = { kind: "partial", f: parseRustF64(om.slice(8)) ?? 0 };
  // lower_items: the policy for the marks of less important items, `items` when not given
  const lower = (map: Record<string, unknown>): AvoidW => AvoidW.parse(get(map, "lower_items")) ?? pol(map, "items");
  const lowerGiven = AvoidW.parse(get(model.avoidLabel, "lower_items"));
  const dynamic: Dynamic = {
    labelLabels: pol(model.avoidLabel, "labels"),
    labelItems: pol(model.avoidLabel, "items"),
    labelLower: lower(model.avoidLabel),
    labelEdge: model.labelArea !== null ? pol(model.avoidLabel, "canvas_edge") : AvoidW.IGNORE,
    leaderLeaders: pol(model.avoidLeader, "leaders"),
    leaderLabels: pol(model.avoidLeader, "labels"),
    leaderItems: pol(model.avoidLeader, "items"),
    leaderLower: lower(model.avoidLeader),
    lowerCover: lowerGiven !== null && !lowerGiven.isHard(),
    bufferItems: buf("items"),
    bufferLeaders: buf("leaders"),
    bufferLabels: buf("labels"),
    ownMark,
  };
  // indexes
  const nItems = model.items.length > 1 ? model.items.length : 1;
  const extArea = maxf(model.extent.area(), 1);
  const indexCell = clampf(Math.sqrt(extArea / nItems), 16, 128);
  const itemIndex = new StaticIndex(
    model.items.map((it) => it.shape.bbox()),
    model.extent,
    indexCell,
  );
  // items coverage (global and per item): Obstacles.itemsSat and Obstacles.own, on demand
  let itemOcc: Occupancy | null = null;
  if (dynamic.labelItems.isHard() && dynamic.labelLower.isHard() && dynamic.ownMark.kind === "hard") {
    const occ = new Occupancy(model.extent);
    for (const it of model.items) occ.markShape(it.shape);
    // static from here on: O(1) window queries
    occ.freeze();
    itemOcc = occ.isEmpty() ? null : occ;
  }
  // distance transform of static hard obstacles (incl. items and outside the label area),
  // computed on first use
  const freeSource = (): FreeSpace => freeSpace(model, grid, classes, dynamic, indexCell, regions);
  return new Obstacles(
    grid,
    classes,
    dynamic,
    { vector, at: primAt, cls: primCls, n: nPrims, extent: model.extent },
    itemIndex,
    itemOcc,
    model.items.map((it) => it.shape),
    freeSource,
    model.labelArea,
    model.leaderArea,
    indexCell,
    backdrop,
    regions,
    home,
  );
}

/** The distance transform, its maxima and their index (Rust `free_space`). */
interface FreeSpace {
  dt: Float64Array;
  seeds: Seed[];
  seedIndex: StaticIndex;
}

function freeSpace(
  model: Model,
  grid: GridSpec,
  classes: Class[],
  dynamic: Dynamic,
  indexCell: number,
  regions: RegionMap | null,
): FreeSpace {
  const hardMask = new MaskRaster(grid);
  if (dynamic.labelItems.isHard()) for (const it of model.items) hardMask.shape(it.shape);
  const hardCov = hardMask.intoCoverage();
  const hardSats: Sat[] = [];
  for (const c of classes) if (c.label.isHard() && c.sat !== null) hardSats.push(c.sat);
  const la = model.labelArea;
  const cols = grid.cols;
  // on a region map, the free space is the open space (spec §4.8): seeds lie in the sea
  const ids = regions !== null ? regions.ids : null;
  const dt = distanceTransform(grid, (i) => {
    if (hardCov[i]! > 0 || (ids !== null && ids[i] !== 0)) return true;
    const c = i % cols;
    const r = Math.trunc(i / cols);
    for (let k = 0; k < hardSats.length; k++) if (hardSats[k]!.cell(c, r) > 0) return true;
    if (la === null) return false;
    // !la.contains_point(grid.cell_center(c, r))
    const x = grid.ox + (c + 0.5) * grid.cell;
    const y = grid.oy + (r + 0.5) * grid.cell;
    return !(x >= la.x0 && x <= la.x1 && y >= la.y0 && y <= la.y1);
  });
  const seeds = dtMaxima(grid, dt, model.defaultEm * 0.4);
  const seedIndex = new StaticIndex(
    seeds.map((s) => Rect.fromCenter(s[0], 0, 0)),
    model.extent,
    indexCell * 2,
  );
  return { dt, seeds, seedIndex };
}

function rasterizePrim(m: MaskRaster, p: Prim): void {
  switch (p.kind) {
    case "disc":
      m.disc(p.c, p.r);
      break;
    case "rect":
      m.rect(p.rect.x0, p.rect.y0, p.rect.x1, p.rect.y1);
      break;
    case "polygon":
      m.polygon(p.rings, p.evenOdd);
      break;
    case "polyline": {
      const pts = p.points;
      const n = pts.length;
      if (n === 1) m.disc(pts[0]!, p.hw);
      for (let i = 0; i + 1 < n; i++) m.capsule(pts[i]!, pts[i + 1]!, p.hw);
      if (p.closed && n > 2) m.capsule(pts[n - 1]!, pts[0]!, p.hw);
      break;
    }
    case "shape":
      m.shape(p.shape);
      break;
  }
}

/** `Prim::overlaps_rect`: the open rectangle overlaps the primitive's interior. */
export function primOverlapsRect(p: Prim, r: Rect): boolean {
  switch (p.kind) {
    case "disc": {
      const c = p.c;
      if (p.r <= EPS) {
        // r.inflate(-EPS).contains_point(c)
        const d = -EPS;
        return c.x >= r.x0 - d && c.x <= r.x1 + d && c.y >= r.y0 - d && c.y <= r.y1 + d;
      }
      return rectDistPointXY(r.x0, r.y0, r.x1, r.y1, c.x, c.y) < p.r - EPS;
    }
    case "rect":
      return p.rect.overlaps(r);
    case "polygon":
      return polygon.overlapsRect(p.rings, p.evenOdd, p.bbox, r);
    case "polyline": {
      const pts = p.points;
      const n = pts.length;
      const hw = p.hw;
      const segs = (n > 0 ? n - 1 : 0) + (p.closed && n > 2 ? 1 : 0);
      for (let i = 0; i < segs; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % n]!;
        if (hw <= EPS) {
          if (segOverlapsRectXY(a.x, a.y, b.x, b.y, r.x0, r.y0, r.x1, r.y1)) return true;
        } else if (distSegRectXY(a.x, a.y, b.x, b.y, r.x0, r.y0, r.x1, r.y1) < hw - EPS) return true;
      }
      return n === 1 && r.distPoint(pts[0]!) < hw - EPS;
    }
    case "shape":
      return p.shape.overlapsRect(r);
  }
}

/** `Prim::dist_segment`: distance between segment `ab` and the primitive (0 if they intersect). */
export function primDistSegment(p: Prim, a: P, b: P): number {
  switch (p.kind) {
    case "disc":
      return maxf(distPointSegXY(p.c.x, p.c.y, a.x, a.y, b.x, b.y) - p.r, 0);
    case "rect":
      return distSegRectXY(a.x, a.y, b.x, b.y, p.rect.x0, p.rect.y0, p.rect.x1, p.rect.y1);
    case "polygon": {
      if (polygon.containsXY(p.rings, p.evenOdd, a.x, a.y) || polygon.containsXY(p.rings, p.evenOdd, b.x, b.y)) return 0;
      let m = Infinity;
      for (const ring of p.rings) {
        const n = ring.length;
        for (let i = 0; i < n; i++) {
          const q = ring[i]!;
          const s = ring[(i + 1) % n]!;
          m = minf(m, segSegDistXY(a.x, a.y, b.x, b.y, q.x, q.y, s.x, s.y));
        }
      }
      return m;
    }
    case "polyline": {
      const pts = p.points;
      const n = pts.length;
      const segs = (n > 0 ? n - 1 : 0) + (p.closed && n > 2 ? 1 : 0);
      let m = Infinity;
      for (let i = 0; i < segs; i++) {
        const q = pts[i]!;
        const s = pts[(i + 1) % n]!;
        m = minf(m, segSegDistXY(a.x, a.y, b.x, b.y, q.x, q.y, s.x, s.y));
      }
      if (n === 1) m = distPointSegXY(pts[0]!.x, pts[0]!.y, a.x, a.y, b.x, b.y);
      return maxf(m - p.hw, 0);
    }
    case "shape":
      return p.shape.distSegment(a, b);
  }
}
