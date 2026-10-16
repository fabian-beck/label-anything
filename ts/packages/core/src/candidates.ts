/**
 * Candidate generation (spec §6): adjacent, slider, internal (distant and boundary
 * candidates live in `leaders.ts` / `boundary.ts`); port of
 * `rust/crates/la-core/src/candidates.rs`.
 *
 * @module
 */

import { P, Rect, bboxOf, distPointSeg } from "./geom/index.js";
import { polylabel } from "./geom/polygon.js";
import { Shape, shapesOverlap, signDir } from "./geom/shape.js";
import type { Variant } from "./labels.js";
import { cmpF64, maxf, minf, sinCosDeg } from "./math.js";
import {
  InternalPolicy,
  type Item,
  type LabelShape,
  type LeaderStyle,
  type Model,
  Models,
  type Pos,
  LeaderStyle as LS,
  posAngularIndex,
  posFromAngularIndex,
  posName,
  remEuclid,
} from "./model/index.js";
import { leaderStart } from "./leaders.js";

/** Candidate model. */
export const Kind = { Adjacent: 0, Slider: 1, Internal: 2, Distant: 3, Boundary: 4 } as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

const KIND_NAMES = ["adjacent", "slider", "internal", "distant", "boundary"] as const;

/** `Kind::name`. */
export function kindName(k: Kind): string {
  return KIND_NAMES[k];
}

/**
 * Reported anchor side (Rust `enum Side`): a {@link Pos} (0–7), or one of
 * {@link SIDE_INTERNAL}, {@link SIDE_DISTANT}, {@link SIDE_BOUNDARY}.
 */
export type Side = number;
export const SIDE_INTERNAL: Side = 8;
export const SIDE_DISTANT: Side = 9;
export const SIDE_BOUNDARY: Side = 10;

/** `Side::name`. */
export function sideName(s: Side): string {
  if (s === SIDE_INTERNAL) return "internal";
  if (s === SIDE_DISTANT) return "distant";
  if (s === SIDE_BOUNDARY) return "boundary";
  return posName(s as Pos);
}

/**
 * Why a candidate is infeasible (Rust `enum Block`): a static obstacle class index (≥ 0)
 * or one of the reserved negative codes.
 */
export type Block = number;
export const BLOCK_EDGE: Block = -1;
export const BLOCK_ITEMS: Block = -2;
export const BLOCK_LABELS: Block = -3;
export const BLOCK_LEADERS: Block = -4;

/** A leader polyline from the item to the label's port. */
export class Leader {
  /** From the item (boundary + gap, or tip) to the port. */
  pts: P[];
  port: P;
  style: LeaderStyle;
  bends: number;
  len: number;
  /** Underline below the first text line (port = baseline). */
  underline: [P, P] | null = null;
  /** Quadratic Bézier control points for curved leaders: (start, control, end). */
  curve: [P, P, P] | null = null;
  /** For fan leaders: which member the leader points to. */
  member: number | null = null;

  constructor(pts: P[], style: LeaderStyle) {
    let len = 0;
    for (let i = 0; i + 1 < pts.length; i++) len += pts[i]!.dist(pts[i + 1]!);
    this.pts = pts;
    this.port = pts.length > 0 ? pts[pts.length - 1]! : new P(0, 0);
    this.style = style;
    this.bends = pts.length > 2 ? (pts.length - 2) & 0xff : 0;
    this.len = len;
  }

  /** Number of segments including the underline. */
  segCount(): number {
    return (this.pts.length > 0 ? this.pts.length - 1 : 0) + (this.underline !== null ? 1 : 0);
  }

  /** Start of segment `k` (see {@link segCount}). */
  segA(k: number): P {
    return k < this.pts.length - 1 ? this.pts[k]! : this.underline![0];
  }

  /** End of segment `k`. */
  segB(k: number): P {
    return k < this.pts.length - 1 ? this.pts[k + 1]! : this.underline![1];
  }

  /** Segments including the underline. */
  segments(): [P, P][] {
    const out: [P, P][] = [];
    for (let k = 0; k < this.segCount(); k++) out.push([this.segA(k), this.segB(k)]);
    return out;
  }

  bbox(): Rect {
    let r = bboxOf(this.pts);
    if (this.underline !== null) r = r.addPoint(this.underline[0]).addPoint(this.underline[1]);
    return r;
  }
}

/** A label candidate. */
export class Cand {
  leaders: Leader[] = [];
  /** Static cost (valid when `feasible` or `relaxed`). */
  cost = 0;
  /** Statically feasible under the strict policy. */
  feasible = true;
  /**
   * Feasible when the relaxable classes are relaxed (soft_overlap); `relaxCost` is the
   * extra cost then.
   */
  relaxed = true;
  relaxCost = 0;
  /** The first hard constraint that rejected the candidate. */
  blocked: Block | null = null;
  /**
   * Static cost and feasibility are computed (ladder candidates are evaluated lazily, only
   * once they are free of placed labels).
   */
  evaluated = false;
  /** Boundary side (0 left, 1 right, 2 top, 3 bottom) of boundary candidates. */
  bside = 255;
  /**
   * Exact label shape for non-rectangular labels (icons with circle, rounded or polygon
   * shapes); null = the box itself.
   */
  lshape: Shape | null = null;

  constructor(
    public item: number,
    public variant: number,
    public level: number,
    public kind: Kind,
    public side: Side,
    /** Position rank (cost term `w_position · rank / 8`). */
    public rank: number,
    public rect: Rect,
  ) {}

  /** Bounding box of label and leaders. */
  bbox(): Rect {
    let r = this.rect;
    for (const l of this.leaders) r = r.union(l.bbox());
    return r;
  }

  /** Interiors of the two labels overlap (exact for non-rectangular labels). */
  labelOverlaps(other: Cand): boolean {
    if (!this.rect.overlaps(other.rect)) return false;
    const a = this.lshape;
    const b = other.lshape;
    if (a === null) return b === null ? true : b.overlapsRect(this.rect);
    return b === null ? a.overlapsRect(other.rect) : shapesOverlap(a, b);
  }

  /** The label's interior overlaps shape `s`. */
  labelOverlapsShape(s: Shape): boolean {
    return this.lshape === null ? s.overlapsRect(this.rect) : shapesOverlap(this.lshape, s);
  }

  /** A shallow copy with its own leader list (Rust `Clone`; leaders are not mutated). */
  clone(): Cand {
    const c = new Cand(this.item, this.variant, this.level, this.kind, this.side, this.rank, this.rect);
    c.leaders = this.leaders.slice();
    c.cost = this.cost;
    c.feasible = this.feasible;
    c.relaxed = this.relaxed;
    c.relaxCost = this.relaxCost;
    c.blocked = this.blocked;
    c.evaluated = this.evaluated;
    c.bside = this.bside;
    c.lshape = this.lshape;
    return c;
  }
}

/** Whether labels of this shape are their box ({@link labelShape} gives null). */
export function isRectShape(shape: LabelShape): boolean {
  switch (shape.kind) {
    case "rect":
      return true;
    case "rounded":
      return shape.r <= 0;
    case "circle":
      return false;
    case "polygon":
      return shape.pts.length < 3;
  }
}

/** The exact shape of a label box with the given label shape (null for rectangles). */
export function labelShape(rect: Rect, shape: LabelShape): Shape | null {
  switch (shape.kind) {
    case "rect":
      return null;
    case "rounded":
      return shape.r <= 0 ? null : Shape.rect(rect.center(), rect.w(), rect.h(), shape.r, 0);
    case "circle":
      return Shape.circle(rect.center(), minf(rect.w(), rect.h()) * 0.5);
    case "polygon": {
      if (shape.pts.length < 3) return null;
      const o = new P(rect.x0, rect.y0);
      return Shape.polygon([shape.pts.map((q) => q.add(o))], false, rect.center());
    }
  }
}

/** Screen direction for an angle in degrees (counter-clockwise on screen, 0 = right). */
export function dirOf(angleDeg: number): P {
  const [s, c] = sinCosDeg(angleDeg);
  return new P(c, -s);
}

/** Label center touching `S ⊕ o` in direction `d` (spec §6.1). */
export function touchCenter(shape: Shape, o: number, d: P, hw: number, hh: number): P {
  const s = shape.supportInflated(d, o);
  const [sx, sy] = signDir(d);
  return new P(s.x + sx * hw, s.y + sy * hh);
}

/**
 * For concave polygons, labels placed against the convex hull are pushed toward the true
 * shape until they touch it (spec §4.5 rule 1: "a final push-out so the label clears the
 * inflated shape exactly").
 */
export function pushIn(shape: Shape, o: number, c: P, hw: number, hh: number): P {
  if (shape.kind !== "polygon") return c;
  const p = shape.poly;
  if (p.rings.length === 1 && p.rings[0]!.length === p.hull.length) return c; // convex
  const gap = shape.distRect(Rect.fromCenter(c, hw, hh)) - o;
  if (gap <= 0.25) return c;
  const d = c.sub(shape.reference()).norm();
  if (d.len2() === 0) return c;
  let lo = 0;
  let hi = gap + maxf(hw, hh);
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) * 0.5;
    const r = Rect.fromCenter(c.sub(d.mul(mid)), hw, hh);
    if (shape.distRect(r) >= o - 1e-9 && !shape.overlapsRect(r)) lo = mid;
    else hi = mid;
  }
  return c.sub(d.mul(lo));
}

/**
 * The warm-start box of an item as a candidate of variant `vi` (whose size must match),
 * so that an unchanged position costs no stability penalty (spec §8): a slider-kind
 * candidate on the side its center points to when it touches the inflated mark (gap ≤
 * offset + 1 px), else a distant candidate with a straight leader (straight style only,
 * within the leader length limits). Null when neither applies.
 */
export function warm(model: Model, item: Item, vi: number, v: Variant, rect: Rect): Cand | null {
  const it = item.index;
  const gap = item.shape.distRect(rect);
  if (gap < -1e-6 || item.shape.overlapsRect(rect)) return null; // on the own mark: internal candidates cover that
  const refp = item.shape.reference();
  if (gap <= item.len.offset + 1) {
    const d = rect.center().sub(refp);
    if (d.len2() === 0) return null;
    // nearest of the item's allowed positions by direction
    let bestDot = 0;
    let bestPos: Pos | null = null;
    let bestRank = 0;
    for (let rank = 0; rank < item.positions.length; rank++) {
      const p = item.positions[rank]!;
      const pd = POS_DIRS[posAngularIndex(p)]!;
      const dot = (pd.x * d.x + pd.y * d.y) / Math.sqrt(d.len2());
      if (bestPos === null || dot > bestDot) {
        bestDot = dot;
        bestPos = p;
        bestRank = rank;
      }
    }
    if (bestPos === null) return null;
    return new Cand(it, vi, v.level, Kind.Slider, bestPos, bestRank + 0.25, rect);
  }
  if (model.leaders.style !== LS.Straight) return null;
  const port0 = rect.closestPoint(refp);
  const start = leaderStart(model, item, port0);
  const port = rect.closestPoint(start);
  const l = new Leader([start, port], model.leaders.style);
  if (l.len < item.len.leaderMin || l.len > item.len.leaderMax + 1e-9) return null;
  const c = new Cand(it, vi, v.level, Kind.Distant, SIDE_DISTANT, 8, rect);
  c.leaders.push(l);
  return c;
}

/** Adjacent and slider candidates of one variant. */
export function adjacent(item: Item, vi: number, v: Variant, sliderPerGap: number, models: Models, out: Cand[]): void {
  const hw = v.w * 0.5;
  const hh = v.h * 0.5;
  const o = item.len.offset;
  const shape = item.shape;
  const positions = item.positions;
  const rankOf = (p: Pos): number | null => {
    const r = positions.indexOf(p);
    return r < 0 ? null : r;
  };
  const it = item.index;
  if (Models.has(models, Models.ADJACENT)) {
    positions.forEach((p, r) => {
      const d = POS_DIRS[posAngularIndex(p)]!;
      const c = pushIn(shape, o, touchCenter(shape, o, d, hw, hh), hw, hh);
      out.push(new Cand(it, vi, v.level, Kind.Adjacent, p, r, Rect.fromCenter(c, hw, hh)));
    });
  }
  if (!Models.has(models, Models.SLIDER) || sliderPerGap === 0) return;
  for (let k = 0; k < 8; k++) {
    const a = posFromAngularIndex(k);
    const b = posFromAngularIndex(k + 1);
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra === null || rb === null) continue;
    const path = cspacePath(shape, o, hw, hh, k);
    const samples = samplePath(path, sliderPerGap, shape, o, hw, hh);
    for (let j = 0; j < samples.length; j++) {
      const t = (j + 1) / (sliderPerGap + 1);
      const rank = ra + (rb - ra) * t + 0.25;
      const side = t < 0.5 ? a : b;
      const c = pushIn(shape, o, samples[j]!, hw, hh);
      out.push(new Cand(it, vi, v.level, Kind.Slider, side, rank, Rect.fromCenter(c, hw, hh)));
    }
  }
}

/**
 * A vertex of the configuration-space boundary: position, angle, and whether the segment
 * to the next vertex is straight (exact) or curved (re-evaluate by angle).
 */
export interface CVertex {
  p: P;
  phi: number;
  straightNext: boolean;
}

const SAMPLE_STEP_DEG = 9.0;
const EPS_DEG = 1e-4;

function cAt(shape: Shape, o: number, hw: number, hh: number, phi: number): P {
  return touchCenter(shape, o, dirOf(phi), hw, hh);
}

function isAxis(phi: number): boolean {
  const r = remEuclid(phi, 90);
  return r < 1e-9 || 90 - r < 1e-9;
}

/** Unit directions (`dirOf`) of the 8 fixed positions by angular index. */
const POS_DIRS: readonly P[] = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => dirOf(45 * k));

/**
 * Vertex angles of the C-space path of gap `k` (between the fixed positions `k` and
 * `k + 1` in angular order), with their directions and the directions of the angle
 * midpoints between consecutive vertices. These depend only on `k`, so the trigonometry
 * is done once.
 */
interface GapTable {
  phis: number[];
  dirs: P[];
  mids: P[];
}

let GAP_TABLES: GapTable[] | null = null;

function gapTable(k: number): GapTable {
  if (GAP_TABLES === null) {
    const tables: GapTable[] = [];
    for (let g = 0; g < 8; g++) {
      const fa = 45 * g;
      const fb = g === 7 ? 360 : 45 * (g + 1);
      const phis: number[] = [fa];
      if (isAxis(fa)) phis.push(fa + EPS_DEG);
      const nc = Math.ceil((fb - fa) / SAMPLE_STEP_DEG);
      const n = Math.trunc(nc > 1 ? nc : 1);
      for (let j = 1; j < n; j++) phis.push(fa + ((fb - fa) * j) / n);
      if (isAxis(fb)) phis.push(fb - EPS_DEG);
      phis.push(fb);
      const dirs = phis.map((phi) => dirOf(phi));
      const mids: P[] = [];
      for (let j = 0; j + 1 < phis.length; j++) mids.push(dirOf((phis[j]! + phis[j + 1]!) * 0.5));
      tables.push({ phis, dirs, mids });
    }
    GAP_TABLES = tables;
  }
  return GAP_TABLES[k]!;
}

/** Boundary of `(S ⊕ o) ⊕ (−B)` over gap `k` (between two fixed positions). */
export function cspacePath(shape: Shape, o: number, hw: number, hh: number, k: number): CVertex[] {
  const t = gapTable(k);
  const verts: CVertex[] = [];
  // table index of every kept vertex
  const idx: number[] = [];
  for (let j = 0; j < t.phis.length; j++) {
    const p = touchCenter(shape, o, t.dirs[j]!, hw, hh);
    if (verts.length > 0 && verts[verts.length - 1]!.p.dist(p) < 1e-12) continue;
    verts.push({ p, phi: t.phis[j]!, straightNext: true });
    idx.push(j);
  }
  for (let i = 0; i + 1 < verts.length; i++) {
    const a = verts[i]!;
    const b = verts[i + 1]!;
    const d = idx[i + 1] === idx[i]! + 1 ? t.mids[idx[i]!]! : dirOf((a.phi + b.phi) * 0.5);
    const mid = touchCenter(shape, o, d, hw, hh);
    a.straightNext = distPointSeg(mid, a.p, b.p) <= 1e-9;
  }
  return verts;
}

/** `k` samples at equal arc length, excluding the endpoints. */
export function samplePath(path: readonly CVertex[], k: number, shape: Shape, o: number, hw: number, hh: number): P[] {
  if (path.length < 2) return [];
  const cum = new Float64Array(path.length);
  for (let i = 1; i < path.length; i++) cum[i] = cum[i - 1]! + path[i - 1]!.p.dist(path[i]!.p);
  const total = cum[path.length - 1]!;
  if (total <= 1e-9) return [];
  const out: P[] = [];
  let seg = 0;
  for (let j = 1; j <= k; j++) {
    const target = (total * j) / (k + 1);
    while (seg + 1 < path.length - 1 && cum[seg + 1]! < target) seg += 1;
    const a = path[seg]!;
    const b = path[seg + 1]!;
    const len = cum[seg + 1]! - cum[seg]!;
    const t = len > 0 ? (target - cum[seg]!) / len : 0;
    if (a.straightNext) out.push(a.p.lerp(b.p, t));
    else out.push(cAt(shape, o, hw, hh, a.phi + (b.phi - a.phi) * t));
  }
  return out;
}

/** Whether internal candidates apply to this item, and their rank. */
export function internalRank(item: Item, v: Variant, models: Models, circleRatio: number): number | null {
  // prefer: ahead of every external position; allow: on par with the best one (the
  // distance term then favours the label that sits on its mark)
  const prefer = -1;
  const allow = 0;
  switch (item.internal) {
    case InternalPolicy.Never:
      return null;
    case InternalPolicy.Prefer:
      return prefer;
    case InternalPolicy.Allow:
      return allow;
    default: {
      if (item.area !== null) return prefer;
      if (item.tip) return null;
      const s = item.shape;
      if (s.kind === "circle") return s.r >= circleRatio * v.h || Models.has(models, Models.INTERNAL) ? allow : null;
      return prefer;
    }
  }
}

/** Internal candidates of one variant (spec §6.3, §6.5). */
export function internal(item: Item, vi: number, v: Variant, rank: number, out: Cand[]): void {
  const hw = v.w * 0.5;
  const hh = v.h * 0.5;
  const pad = item.len.innerPadding;
  const it = item.index;
  const push = (c: P): void => {
    const r = Rect.fromCenter(c, hw, hh);
    const dup = out.some((x) => x.item === it && x.variant === vi && x.kind === Kind.Internal && x.rect.eq(r));
    if (!dup) out.push(new Cand(it, vi, v.level, Kind.Internal, SIDE_INTERNAL, rank, r));
  };
  const area = item.area;
  if (area !== null) {
    const shape = area.shape;
    const pts: [number, P][] = [];
    if (shape.containsRect(Rect.fromCenter(area.pole, hw, hh), pad)) pts.push([area.poleDist, area.pole]);
    // grid samples where the label fits, by clearance
    const bb = shape.bbox();
    const step = maxf(v.h, 4);
    let y = bb.y0 + hh;
    while (y <= bb.y1 - hh + 1e-9) {
      let x = bb.x0 + hw;
      while (x <= bb.x1 - hw + 1e-9) {
        const c = new P(x, y);
        if (shape.containsRect(Rect.fromCenter(c, hw, hh), pad)) pts.push([-shape.signedDistance(c), c]);
        x += step;
      }
      y += step;
    }
    pts.sort((a, b) => cmpF64(b[0], a[0]));
    for (let i = 0; i < pts.length && i < 8; i++) push(pts[i]![1]);
    return;
  }
  const shape = item.shape;
  const centers: P[] = [shape.reference()];
  if (shape.kind === "polygon") {
    const [pole] = polylabel(shape.poly.rings, shape.poly.evenOdd, 0.5);
    centers.unshift(pole);
  } else centers.unshift(shape.bbox().center());
  for (const c of centers) {
    if (shape.containsRect(Rect.fromCenter(c, hw, hh), pad)) push(c);
  }
}
