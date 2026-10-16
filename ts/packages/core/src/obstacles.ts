/**
 * Obstacle preparation (spec §4): class policies, coverage grids with SATs, exact
 * primitive indexes and the distance transform of the static hard classes; port of
 * `rust/crates/la-core/src/obstacles.rs`.
 *
 * @module
 */

import { process as rasterProcess } from "@label-anything/raster";
import {
  EPS,
  P,
  Rect,
  distPointSegXY,
  distSegRectXY,
  rectDistPointXY,
  segOverlapsRectXY,
  segSegDistXY,
} from "./geom/index.js";
import * as polygon from "./geom/polygon.js";
import { GridSpec, Sat } from "./grid/index.js";
import { distanceTransform, dtMaxima, type Seed } from "./grid/dt.js";
import { Occupancy } from "./grid/occupancy.js";
import { MaskRaster } from "./grid/raster.js";
import { asF64, get } from "./json.js";
import { clampf, cmpStr, maxf, minf, toIndex } from "./math.js";
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
  labelEdge: AvoidW;
  leaderLeaders: AvoidW;
  leaderLabels: AvoidW;
  leaderItems: AvoidW;
  bufferItems: number;
  bufferLeaders: number;
  bufferLabels: number;
  ownMark: OwnMark;
}

/** Prepared static obstacles. */
export class Obstacles {
  constructor(
    public grid: GridSpec,
    public classes: Class[],
    public dynamic: Dynamic,
    /** Exact vector primitives (class index, primitive). */
    public prims: [number, Prim][],
    public primIndex: StaticIndex,
    /** Item marks. */
    public itemIndex: StaticIndex,
    /**
     * Cells inside item marks, when labels may overlap no mark at all (`label_items` and
     * the own-mark policy hard): quick, exact rejection of non-internal label boxes during
     * candidate generation.
     */
    public itemOcc: Occupancy | null,
    /**
     * Coverage of all item marks, and of each item's own mark on an aligned local grid
     * (to exclude the own mark from `items` costs).
     */
    public itemsSat: Sat,
    public own: [GridSpec, Sat][],
    /** Distance (px) from each cell center to the nearest static hard obstacle. */
    public dt: Float64Array,
    /** Local maxima of the distance transform: (cell center, clearance, col, row). */
    public seeds: Seed[],
    public seedIndex: StaticIndex,
    public labelArea: Rect | null,
    public leaderArea: Rect | null,
    public indexCell: number,
  ) {}

  /**
   * Whether some relaxable class is hard (otherwise the `soft_overlap` ladder step cannot
   * change anything: every relaxed-feasible candidate is feasible).
   */
  anyRelaxableHard(): boolean {
    return this.classes.some((c) => c.relaxable && (c.label.isHard() || c.leader.isHard()));
  }

  /** Covered area (px²) of `r` by the marks of all items except `i`. */
  otherItemsCovered(i: number, r: Rect): number {
    const all = this.itemsSat.coveredArea(this.grid, r);
    if (all <= 0) return 0;
    const own = this.own[i]!;
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
    let acc = 0;
    for (let k = 0; k < n; k++) {
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

/** Choose the grid cell size (spec §4.1). */
export function gridCell(model: Model, minFont: number): number {
  const c = model.gridCell;
  if (c !== null && c > 0) return c;
  return clampf(minFont / 4, 1, 4);
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
  const prims: [number, Prim][] = [];
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
    prims.push([ci, prim]);
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
  const dynamic: Dynamic = {
    labelLabels: pol(model.avoidLabel, "labels"),
    labelItems: pol(model.avoidLabel, "items"),
    labelEdge: model.labelArea !== null ? pol(model.avoidLabel, "canvas_edge") : AvoidW.IGNORE,
    leaderLeaders: pol(model.avoidLeader, "leaders"),
    leaderLabels: pol(model.avoidLeader, "labels"),
    leaderItems: pol(model.avoidLeader, "items"),
    bufferItems: buf("items"),
    bufferLeaders: buf("leaders"),
    bufferLabels: buf("labels"),
    ownMark,
  };
  // indexes
  const nItems = model.items.length > 1 ? model.items.length : 1;
  const extArea = maxf(model.extent.area(), 1);
  const indexCell = clampf(Math.sqrt(extArea / nItems), 16, 128);
  const primIndex = new StaticIndex(
    prims.map((e) => primBbox(e[1])),
    model.extent,
    indexCell,
  );
  const itemIndex = new StaticIndex(
    model.items.map((it) => it.shape.bbox()),
    model.extent,
    indexCell,
  );
  // items coverage (global and per item)
  const allItems = new MaskRaster(grid);
  const own: [GridSpec, Sat][] = [];
  for (const it of model.items) {
    allItems.shape(it.shape);
    const cr = grid.cellRange(it.shape.bbox().inflate(cell));
    const c0 = cr[0];
    const c1 = cr[1];
    const r0 = cr[2];
    const r1 = cr[3];
    const local = new GridSpec(grid.ox + c0 * cell, grid.oy + r0 * cell, cell, c1 - c0 > 1 ? c1 - c0 : 1, r1 - r0 > 1 ? r1 - r0 : 1);
    const m = new MaskRaster(local);
    m.shape(it.shape);
    own.push([local, Sat.fromCoverage(local.cols, local.rows, m.intoCoverage())]);
  }
  const itemsSat = Sat.fromCoverage(grid.cols, grid.rows, allItems.intoCoverage());
  let itemOcc: Occupancy | null = null;
  if (dynamic.labelItems.isHard() && dynamic.ownMark.kind === "hard") {
    const occ = new Occupancy(model.extent);
    for (const it of model.items) occ.markShape(it.shape);
    // static from here on: O(1) window queries
    occ.freeze();
    itemOcc = occ.isEmpty() ? null : occ;
  }
  // distance transform of static hard obstacles (incl. items and outside the label area)
  const hardMask = new MaskRaster(grid);
  if (dynamic.labelItems.isHard()) for (const it of model.items) hardMask.shape(it.shape);
  const hardCov = hardMask.intoCoverage();
  const hardSats: Sat[] = [];
  for (const c of classes) if (c.label.isHard() && c.sat !== null) hardSats.push(c.sat);
  const la = model.labelArea;
  const cols = grid.cols;
  const dt = distanceTransform(grid, (i) => {
    if (hardCov[i]! > 0) return true;
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
  return new Obstacles(
    grid,
    classes,
    dynamic,
    prims,
    primIndex,
    itemIndex,
    itemOcc,
    itemsSat,
    own,
    dt,
    seeds,
    seedIndex,
    model.labelArea,
    model.leaderArea,
    indexCell,
  );
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
