/**
 * Distant candidates with leaders (spec §6.4, §7); port of
 * `rust/crates/la-core/src/leaders.rs`.
 *
 * @module
 */

import { Cand, Kind, Leader, SIDE_DISTANT, dirOf } from "./candidates.js";
import { P, Rect } from "./geom/index.js";
import type { Variant } from "./labels.js";
import { cmpF64, maxf, minf, signEps } from "./math.js";
import { Attach, type Item, LeaderStyle, type Model, Port } from "./model/index.js";
import type { Obstacles } from "./obstacles.js";
import { IdList } from "./spatial.js";

/** Leader start on the item for direction `d` (boundary + gap, center or tip). */
export function leaderStart(model: Model, item: Item, toward: P): P {
  let attach = model.leaders.attach;
  if (attach === Attach.Auto) attach = item.tip ? Attach.Tip : Attach.Boundary;
  const refp = item.shape.reference();
  if (attach === Attach.Tip || attach === Attach.Center) return refp;
  const d = toward.sub(refp).norm();
  if (d.len2() === 0) return refp;
  return item.shape.boundaryPoint(d).add(d.mul(item.len.anchorGap));
}

/** Place a label of half size (hw, hh) so that its port side faces direction `d` at `t`. */
function attachLabel(t: P, d: P, hw: number, hh: number, port: Port): [Rect, P] {
  const sx = signEps(d.x, 1e-9);
  const sy = signEps(d.y, 1e-9);
  if (port === Port.SideCenter || port === Port.Baseline) {
    if (Math.abs(d.x) >= Math.abs(d.y) * 0.999) return [Rect.fromCenter(new P(t.x + sx * hw, t.y), hw, hh), t];
    return [Rect.fromCenter(new P(t.x, t.y + sy * hh), hw, hh), t];
  }
  return [Rect.fromCenter(new P(t.x + sx * hw, t.y + sy * hh), hw, hh), t];
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
  keep: (vi: number, r: Rect) => boolean,
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
  const push = (rect: Rect, pts: P[], ring: number): void => {
    let l = new Leader(pts, style);
    if (l.len < len.leaderMin || l.len > len.leaderMax + 1e-9) return;
    if (port === Port.Baseline) {
      const t = v.text;
      if (t !== null) {
        const y = rect.y0 + t.baselines[0]! + minf(rect.h() - t.baselines[0]!, em * 0.25) * 0.5;
        const x0 = rect.x0 + t.xOffset;
        const x1 = x0 + t.widths[0]!;
        const end = l.pts[l.pts.length - 1]!;
        const [near, far] = Math.abs(end.x - x0) <= Math.abs(end.x - x1) ? [x0, x1] : [x1, x0];
        const p2 = l.pts.slice();
        p2[p2.length - 1] = new P(near, y);
        l = new Leader(p2, style);
        l.underline = [new P(near, y), new P(far, y)];
      }
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
    } else c.leaders.push(l);
    out.push(c);
  };
  for (const [, d] of dirs) {
    const start = leaderStart(model, item, item.shape.reference().add(d));
    for (let k = 0; k < rings; k++) {
      const r = rings === 1 ? len.minDistance : len.minDistance + ((len.maxDistance - len.minDistance) * k) / (rings - 1);
      if (r <= 0) continue;
      switch (style) {
        case LeaderStyle.Elbow: {
          const e = start.add(d.mul(r));
          const run = 0.75 * em;
          const sx = d.x >= 0 ? 1 : -1;
          const p = new P(e.x + sx * run, e.y);
          const rect = Rect.fromCenter(new P(p.x + sx * hw, p.y), hw, hh);
          if (keep(vi, rect)) push(rect, [start, e, p], k);
          break;
        }
        case LeaderStyle.Orthogonal: {
          const t = start.add(d.mul(r));
          const [rect, portPt] = attachLabel(t, d, hw, hh, Port.SideCenter);
          if (!keep(vi, rect)) continue;
          if (Math.abs(d.x) < 1e-9 || Math.abs(d.y) < 1e-9) push(rect, [start, portPt], k);
          else {
            // po: vertical then horizontal into the side-center port
            const bend = new P(start.x, portPt.y);
            push(rect, [start, bend, portPt], k);
          }
          break;
        }
        case LeaderStyle.Curved: {
          const t = start.add(d.mul(r));
          const [rect] = attachLabel(t, d, hw, hh, port);
          if (!keep(vi, rect)) continue;
          const p0 = rect.closestPoint(start);
          const s0 = leaderStart(model, item, p0);
          const portPt = rect.closestPoint(s0);
          // straight and two bows; the flattened curve is the collision geometry
          for (const bow of [0, 0.3, -0.3]) {
            const pts = curvePoints(s0, portPt, bow);
            const ctrl = curveControl(s0, portPt, bow);
            const before = out.length;
            push(rect, pts, k);
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
          const t = start.add(d.mul(r));
          const [rect, pp] = attachLabel(t, d, hw, hh, port);
          let portPt = pp;
          if (!keep(vi, rect)) continue;
          let s0 = start;
          if (style === LeaderStyle.Straight && port === Port.Nearest) {
            portPt = rect.closestPoint(start);
            s0 = leaderStart(model, item, portPt);
            portPt = rect.closestPoint(s0);
          }
          push(rect, [s0, portPt], k);
        }
      }
    }
  }
  // free-space seeds: local maxima of the distance transform near the item
  if (model.placement.freeSpaceSeeds && obs.dt.length > 0) {
    for (const seed of freeSpaceSeeds(obs, item, hh)) {
      const rect = Rect.fromCenter(seed, hw, hh);
      if (!keep(vi, rect)) continue;
      const start0 = leaderStart(model, item, seed);
      const portPt = rect.closestPoint(start0);
      const start = leaderStart(model, item, portPt);
      let pts: P[];
      if (style === LeaderStyle.Orthogonal) {
        const bend = new P(start.x, portPt.y);
        pts =
          Math.abs(bend.x - portPt.x) < 1e-9 || Math.abs(bend.y - start.y) < 1e-9 ? [start, portPt] : [start, bend, portPt];
      } else pts = [start, portPt];
      if (style === LeaderStyle.Angles || style === LeaderStyle.Elbow) continue; // angle-restricted styles only use their rays
      push(rect, pts, rings);
    }
  }
}

const SEED_IDS = new IdList();

/**
 * Up to 8 local maxima of the distance transform within `max_distance` of the item whose
 * clearance is at least `hh` (precomputed in `Obstacles.seeds`).
 */
export function freeSpaceSeeds(obs: Obstacles, item: Item, hh: number): P[] {
  const bb = item.shape.bbox();
  const reach = item.len.maxDistance + maxf(bb.w(), bb.h()) * 0.5;
  const c = item.shape.reference();
  obs.seedIndex.query(Rect.fromCenter(c, reach, reach), SEED_IDS);
  const seeds: [number, number, number, P][] = [];
  for (let q = 0; q < SEED_IDS.len; q++) {
    const [p, v, col, row] = obs.seeds[SEED_IDS.get(q)]!;
    const dd = p.dist(c);
    if (v >= hh && dd <= reach && dd > hh) seeds.push([v - 0.01 * dd, col, row, p]);
  }
  seeds.sort((a, b) => cmpF64(b[0], a[0]) || a[2] - b[2] || a[1] - b[1]);
  return seeds.slice(0, 8).map((s) => s[3]);
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
