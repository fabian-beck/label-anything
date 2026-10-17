/**
 * Distant candidates with leaders (spec §6.4, §7); port of
 * `rust/crates/la-core/src/leaders.rs`.
 *
 * @module
 */

import { Cand, KEEP_BOX, type KeepFn, Kind, Leader, SIDE_DISTANT, dirOf } from "./candidates.js";
import { EPS, P, Rect, distPointSeg, segIntersects } from "./geom/index.js";
import type { Variant } from "./labels.js";
import { clampf, cmpF64, len2d, maxf, minf, signEps } from "./math.js";
import { Attach, type Item, LeaderStyle, type Model, Port, posDir } from "./model/index.js";
import type { Obstacles } from "./obstacles.js";
import { IdList } from "./spatial.js";

/** Leader start on the item for direction `d` (boundary + gap, center or tip). */
export function leaderStart(model: Model, item: Item, toward: P): P {
  LS[0] = toward.x;
  LS[1] = toward.y;
  if (leaderStartIn(model, item)) return item.shape.reference();
  return new P(LS[0]!, LS[1]!);
}

/** In/out point of {@link leaderStartIn}: `[x, y]`. */
const LS = new Float64Array(2);

/**
 * {@link leaderStart} toward the point in {@link LS}, which it replaces by the start (the
 * same operations, without allocating or passing coordinates as arguments). Returns true
 * when the start is the item's reference point.
 */
function leaderStartIn(model: Model, item: Item): boolean {
  let attach = model.leaders.attach;
  if (attach === Attach.Auto) attach = item.tip ? Attach.Tip : Attach.Boundary;
  const refp = item.shape.reference();
  if (attach !== Attach.Tip && attach !== Attach.Center) {
    // d = (toward - refp).norm()
    const vx = LS[0]! - refp.x;
    const vy = LS[1]! - refp.y;
    const l = len2d(vx, vy);
    const dx = l > 0 ? vx / l : 0;
    const dy = l > 0 ? vy / l : 0;
    if (dx * dx + dy * dy !== 0) {
      // boundary_point(d) + d * anchor_gap
      LS[0] = dx;
      LS[1] = dy;
      item.shape.boundaryPointIn(LS);
      const gap = item.len.anchorGap;
      LS[0] = LS[0]! + dx * gap;
      LS[1] = LS[1]! + dy * gap;
      return false;
    }
  }
  LS[0] = refp.x;
  LS[1] = refp.y;
  return true;
}

/** Output of {@link attachCenter}: the label center `[x, y]`. */
const AC = new Float64Array(2);

/**
 * Center of a label of half size (hw, hh) placed so that its port side faces direction
 * `(dx, dy)` at `(tx, ty)` (Rust `attach_label`; the port is `t` itself), into {@link AC}.
 */
function attachCenter(tx: number, ty: number, dx: number, dy: number, hw: number, hh: number, port: Port): void {
  const sx = signEps(dx, 1e-9);
  const sy = signEps(dy, 1e-9);
  if (port === Port.SideCenter || port === Port.Baseline) {
    if (Math.abs(dx) >= Math.abs(dy) * 0.999) {
      AC[0] = tx + sx * hw;
      AC[1] = ty;
    } else {
      AC[0] = tx;
      AC[1] = ty + sy * hh;
    }
    return;
  }
  AC[0] = tx + sx * hw;
  AC[1] = ty + sy * hh;
}

/**
 * The box (width `w`, height `h`) of a label whose leader ends at `(tx, ty)` on its
 * `baseline` port: on the side edge facing the leader (the left edge when the label lies
 * to the right of the anchor, `dx >= 0`), at the height `u` of the underline (from the
 * box top). Mirrors `attach_baseline`.
 */
function attachBaseline(tx: number, ty: number, dx: number, w: number, h: number, u: number): Rect {
  const x0 = dx >= 0 ? tx : tx - w;
  return new Rect(x0, ty - u, x0 + w, ty - u + h);
}

/**
 * Height of the underline of the `baseline` port below the box top: below the first
 * line's baseline, halfway into its descent (at most 0.25 em). Mirrors `underline_offset`.
 */
export function underlineOffset(t: { baselines: ArrayLike<number> }, h: number, em: number): number {
  return t.baselines[0]! + minf(h - t.baselines[0]!, em * 0.25) * 0.5;
}

/**
 * cos 22.5° (half the angle between neighbouring fixed positions), less a tolerance so
 * that a ray on the boundary of two octants belongs to both.
 */
const COS_HALF_OCTANT = 0.9238795325112867 - 1e-9;

/**
 * Whether a distant label in direction `v` from its item keeps to the item's positions:
 * an explicit `position_order` with fewer than the 8 fixed positions allows only the
 * directions within 22.5° of a listed position's direction (spec §6.4), so that labels
 * restricted to the right of line ends do not move left over the lines.
 */
export function keepsToPositions(item: Item, vx: number, vy: number): boolean {
  if (item.positions.length >= 8) return true;
  const n = len2d(vx, vy);
  if (n === 0) return true;
  for (const p of item.positions) {
    const u = posDir(p);
    if (vx * u.x + vy * u.y >= COS_HALF_OCTANT * n * u.len()) return true;
  }
  return false;
}

/**
 * Leader directions of distant candidates with their unit vectors (computed once per
 * solve; the trigonometry is the expensive part of candidate generation).
 */
export function distantDirs(model: Model): [number, P][] {
  return directions(model).map((t) => [t, dirOf(t)]);
}

function directions(model: Model): number[] {
  const out: number[] = [];
  switch (model.leaders.style) {
    case LeaderStyle.Angles:
    case LeaderStyle.Elbow:
      if (model.leaders.angles.length > 0) return model.leaders.angles.slice();
      for (let k = 0; k < 8; k++) out.push(45 * k);
      return out;
    case LeaderStyle.Orthogonal:
      for (let k = 0; k < 8; k++) out.push(45 * k);
      return out;
    default: {
      const nd = model.placement.distantDirections;
      const n = nd > 4 ? nd : 4;
      for (let k = 0; k < n; k++) out.push((360 * k) / n);
      return out;
    }
  }
}

/**
 * Distant candidates of one variant. Label boxes for which `keep(vi, box)` is false are
 * skipped before their leaders are built.
 */
export function distant(
  model: Model,
  obs: Obstacles,
  item: Item,
  vi: number,
  v: Variant,
  dirs: readonly [number, P][],
  keep: KeepFn,
  out: Cand[],
): void {
  const hw = v.w * 0.5;
  const hh = v.h * 0.5;
  const em = item.em();
  const len = item.len;
  const rings = model.placement.distantRings > 1 ? model.placement.distantRings : 1;
  const style = model.leaders.style;
  const port = model.leaders.port;
  const it = item.index;
  const kb = KEEP_BOX;
  // baseline port (straight, angles and elbow leaders, and free-space seeds): the leader
  // ends on the box's side edge at the height of an underline below the first text
  // line, which continues it to the far end of that line (spec §7)
  const under = port === Port.Baseline && v.text !== null ? underlineOffset(v.text, v.h, em) : null;
  const push = (rect: Rect, pts: P[], ring: number, underline: boolean): void => {
    const l = new Leader(pts, style);
    if (l.len < len.leaderMin || l.len > len.leaderMax + 1e-9) return;
    const t = v.text;
    if (underline && t !== null) {
      const p = l.port;
      const x0 = rect.x0 + t.xOffset;
      const far = p.x <= rect.center().x ? x0 + t.widths[0]! : x0;
      l.underline = [p, new P(far, p.y)];
    }
    const c = new Cand(it, vi, v.level, Kind.Distant, SIDE_DISTANT, 8 + ring * 0.5, rect);
    const members = model.groupMembers(item.index);
    if (members.length >= 2) {
      // fan leaders: one per member, all ending at the label's port
      const portPt = l.port;
      for (const mi of members) {
        const mem = model.items[mi]!;
        const s0 = leaderStart(model, mem, portPt);
        const fl = new Leader([s0, rect.closestPoint(s0)], style);
        fl.member = mi;
        c.leaders.push(fl);
      }
    } else c.leaders = [l];
    out.push(c);
  };
  const ref = item.shape.reference();
  for (let di = 0; di < dirs.length; di++) {
    const d = dirs[di]![1];
    const dx = d.x;
    const dy = d.y;
    if (!keepsToPositions(item, dx, dy)) continue;
    // start = leader_start(item.shape.reference() + d), as scalars; the point itself is
    // only built for kept candidates
    LS[0] = ref.x + dx;
    LS[1] = ref.y + dy;
    const startAtRef = leaderStartIn(model, item);
    const sx0 = LS[0]!;
    const sy0 = LS[1]!;
    let start: P | null = null;
    for (let k = 0; k < rings; k++) {
      const r = rings === 1 ? len.minDistance : len.minDistance + ((len.maxDistance - len.minDistance) * k) / (rings - 1);
      if (r <= 0) continue;
      // t = start + d * r
      const tx = sx0 + dx * r;
      const ty = sy0 + dy * r;
      switch (style) {
        case LeaderStyle.Elbow: {
          const run = 0.75 * em;
          const sx = dx >= 0 ? 1 : -1;
          const px = tx + sx * run;
          const cx = px + sx * hw;
          const rect = under !== null ? attachBaseline(px, ty, dx, v.w, v.h, under) : null;
          if (rect !== null) {
            kb[0] = rect.x0;
            kb[1] = rect.y0;
            kb[2] = rect.x1;
            kb[3] = rect.y1;
          } else {
            kb[0] = cx - hw;
            kb[1] = ty - hh;
            kb[2] = cx + hw;
            kb[3] = ty + hh;
          }
          if (keep(vi)) {
            start ??= startAtRef ? ref : new P(sx0, sy0);
            push(
              rect ?? new Rect(cx - hw, ty - hh, cx + hw, ty + hh),
              [start, new P(tx, ty), new P(px, ty)],
              k,
              rect !== null,
            );
          }
          break;
        }
        case LeaderStyle.Orthogonal: {
          attachCenter(tx, ty, dx, dy, hw, hh, Port.SideCenter);
          const cx = AC[0]!;
          const cy = AC[1]!;
          kb[0] = cx - hw;
          kb[1] = cy - hh;
          kb[2] = cx + hw;
          kb[3] = cy + hh;
          if (!keep(vi)) continue;
          start ??= startAtRef ? ref : new P(sx0, sy0);
          const rect = new Rect(cx - hw, cy - hh, cx + hw, cy + hh);
          const portPt = new P(tx, ty);
          if (Math.abs(dx) < 1e-9 || Math.abs(dy) < 1e-9) push(rect, [start, portPt], k, false);
          else {
            // po: vertical then horizontal into the side-center port
            const bend = new P(start.x, portPt.y);
            push(rect, [start, bend, portPt], k, false);
          }
          break;
        }
        case LeaderStyle.Curved: {
          attachCenter(tx, ty, dx, dy, hw, hh, port);
          const cx = AC[0]!;
          const cy = AC[1]!;
          kb[0] = cx - hw;
          kb[1] = cy - hh;
          kb[2] = cx + hw;
          kb[3] = cy + hh;
          if (!keep(vi)) continue;
          start ??= startAtRef ? ref : new P(sx0, sy0);
          const rect = new Rect(cx - hw, cy - hh, cx + hw, cy + hh);
          const p0 = rect.closestPoint(start);
          const s0 = leaderStart(model, item, p0);
          const portPt = rect.closestPoint(s0);
          // straight and two bows; the flattened curve is the collision geometry
          for (const bow of BOWS) {
            const pts = curvePoints(s0, portPt, bow);
            const ctrl = curveControl(s0, portPt, bow);
            const before = out.length;
            push(rect, pts, k, false);
            if (out.length > before) {
              const l = out[out.length - 1]!.leaders[0];
              if (l !== undefined) {
                l.curve = [s0, ctrl, portPt];
                l.bends = 0;
              }
            }
          }
          break;
        }
        default: {
          let x0: number;
          let y0: number;
          let x1: number;
          let y1: number;
          if (under !== null) {
            const b = attachBaseline(tx, ty, dx, v.w, v.h, under);
            x0 = b.x0;
            y0 = b.y0;
            x1 = b.x1;
            y1 = b.y1;
          } else {
            attachCenter(tx, ty, dx, dy, hw, hh, port);
            const cx = AC[0]!;
            const cy = AC[1]!;
            x0 = cx - hw;
            y0 = cy - hh;
            x1 = cx + hw;
            y1 = cy + hh;
          }
          kb[0] = x0;
          kb[1] = y0;
          kb[2] = x1;
          kb[3] = y1;
          if (!keep(vi)) continue;
          const rect = new Rect(x0, y0, x1, y1);
          if (style === LeaderStyle.Straight && port === Port.Nearest) {
            // port = rect.closest_point(start); s0 = leader_start(port);
            // port = rect.closest_point(s0)
            LS[0] = clampf(sx0, x0, x1);
            LS[1] = clampf(sy0, y0, y1);
            const s0AtRef = leaderStartIn(model, item);
            const s0x = LS[0]!;
            const s0y = LS[1]!;
            push(rect, [s0AtRef ? ref : new P(s0x, s0y), new P(clampf(s0x, x0, x1), clampf(s0y, y0, y1))], k, false);
          } else {
            start ??= startAtRef ? ref : new P(sx0, sy0);
            push(rect, [start, new P(tx, ty)], k, under !== null);
          }
        }
      }
    }
  }
  // free-space seeds: local maxima of the distance transform near the item
  if (model.placement.freeSpaceSeeds && obs.dt.length > 0) {
    for (const seed of freeSpaceSeeds(obs, item, hh)) {
      kb[0] = seed.x - hw;
      kb[1] = seed.y - hh;
      kb[2] = seed.x + hw;
      kb[3] = seed.y + hh;
      if (!keepsToPositions(item, seed.x - ref.x, seed.y - ref.y) || !keep(vi)) continue;
      if (style === LeaderStyle.Angles || style === LeaderStyle.Elbow) continue; // angle-restricted styles only use their rays
      const rect = Rect.fromCenter(seed, hw, hh);
      const start0 = leaderStart(model, item, seed);
      const baseline = under !== null && style !== LeaderStyle.Orthogonal;
      // baseline: the side edge facing the item, at the underline's height
      const portPt = baseline
        ? new P(start0.x <= seed.x ? rect.x0 : rect.x1, rect.y0 + under)
        : rect.closestPoint(start0);
      const start = leaderStart(model, item, portPt);
      let pts: P[];
      if (style === LeaderStyle.Orthogonal) {
        const bend = new P(start.x, portPt.y);
        pts =
          Math.abs(bend.x - portPt.x) < 1e-9 || Math.abs(bend.y - start.y) < 1e-9 ? [start, portPt] : [start, bend, portPt];
      } else pts = [start, portPt];
      push(rect, pts, rings, baseline);
    }
  }
}

/** Bows of the curved leader style: straight, then one to each side. */
const BOWS = [0, 0.3, -0.3];

const SEED_IDS = new IdList();

/**
 * The seeds within reach of one item (`dd <= reach`), in seed-index query order, with
 * their clearance, distance and score: what {@link freeSpaceSeeds} computes before its
 * per-variant filter, kept for the item's next calls (one per variant and ladder step).
 */
class NearSeeds {
  item = -1;
  n = 0;
  id = new Int32Array(64);
  v = new Float64Array(64);
  dd = new Float64Array(64);
  score = new Float64Array(64);

  fill(obs: Obstacles, item: Item): void {
    const bb = item.shape.bbox();
    const reach = item.len.maxDistance + maxf(bb.w(), bb.h()) * 0.5;
    const c = item.shape.reference();
    obs.seedIndex.query(Rect.fromCenter(c, reach, reach), SEED_IDS);
    if (this.id.length < SEED_IDS.len) {
      const cap = Math.max(SEED_IDS.len, 2 * this.id.length);
      this.id = new Int32Array(cap);
      this.v = new Float64Array(cap);
      this.dd = new Float64Array(cap);
      this.score = new Float64Array(cap);
    }
    let n = 0;
    for (let q = 0; q < SEED_IDS.len; q++) {
      const id = SEED_IDS.get(q);
      const s = obs.seeds[id]!;
      const v = s[1];
      const dd = s[0].dist(c);
      if (!(dd <= reach)) continue;
      this.id[n] = id;
      this.v[n] = v;
      this.dd[n] = dd;
      this.score[n] = v - 0.01 * dd;
      n++;
    }
    this.n = n;
    this.item = item.index;
  }
}

/** The {@link NearSeeds} of each solve's obstacles (the last item asked for). */
const NEAR_SEEDS = new WeakMap<Obstacles, NearSeeds>();

/**
 * Up to 8 local maxima of the distance transform within `max_distance` of the item whose
 * clearance is at least `hh` (precomputed in `Obstacles.seeds`).
 */
export function freeSpaceSeeds(obs: Obstacles, item: Item, hh: number): P[] {
  let near = NEAR_SEEDS.get(obs);
  if (near === undefined) {
    near = new NearSeeds();
    NEAR_SEEDS.set(obs, near);
  }
  if (near.item !== item.index) near.fill(obs, item);
  // The 8 best by (score descending, row, col): a strict total order, so keeping the
  // best 8 by insertion gives exactly the first 8 of Rust's full sort.
  let n = 0;
  for (let q = 0; q < near.n; q++) {
    // v >= hh && dd <= reach && dd > hh (the cached seeds are within reach)
    if (!(near.v[q]! >= hh && near.dd[q]! > hh)) continue;
    const id = near.id[q]!;
    const s = obs.seeds[id]!;
    const score = near.score[q]!;
    // position of the new seed among the kept ones
    let k = n;
    while (k > 0 && seedBefore(score, s[3], s[2], TOP_SCORE[k - 1]!, obs.seeds[TOP_ID[k - 1]!]!)) k--;
    if (k >= 8) continue;
    const last = n < 8 ? n : 7;
    for (let j = last; j > k; j--) {
      TOP_SCORE[j] = TOP_SCORE[j - 1]!;
      TOP_ID[j] = TOP_ID[j - 1]!;
    }
    TOP_SCORE[k] = score;
    TOP_ID[k] = id;
    if (n < 8) n++;
  }
  const out: P[] = [];
  for (let k = 0; k < n; k++) out.push(obs.seeds[TOP_ID[k]!]![0]);
  return out;
}

const TOP_SCORE = new Float64Array(8);
const TOP_ID = new Int32Array(8);

/** Seed `(score, row, col)` sorts before the kept seed `(s, other)` (Rust's comparator). */
function seedBefore(score: number, row: number, col: number, s: number, other: readonly [P, number, number, number]): boolean {
  // Rust: cmp_f64(b.0, a.0) — higher scores first
  const c = cmpF64(s, score);
  if (c !== 0) return c < 0;
  if (row !== other[3]) return row < other[3];
  return col < other[2];
}

/** Control point of a quadratic leader bowed by `bow × length` to the left of `a → b`. */
export function curveControl(a: P, b: P, bow: number): P {
  const m = a.lerp(b, 0.5);
  const d = b.sub(a);
  return m.add(new P(-d.y, d.x).mul(bow));
}

/** Flattened quadratic Bézier (8 segments; straight when `bow` is 0). */
export function curvePoints(a: P, b: P, bow: number): P[] {
  if (bow === 0) return [a, b];
  const c = curveControl(a, b, bow);
  const out: P[] = [];
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    const u = 1 - t;
    out.push(new P(u * u * a.x + 2 * u * t * c.x + t * t * b.x, u * u * a.y + 2 * u * t * c.y + t * t * b.y));
  }
  return out;
}

/** Leader length helper for tests. */
export function polylineLen(pts: readonly P[]): number {
  let l = 0;
  for (let i = 0; i + 1 < pts.length; i++) l += pts[i]!.dist(pts[i + 1]!);
  return maxf(minf(l, Number.MAX_VALUE), 0);
}

/** Spacing rules between the leaders of two items (spec §7). */
export interface Spacing {
  /** `leaders.clearance` (the larger of the two items'). */
  clr: number;
  /** Distant leaders starting closer than this (the larger font size) must diverge. */
  near: number;
  /** Cosine of `leaders.min_angle_between`; 1 turns the angle rule off. */
  cosMin: number;
}

/**
 * Whether two leaders of different labels conflict when `avoid.leader.leaders` is hard
 * (spec §7): a segment of one intersects a segment of the other, or the leaders come
 * closer than `clr` anywhere except where both start (leaders of neighbouring marks
 * start close together).
 */
export function leadersConflict(a: Leader, b: Leader, clr: number): boolean {
  const na = a.segCount();
  const nb = b.segCount();
  for (let i = 0; i < na; i++) {
    const p = a.segA(i);
    const q = a.segB(i);
    for (let k = 0; k < nb; k++) if (segIntersects(p, q, b.segA(k), b.segB(k))) return true;
  }
  return clr > 0 && (vertexNear(a, b, clr) || vertexNear(b, a, clr));
}

/**
 * A vertex of `a` closer than `clr` to `b`, except `a`'s start when `b` starts within `clr`
 * of it (leaders of neighbouring marks start close together; if they stay close, their
 * other vertices come close too). Leaders that do not intersect are closest at a vertex of
 * one of them.
 */
function vertexNear(a: Leader, b: Leader, clr: number): boolean {
  if (b.pts.length === 0) return false;
  const b0 = b.pts[0]!;
  const nb = b.segCount();
  const nv = a.pts.length + (a.underline !== null ? 2 : 0);
  for (let k = 0; k < nv; k++) {
    const p = k < a.pts.length ? a.pts[k]! : a.underline![k - a.pts.length]!;
    let d = Infinity;
    for (let s = 0; s < nb; s++) d = minf(d, distPointSeg(p, b.segA(s), b.segB(s)));
    if (d < clr - EPS && !(k === 0 && p.dist(b0) <= clr)) return true;
  }
  return false;
}

/**
 * Whether two leaders start closer than `near` and leave in directions less than
 * `leaders.min_angle_between` apart (`cosMin` its cosine).
 */
export function leadersParallel(a: Leader, b: Leader, near: number, cosMin: number): boolean {
  if (a.pts.length < 2 || b.pts.length < 2 || cosMin >= 1) return false;
  const a0 = a.pts[0]!;
  const b0 = b.pts[0]!;
  if (a0.dist(b0) >= near) return false;
  const u = a.pts[1]!.sub(a0);
  const v = b.pts[1]!.sub(b0);
  const lu = u.len();
  const lv = v.len();
  return lu > EPS && lv > EPS && u.dot(v) > cosMin * lu * lv;
}

/**
 * Hard leader conflict between two candidates of different items: their leaders intersect
 * or come too close, or (both distant) start close together in nearly the same direction.
 */
export function candLeadersConflict(a: Cand, b: Cand, sp: Spacing): boolean {
  const angle = a.kind === Kind.Distant && b.kind === Kind.Distant;
  for (const la of a.leaders) {
    for (const lb of b.leaders) {
      if (leadersConflict(la, lb, sp.clr) || (angle && leadersParallel(la, lb, sp.near, sp.cosMin))) return true;
    }
  }
  return false;
}
