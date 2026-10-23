/**
 * Candidate generation (spec §6): adjacent, slider, internal (distant and boundary
 * candidates live in `leaders.ts` / `boundary.ts`); port of
 * `rust/crates/la-core/src/candidates.rs`.
 *
 * @module
 */

import { EPS, P, Rect, bboxOf, distPointSegXY } from "./geom/index.js";
import { Shape, shapesOverlap } from "./geom/shape.js";
import type { Variant } from "./labels.js";
import { cmpF64, len2d, maxf, minf, signEps, sinCosDegInto } from "./math.js";
import {
  InternalPolicy,
  type Item,
  type LabelShape,
  type LeaderStyle,
  type Model,
  Models,
  type Pos,
  LeaderStyle as LS,
  Port,
  posAngularIndex,
  posFromAngularIndex,
  posName,
  remEuclid,
} from "./model/index.js";
import { type Stubs, distantDirs, leaderStart } from "./leaders.js";

/** Candidate model. */
export const Kind = { Adjacent: 0, Slider: 1, Internal: 2, Distant: 3, Boundary: 4, Fan: 5 } as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

const KIND_NAMES = ["adjacent", "slider", "internal", "distant", "boundary", "fan"] as const;

/** `Kind::name`. */
export function kindName(k: Kind): string {
  return KIND_NAMES[k];
}

/**
 * Reported anchor side (Rust `enum Side`): a {@link Pos} (0–7), or one of
 * {@link SIDE_INTERNAL}, {@link SIDE_DISTANT}, {@link SIDE_BOUNDARY}, {@link SIDE_FAN}.
 */
export type Side = number;
export const SIDE_INTERNAL: Side = 8;
export const SIDE_DISTANT: Side = 9;
export const SIDE_BOUNDARY: Side = 10;
export const SIDE_FAN: Side = 11;

/** `Side::name`. */
export function sideName(s: Side): string {
  if (s === SIDE_INTERNAL) return "internal";
  if (s === SIDE_DISTANT) return "distant";
  if (s === SIDE_BOUNDARY) return "boundary";
  if (s === SIDE_FAN) return "fan";
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
  /** A stub (spec §6.9): the short leader of an adjacent or slider label near other marks. */
  stub = false;

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

/**
 * The share of `defaults.margin` a label needs to keep its warm-start place (spec §4.4):
 * from another label that keeps its own, and from other marks. A label takes a new place
 * only with the whole margin but leaves its old one only when its neighbours come closer
 * than half of it.
 */
export const WARM_MARGIN = 0.5;

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
  /**
   * A warm-start candidate: the previous box (at any size) or a nudge of it; it keeps
   * {@link WARM_MARGIN} of the margin.
   */
  warm = false;

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

  /** Cache of {@link bbox} (computed on first use, once the leaders are complete). */
  private bb: Rect | null = null;

  /** The label has a stub (spec §6.9). */
  hasStub(): boolean {
    return this.leaders.length > 0 && this.leaders[0]!.stub;
  }

  /** Bounding box of label and leaders. */
  bbox(): Rect {
    let r = this.bb;
    if (r === null) {
      r = this.rect;
      for (const l of this.leaders) r = r.union(l.bbox());
      this.bb = r;
    }
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

  /**
   * The labels overlap or, with `gap > EPS`, their boxes come closer than `gap`
   * ({@link WARM_MARGIN} of it when both are warm-start candidates). Boxes `gap` apart up to
   * rounding (stacked columns) keep it.
   */
  labelOverlapsGap(other: Cand, gap: number): boolean {
    const g = this.warm && other.warm ? WARM_MARGIN * gap : gap;
    return g > EPS ? this.rect.distRect(other.rect) < g - EPS : this.labelOverlaps(other);
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
    c.warm = this.warm;
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
  sinCosDegInto(angleDeg, SC);
  return new P(SC[1]!, -SC[0]!);
}

/** Scratch `[sin, cos]` of {@link dirOf}. */
const SC = new Float64Array(2);

/** Output of {@link touchCenterAt}: `[x, y]`. */
const TC = new Float64Array(2);
/**
 * Inputs `[o, hw, hh]` of {@link touchCenterAt} and the C-space paths (constant per label
 * variant; in a typed array because doubles passed to calls that are not inlined are
 * boxed, one allocation each).
 */
const TC_ARGS = new Float64Array(3);

/**
 * {@link touchCenter} for the direction `d` and the offset and half sizes in
 * {@link TC_ARGS}, into {@link TC}: the operations of `supportInflated` and `signDir`,
 * without allocating for circles (the common mark).
 */
function touchCenterAt(shape: Shape, d: P): void {
  const o = TC_ARGS[0]!;
  const hw = TC_ARGS[1]!;
  const hh = TC_ARGS[2]!;
  const dx = d.x;
  const dy = d.y;
  const l = len2d(dx, dy);
  const nx = l > 0 ? dx / l : 0;
  const ny = l > 0 ? dy / l : 0;
  let px: number;
  let py: number;
  if (shape.kind === "circle") {
    px = shape.c.x + nx * shape.r;
    py = shape.c.y + ny * shape.r;
  } else {
    const p = shape.support(d);
    px = p.x;
    py = p.y;
  }
  TC[0] = px + nx * o + signEps(dx, 1e-12) * hw;
  TC[1] = py + ny * o + signEps(dy, 1e-12) * hh;
}

/** Label center touching `S ⊕ o` in direction `d` (spec §6.1). */
export function touchCenter(shape: Shape, o: number, d: P, hw: number, hh: number): P {
  TC_ARGS[0] = o;
  TC_ARGS[1] = hw;
  TC_ARGS[2] = hh;
  touchCenterAt(shape, d);
  return new P(TC[0]!, TC[1]!);
}

/** Whether {@link pushIn} can move a label (concave polygons only). */
function needsPushIn(shape: Shape): boolean {
  if (shape.kind !== "polygon") return false;
  const p = shape.poly;
  return !(p.rings.length === 1 && p.rings[0]!.length === p.hull.length);
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
 * offset + 1 px), else a distant candidate with a straight leader (straight style,
 * within the leader length limits) or with the leader it came with (see
 * {@link warmLeader}). Null when neither applies.
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
  if (model.leaders.style !== LS.Straight) return warmLeader(model, item, vi, v, rect);
  const port0 = rect.closestPoint(refp);
  const start = leaderStart(model, item, port0);
  const port = rect.closestPoint(start);
  const l = new Leader([start, port], model.leaders.style);
  if (l.len < item.len.leaderMin || l.len > item.len.leaderMax + 1e-9) return null;
  const c = new Cand(it, vi, v.level, Kind.Distant, SIDE_DISTANT, 8, rect);
  c.leaders.push(l);
  return c;
}

/** cos 0.5°: the tolerance of a warm-start leader's direction. */
const COS_HALF_DEGREE = 0.9999619230641714;

/**
 * A warm-start box away from the mark as a distant candidate with the leader it came
 * with, moved with it (`angles`, `elbow` and `orthogonal` styles): when that leader still
 * starts where the item's leaders start and ends on the box (both within 0.5 px), keeps
 * within the length limits and, for `angles` and `elbow`, leaves the item along one of
 * the allowed directions (within 0.5°). Items labeling a group take none.
 */
function warmLeader(model: Model, item: Item, vi: number, v: Variant, rect: Rect): Cand | null {
  const style = model.leaders.style;
  const pts = model.warmLeaders.get(item.id);
  if (pts === undefined || pts.length < 2 || model.groupMembers(item.index).length >= 2) return null;
  const s0 = pts[0]!;
  const port = pts[pts.length - 1]!;
  if (s0.dist(leaderStart(model, item, s0)) > 0.5) return null;
  const inside = minf(minf(minf(port.x - rect.x0, rect.x1 - port.x), port.y - rect.y0), rect.y1 - port.y);
  if (rect.distPoint(port) > 0.5 || inside > 0.5) return null;
  if (style === LS.Angles || style === LS.Elbow) {
    const d = pts[1]!.sub(s0).norm();
    if (!distantDirs(model).some(([, u]) => d.dot(u) >= COS_HALF_DEGREE)) return null;
  }
  const l = new Leader(pts.slice(), style);
  if (l.len < item.len.leaderMin || l.len > item.len.leaderMax + 1e-9) return null;
  // the `baseline` port's underline, for this variant's text (as `leaders.distant`)
  const t = v.text;
  if (model.leaders.port === Port.Baseline && style !== LS.Orthogonal && t !== null) {
    const x0 = rect.x0 + t.xOffset;
    const far = port.x <= rect.center().x ? x0 + t.widths[0]! : x0;
    l.underline = [port, new P(far, port.y)];
  }
  const c = new Cand(item.index, vi, v.level, Kind.Distant, SIDE_DISTANT, 8, rect);
  c.leaders.push(l);
  return c;
}

/**
 * Label centers along the slider paths of an item's allowed gaps (the C-space paths of
 * {@link adjacent}, whose curved stretches are followed by their chords between vertices
 * 9° apart), chained into runs of consecutive allowed gaps; a run that goes all around
 * the mark is closed (its last point is its first).
 */
function sliderRuns(item: Item, hw: number, hh: number): P[][] {
  const allowedPos = [false, false, false, false, false, false, false, false];
  for (const p of item.positions) allowedPos[posAngularIndex(p)] = true;
  const allowed = (k: number): boolean => allowedPos[k % 8]! && allowedPos[(k + 1) % 8]!;
  const shape = item.shape;
  const o = item.len.offset;
  // start after a gap that is not allowed, so that no run is split at the start
  let start = 0;
  for (let k = 0; k < 8; k++) {
    if (allowed(k) && !allowed(k + 7)) {
      start = k;
      break;
    }
  }
  const runs: P[][] = [];
  let cur: P[] = [];
  for (let j = 0; j < 8; j++) {
    const k = (start + j) % 8;
    if (!allowed(k)) {
      if (cur.length >= 2) runs.push(cur);
      cur = [];
      continue;
    }
    for (const v of cspacePath(shape, o, hw, hh, k)) {
      if (cur.length > 0 && cur[cur.length - 1]!.dist(v.p) < 1e-9) continue;
      cur.push(v.p);
    }
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

/**
 * The point `s` px (signed) along `run` from the point at parameter `t` of segment `seg`;
 * a closed run wraps around, an open one ends (null past its ends).
 */
function walkRun(run: readonly P[], seg: number, t: number, s: number): P | null {
  const n = run.length;
  const cum = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1]! + run[i - 1]!.dist(run[i]!);
  const total = cum[n - 1]!;
  if (total <= 1e-9) return null;
  const closed = run[0]!.dist(run[n - 1]!) < 1e-9;
  let target = cum[seg]! + (cum[seg + 1]! - cum[seg]!) * t + s;
  if (closed) target = remEuclid(target, total);
  else if (!(target >= 0 && target <= total)) return null;
  let i = 0;
  while (i + 2 < n && cum[i + 1]! < target) i += 1;
  const len = cum[i + 1]! - cum[i]!;
  const u = len > 0 ? (target - cum[i]!) / len : 0;
  return run[i]!.lerp(run[i + 1]!, u);
}

/**
 * Candidates of variant `vi` near a warm-start box that touches the mark: its center
 * moved `steps` px (each step forwards, then backwards) along the slider paths of the
 * item's allowed gaps, as slider candidates (spec §6.7). For a box that a small change
 * blocked: a nudge instead of a jump. Empty when the box is not on a slider path (it does
 * not touch the mark, or the item has no slider model). Returns `[step index, candidate]`
 * pairs.
 */
export function warmNudges(
  item: Item,
  vi: number,
  v: Variant,
  rect: Rect,
  steps: readonly number[],
  models: Models,
): [number, Cand][] {
  if (!Models.has(models, Models.SLIDER)) return [];
  const hw = v.w * 0.5;
  const hh = v.h * 0.5;
  const runs = sliderRuns(item, hw, hh);
  const c0 = rect.center();
  // the nearest point of the paths: (distance, run, segment, parameter)
  let nd = 0;
  let nr = -1;
  let nk = 0;
  let nt = 0;
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r]!;
    for (let k = 0; k + 1 < run.length; k++) {
      const a = run[k]!;
      const b = run[k + 1]!;
      const ab = b.sub(a);
      const l2 = ab.len2();
      const t = l2 > 0 ? Math.min(Math.max(((c0.x - a.x) * ab.x + (c0.y - a.y) * ab.y) / l2, 0), 1) : 0;
      const d = c0.dist(a.lerp(b, t));
      if (nr < 0 || d < nd) {
        nd = d;
        nr = r;
        nk = k;
        nt = t;
      }
    }
  }
  if (nr < 0 || nd > 0.75) return [];
  const refp = item.shape.reference();
  const out: [number, Cand][] = [];
  for (let si = 0; si < steps.length; si++) {
    const step = steps[si]!;
    for (const s of [step, -step]) {
      const w = walkRun(runs[nr]!, nk, nt, s);
      if (w === null) continue;
      const c = pushIn(item.shape, item.len.offset, w, hw, hh);
      const dd = c.sub(refp);
      if (dd.len2() === 0) continue;
      // the nearest of the item's allowed positions by direction, as for `warm`
      let bestDot = 0;
      let bestPos: Pos | null = null;
      let bestRank = 0;
      for (let rank = 0; rank < item.positions.length; rank++) {
        const p = item.positions[rank]!;
        const pd = POS_DIRS[posAngularIndex(p)]!;
        const dot = (pd.x * dd.x + pd.y * dd.y) / Math.sqrt(dd.len2());
        if (bestPos === null || dot > bestDot) {
          bestDot = dot;
          bestPos = p;
          bestRank = rank;
        }
      }
      if (bestPos === null) continue;
      out.push([si, new Cand(item.index, vi, v.level, Kind.Slider, bestPos, bestRank + 0.25, Rect.fromCenter(c, hw, hh))]);
    }
  }
  return out;
}

/**
 * Decides whether the label box in {@link KEEP_BOX} of variant `vi` is created (the
 * candidate filter of `Solve.generateMode`; see there).
 */
export type KeepFn = (vi: number) => boolean;

/**
 * The label box `[x0, y0, x1, y1]` a {@link KeepFn} decides on; the generators write it
 * before each call. (A typed array instead of arguments: coordinates passed to a call
 * that is not inlined would be boxed, one allocation each.)
 */
export const KEEP_BOX = new Float64Array(4);

/**
 * Adjacent and slider candidates of one variant. With `stubs`, a candidate that another
 * item's mark comes near is replaced by the same position `stub_length` farther out, with a
 * stub, where the stub meets a side of the label squarely and the candidate is statically
 * feasible (spec §6.9). With `keep`, boxes it rejects are not created (Rust filters the
 * created candidates right afterwards, calling `keep` on the same boxes in the same order).
 */
export function adjacent(
  item: Item,
  vi: number,
  v: Variant,
  sliderPerGap: number,
  models: Models,
  stubs: Stubs | null,
  out: Cand[],
  keep: KeepFn | null = null,
): void {
  const hw = v.w * 0.5;
  const hh = v.h * 0.5;
  const o = item.len.offset;
  // the offset of labels with a stub
  const os = o + item.len.stubLength;
  const shape = item.shape;
  const push = needsPushIn(shape);
  const positions = item.positions;
  const it = item.index;
  const kb = KEEP_BOX;
  // `keep` on the box of `c`; `c` itself when kept
  const kept = (c: Cand): boolean => {
    if (keep === null) return true;
    kb[0] = c.rect.x0;
    kb[1] = c.rect.y0;
    kb[2] = c.rect.x1;
    kb[3] = c.rect.y1;
    return keep(vi);
  };
  if (Models.has(models, Models.ADJACENT)) {
    for (let r = 0; r < positions.length; r++) {
      const p = positions[r]!;
      TC_ARGS[0] = o;
      TC_ARGS[1] = hw;
      TC_ARGS[2] = hh;
      touchCenterAt(shape, POS_DIRS[posAngularIndex(p)]!);
      let cx = TC[0]!;
      let cy = TC[1]!;
      if (push) {
        const c = pushIn(shape, o, new P(cx, cy), hw, hh);
        cx = c.x;
        cy = c.y;
      }
      if (stubs === null) {
        const x0 = cx - hw;
        const y0 = cy - hh;
        const x1 = cx + hw;
        const y1 = cy + hh;
        if (keep !== null) {
          kb[0] = x0;
          kb[1] = y0;
          kb[2] = x1;
          kb[3] = y1;
          if (!keep(vi)) continue;
        }
        out.push(new Cand(it, vi, v.level, Kind.Adjacent, p, r, new Rect(x0, y0, x1, y1)));
        continue;
      }
      const plain = new Cand(it, vi, v.level, Kind.Adjacent, p, r, Rect.fromCenter(new P(cx, cy), hw, hh));
      let c = plain;
      if (stubs.ambiguous(item, plain.rect)) {
        TC_ARGS[0] = os;
        touchCenterAt(shape, POS_DIRS[posAngularIndex(p)]!);
        let fx = TC[0]!;
        let fy = TC[1]!;
        if (push) {
          const f = pushIn(shape, os, new P(fx, fy), hw, hh);
          fx = f.x;
          fy = f.y;
        }
        const twin = new Cand(it, vi, v.level, Kind.Adjacent, p, r, Rect.fromCenter(new P(fx, fy), hw, hh));
        c = stubs.stubbed(item, v, twin) ?? plain;
      }
      if (kept(c)) out.push(c);
    }
  }
  if (!Models.has(models, Models.SLIDER) || sliderPerGap === 0) return;
  for (let k = 0; k < 8; k++) {
    const a = posFromAngularIndex(k);
    const b = posFromAngularIndex(k + 1);
    const ra = positions.indexOf(a);
    const rb = positions.indexOf(b);
    if (ra < 0 || rb < 0) continue;
    TC_ARGS[0] = o;
    TC_ARGS[1] = hw;
    TC_ARGS[2] = hh;
    const n = cspacePathInto(shape, k);
    const m = samplePathInto(n, sliderPerGap, shape);
    const cand = (j: number, cx: number, cy: number): Cand => {
      const t = (j + 1) / (sliderPerGap + 1);
      const rank = ra + (rb - ra) * t + 0.25;
      const side = t < 0.5 ? a : b;
      return new Cand(it, vi, v.level, Kind.Slider, side, rank, new Rect(cx - hw, cy - hh, cx + hw, cy + hh));
    };
    if (stubs === null) {
      for (let j = 0; j < m; j++) {
        let cx = SP_X[j]!;
        let cy = SP_Y[j]!;
        if (push) {
          const c = pushIn(shape, o, new P(cx, cy), hw, hh);
          cx = c.x;
          cy = c.y;
        }
        const x0 = cx - hw;
        const y0 = cy - hh;
        const x1 = cx + hw;
        const y1 = cy + hh;
        if (keep !== null) {
          kb[0] = x0;
          kb[1] = y0;
          kb[2] = x1;
          kb[3] = y1;
          if (!keep(vi)) continue;
        }
        out.push(cand(j, cx, cy));
      }
      continue;
    }
    const xs = SP_X.slice(0, m);
    const ys = SP_Y.slice(0, m);
    if (push) {
      for (let j = 0; j < m; j++) {
        const c = pushIn(shape, o, new P(xs[j]!, ys[j]!), hw, hh);
        xs[j] = c.x;
        ys[j] = c.y;
      }
    }
    // the boxes another mark comes near, and the samples of the path of labels with a stub
    // (made only when needed)
    const near: boolean[] = [];
    for (let j = 0; j < m; j++) near.push(stubs.ambiguous(item, Rect.fromCenter(new P(xs[j]!, ys[j]!), hw, hh)));
    let fm = 0;
    let fx: Float64Array | null = null;
    let fy: Float64Array | null = null;
    if (near.includes(true)) {
      TC_ARGS[0] = os;
      fm = samplePathInto(cspacePathInto(shape, k), sliderPerGap, shape);
      fx = SP_X.slice(0, fm);
      fy = SP_Y.slice(0, fm);
      if (push) {
        for (let j = 0; j < fm; j++) {
          const c = pushIn(shape, os, new P(fx[j]!, fy[j]!), hw, hh);
          fx[j] = c.x;
          fy[j] = c.y;
        }
      }
    }
    for (let j = 0; j < m; j++) {
      const stubbed = near[j]! && j < fm ? stubs.stubbed(item, v, cand(j, fx![j]!, fy![j]!)) : null;
      const c = stubbed ?? cand(j, xs[j]!, ys[j]!);
      if (kept(c)) out.push(c);
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

/** The C-space path of {@link cspacePathInto}: positions, angles, straight flags, table indices. */
const CS_X = new Float64Array(16);
const CS_Y = new Float64Array(16);
const CS_PHI = new Float64Array(16);
const CS_STRAIGHT = new Uint8Array(16);
const CS_IDX = new Int32Array(16);
const CS_CUM = new Float64Array(16);
/** The samples of {@link samplePathInto}. */
let SP_X = new Float64Array(64);
let SP_Y = new Float64Array(64);

/**
 * Boundary of `(S ⊕ o) ⊕ (−B)` over gap `k` (between two fixed positions; `o` and the
 * half sizes of `B` in {@link TC_ARGS}), into the `CS_*` arrays; returns the number of
 * vertices.
 */
function cspacePathInto(shape: Shape, k: number): number {
  const t = gapTable(k);
  let n = 0;
  for (let j = 0; j < t.phis.length; j++) {
    touchCenterAt(shape, t.dirs[j]!);
    const px = TC[0]!;
    const py = TC[1]!;
    // verts.last().p.dist(p) < 1e-12
    if (n > 0 && len2d(CS_X[n - 1]! - px, CS_Y[n - 1]! - py) < 1e-12) continue;
    CS_X[n] = px;
    CS_Y[n] = py;
    CS_PHI[n] = t.phis[j]!;
    CS_STRAIGHT[n] = 1;
    CS_IDX[n] = j;
    n++;
  }
  for (let i = 0; i + 1 < n; i++) {
    const m = CS_IDX[i + 1] === CS_IDX[i]! + 1 ? t.mids[CS_IDX[i]!]! : dirOf((CS_PHI[i]! + CS_PHI[i + 1]!) * 0.5);
    touchCenterAt(shape, m);
    CS_STRAIGHT[i] = distPointSegXY(TC[0]!, TC[1]!, CS_X[i]!, CS_Y[i]!, CS_X[i + 1]!, CS_Y[i + 1]!) <= 1e-9 ? 1 : 0;
  }
  return n;
}

/**
 * `k` samples at equal arc length of the path of {@link cspacePathInto} (`n` vertices),
 * excluding the endpoints, into `SP_X`/`SP_Y`; returns their number.
 */
function samplePathInto(n: number, k: number, shape: Shape): number {
  if (n < 2) return 0;
  CS_CUM[0] = 0;
  for (let i = 1; i < n; i++) CS_CUM[i] = CS_CUM[i - 1]! + len2d(CS_X[i - 1]! - CS_X[i]!, CS_Y[i - 1]! - CS_Y[i]!);
  const total = CS_CUM[n - 1]!;
  if (total <= 1e-9) return 0;
  if (SP_X.length < k) {
    SP_X = new Float64Array(k);
    SP_Y = new Float64Array(k);
  }
  const sx = SP_X;
  const sy = SP_Y;
  let seg = 0;
  for (let j = 1; j <= k; j++) {
    const target = (total * j) / (k + 1);
    while (seg + 1 < n - 1 && CS_CUM[seg + 1]! < target) seg += 1;
    const len = CS_CUM[seg + 1]! - CS_CUM[seg]!;
    const t = len > 0 ? (target - CS_CUM[seg]!) / len : 0;
    if (CS_STRAIGHT[seg]) {
      // a.p.lerp(b.p, t)
      sx[j - 1] = CS_X[seg]! + (CS_X[seg + 1]! - CS_X[seg]!) * t;
      sy[j - 1] = CS_Y[seg]! + (CS_Y[seg + 1]! - CS_Y[seg]!) * t;
    } else {
      // c_at(shape, o, hw, hh, phi)
      touchCenterAt(shape, dirOf(CS_PHI[seg]! + (CS_PHI[seg + 1]! - CS_PHI[seg]!) * t));
      sx[j - 1] = TC[0]!;
      sy[j - 1] = TC[1]!;
    }
  }
  return k;
}

/** Boundary of `(S ⊕ o) ⊕ (−B)` over gap `k` (between two fixed positions). */
export function cspacePath(shape: Shape, o: number, hw: number, hh: number, k: number): CVertex[] {
  TC_ARGS[0] = o;
  TC_ARGS[1] = hw;
  TC_ARGS[2] = hh;
  const n = cspacePathInto(shape, k);
  const out: CVertex[] = [];
  for (let i = 0; i < n; i++) out.push({ p: new P(CS_X[i]!, CS_Y[i]!), phi: CS_PHI[i]!, straightNext: CS_STRAIGHT[i] === 1 });
  return out;
}

/** `k` samples at equal arc length, excluding the endpoints. */
export function samplePath(path: readonly CVertex[], k: number, shape: Shape, o: number, hw: number, hh: number): P[] {
  const n = path.length;
  for (let i = 0; i < n; i++) {
    CS_X[i] = path[i]!.p.x;
    CS_Y[i] = path[i]!.p.y;
    CS_PHI[i] = path[i]!.phi;
    CS_STRAIGHT[i] = path[i]!.straightNext ? 1 : 0;
  }
  TC_ARGS[0] = o;
  TC_ARGS[1] = hw;
  TC_ARGS[2] = hh;
  const m = samplePathInto(n, k, shape);
  const out: P[] = [];
  for (let j = 0; j < m; j++) out.push(new P(SP_X[j]!, SP_Y[j]!));
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
  if (shape.kind === "polygon") centers.unshift(item.pole());
  else centers.unshift(shape.bbox().center());
  for (const c of centers) {
    if (shape.containsRect(Rect.fromCenter(c, hw, hh), pad)) push(c);
  }
}
