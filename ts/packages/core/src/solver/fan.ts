/**
 * Fan labels (spec §6.8): the labels of a crowd of items stacked in a column beside the
 * crowd, with fanning leaders; port of `rust/crates/la-core/src/solver/fan.rs`.
 *
 * After the search, items (in priority order: with `placement.fan` = `auto` those left
 * without a label, with `always` every item) seed crowds: the items whose anchors lie
 * within one label height vertically and one em horizontally (between the marks) of a
 * crowd member, gathered breadth first, nearest first. For each side the seed's positions
 * allow (right, left), a column takes the crowd's members without a label (`always`: and
 * those labeled on that side): ordered by anchor height, stacked around it like boundary
 * labels, matched to the slots by total leader length when that is shorter than keeping
 * the order, at a distance from the crowd that keeps the leaders at most 45° steep (as far
 * as the canvas allows). A placed label in its way whose item stands in the crowd's strip
 * joins the column; a placed member that cannot move into it keeps its label; a member
 * without a label that fails leaves it (lowest priority first). The column is applied when
 * it places more labels (`always`: at least as many, in a column of two or more), within
 * the label budgets (`priority.budget`), and unless it inverts priorities: an omitted item
 * that would become placeable once less important labels were removed.
 *
 * Fan leaders are built like boundary leaders (straight, or per the `orthogonal`, `elbow`
 * style) and keep to `leaders.max_length`; the `angles` style, whose leaders run along the
 * allowed rays, has no fans. Items that may not get leaders (neither their models nor the
 * ladder have `distant` or `boundary`), items kept with another, area anchors and grouped
 * items stay out.
 *
 * @module
 */

import { boundaryLeader, slotArea } from "../boundary.js";
import { Cand, Kind, SIDE_FAN, labelShape } from "../candidates.js";
import { EPS, P, Rect } from "../geom/index.js";
import { cmpF64, maxf, minf } from "../math.js";
import { FanMode, LeaderStyle, Models, Omission, Pos } from "../model/index.js";
import { hungarian, stack } from "./repair.js";
import { Reason, type Solve } from "./index.js";
import { inverted } from "./verify.js";

/** Largest crowd a seed gathers, and most labels a column takes in. */
export const MAX_CROWD = 24;
export const MAX_COLUMN = 40;
/**
 * Horizontal run of a leader per pixel of vertical rise (at most 45° steep), and the
 * least run in em.
 */
export const RUN_PER_RISE = 1.0;
export const MIN_RUN_EM = 1.5;
/** Label evaluations of the pass: at least this many, or this many per item. */
const WORK_MIN = 20000;
const WORK_PER_ITEM = 20;

/** A column: its candidates and the members it gives a label. */
export interface Plan {
  cands: [number, Cand][];
  added: number[];
  cost: number;
}

/** The pass's mode, the items it leaves alone, and the label evaluations it has left. */
interface Pass {
  always: boolean;
  excluded: boolean[];
  work: number;
}

/** A failing member and the placed item in its way (-1: a reason of its own). */
type Fail = [number, number];

export function fanPass(s: Solve): void {
  const model = s.model;
  const mode = model.placement.fan;
  if (
    mode === FanMode.Off ||
    model.leaders.style === LeaderStyle.Angles ||
    model.omission === Omission.Prefix ||
    s.cancelled ||
    s.timeGuardHit
  ) {
    return;
  }
  const area = slotArea(model, s.obs);
  if (area === null) return;
  const n = model.items.length;
  // fan labels have leaders: only items that may get leaders join a fan
  const ladderLeaders = model.ladder.some((st) => st.kind === "distant" || st.kind === "boundary");
  const excluded: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const it = model.items[i]!;
    const m = s.models[i]!;
    const leaders = ladderLeaders || (m & Models.DISTANT) !== 0 || (m & Models.BOUNDARY) !== 0;
    const g = model.groupOf[i];
    excluded.push(
      !leaders ||
        s.variants[i]!.length === 0 ||
        it.keepWith !== null ||
        it.area !== null ||
        (g !== undefined && g !== null),
    );
  }
  const pass: Pass = { always: mode === FanMode.Always, excluded, work: Math.max(WORK_MIN, WORK_PER_ITEM * n) };
  // anchors by height, for the crowd queries
  const byY: number[] = [];
  for (let i = 0; i < n; i++) byY.push(i);
  byY.sort((a, b) => cmpF64(model.items[a]!.anchor.y, model.items[b]!.anchor.y) || a - b);
  const ys = byY.map((i) => model.items[i]!.anchor.y);
  const height: number[] = [];
  for (let i = 0; i < n; i++) height.push(s.variants[i]!.length > 0 ? s.variants[i]![0]!.h : 0);
  let maxH = 0;
  for (const h of height) maxH = maxf(maxH, h);
  const seeded = new Array<boolean>(n).fill(false);
  for (const seed of s.pri.order.slice()) {
    if (seeded[seed]! || pass.excluded[seed]!) continue;
    if (!pass.always) {
      const r = s.reasons[seed]!;
      if (
        s.state.placed[seed]! >= 0 ||
        !(r === null || r === Reason.OmittedByPriority || r === Reason.NoFeasibleCandidate)
      ) {
        continue;
      }
    }
    if (pass.work === 0 || s.pollCancel()) return;
    const crowd = crowdOf(s, seed, byY, ys, height, maxH, pass.excluded);
    for (const j of crowd) seeded[j] = true;
    if (crowd.length < 2) continue;
    const positions = model.items[seed]!.positions;
    const allows = (ps: readonly Pos[]): boolean => ps.some((p) => positions.includes(p));
    const sides: boolean[] = [];
    if (allows([Pos.Right, Pos.TopRight, Pos.BottomRight])) sides.push(true);
    if (allows([Pos.Left, Pos.TopLeft, Pos.BottomLeft])) sides.push(false);
    // the better side first, then the other one for the members it leaves
    while (sides.length > 0) {
      let best: [boolean, Plan] | null = null;
      for (const right of sides) {
        const p = column(s, pass, area, crowd, right);
        if (p !== null && (best === null || betterPlan(s, p, best[1]))) best = [right, p];
      }
      if (best === null) break;
      applyUnlessInverting(s, best[1]);
      const done = best[0];
      for (let k = sides.length - 1; k >= 0; k--) if (sides[k] === done) sides.splice(k, 1);
    }
  }
}

/**
 * `a` gives labels to more important members than `b`, or to as important ones at a
 * lower cost.
 */
function betterPlan(s: Solve, a: Plan, b: Plan): boolean {
  const keys = (p: Plan): number[] => p.added.map((i) => s.pri.prio[i]!.key).sort((x, y) => x - y);
  const ka = keys(a);
  const kb = keys(b);
  const m = Math.min(ka.length, kb.length);
  for (let k = 0; k < m; k++) if (ka[k] !== kb[k]) return ka[k]! < kb[k]!;
  if (ka.length !== kb.length) return ka.length > kb.length;
  return a.cost < b.cost;
}

/** First index of the sorted `ys` whose value is not below `t` (`partition_point`). */
function lowerBound(ys: readonly number[], t: number): number {
  let lo = 0;
  let hi = ys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ys[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The crowd of `seed`: items within one label height vertically (half of each item's
 * height) and one em horizontally (between the marks' boxes) of a member, gathered
 * breadth first, nearest first, at most MAX_CROWD.
 */
function crowdOf(
  s: Solve,
  seed: number,
  byY: readonly number[],
  ys: readonly number[],
  height: readonly number[],
  maxH: number,
  excluded: readonly boolean[],
): number[] {
  const items = s.model.items;
  const crowd = [seed];
  let k = 0;
  while (k < crowd.length && crowd.length < MAX_CROWD) {
    const a = crowd[k]!;
    k++;
    const pa = items[a]!.anchor;
    const ba = items[a]!.shape.bbox();
    const reach = (height[a]! + maxH) * 0.5;
    const near: [number, number][] = [];
    for (let q = lowerBound(ys, pa.y - reach); q < byY.length; q++) {
      const j = byY[q]!;
      const pj = items[j]!.anchor;
      if (pj.y > pa.y + reach) break;
      if (excluded[j]! || crowd.includes(j)) continue;
      const bj = items[j]!.shape.bbox();
      const dx = maxf(maxf(bj.x0, ba.x0) - minf(bj.x1, ba.x1), 0);
      if (
        Math.abs(pj.y - pa.y) <= (height[a]! + height[j]!) * 0.5 &&
        dx <= maxf(items[a]!.em(), items[j]!.em())
      ) {
        near.push([pa.dist(pj), j]);
      }
    }
    near.sort((x, y) => cmpF64(x[0], y[0]) || x[1] - y[1]);
    for (const [, j] of near) {
      if (crowd.length === MAX_CROWD) break;
      crowd.push(j);
    }
  }
  return crowd;
}

/** The column of `crowd` on one side, if it is worth applying. */
function column(s: Solve, pass: Pass, area: Rect, crowd: readonly number[], right: boolean): Plan | null {
  const items = s.model.items;
  const onSide = (j: number): boolean => {
    const c = s.state.placed[j]!;
    if (c < 0) return true;
    const cand = s.cands[c]!;
    return cand.kind !== Kind.Internal && (cand.rect.center().x >= items[j]!.anchor.x) === right;
  };
  // a member without a label that cannot take even the slot level with its anchor, for
  // a reason of its own (no placed label in its way), cannot take any: it stays out
  const members: number[] = [];
  for (const j of crowd) {
    if (s.state.placed[j]! >= 0) {
      if (pass.always && onSide(j)) members.push(j);
      continue;
    }
    pass.work = Math.max(0, pass.work - 1);
    const r = layout(s, area, [j], right);
    if (!Array.isArray(r.fails) || r.fails[0]![1] >= 0) members.push(j);
  }
  // the crowd's strip: labels in the way join the column only for items standing in it
  let sx0 = Infinity;
  let sx1 = -Infinity;
  for (const j of crowd) {
    const b = items[j]!.shape.bbox();
    sx0 = minf(sx0, b.x0);
    sx1 = maxf(sx1, b.x1);
  }
  const em = items[crowd[0]!]!.em();
  const fixed: number[] = [];
  for (;;) {
    let unlabeled = 0;
    for (const j of members) if (s.state.placed[j]! < 0) unlabeled++;
    const worth = unlabeled > 0 || (pass.always && members.length >= 2);
    if (!worth || members.length > MAX_COLUMN || pass.work === 0) return null;
    // within the label budget (priority.budget): the lowest-priority member without a
    // label leaves
    const maxLabels = s.model.maxLabels;
    if (maxLabels !== null && s.state.nPlaced + unlabeled > maxLabels) {
      if (!dropLowestUnlabeled(s, members)) return null;
      continue;
    }
    pass.work = Math.max(0, pass.work - members.length);
    const r = layout(s, area, members, right);
    const fails = r.fails;
    if (fails === null) {
      const f = s.model.maxInkFraction;
      const canvas = s.model.canvas;
      if (f !== null && canvas !== null) {
        let ink = s.state.labelAreaSum;
        for (const [j, c] of r.cands) {
          const p = s.state.placed[j]!;
          if (p >= 0) ink -= s.cands[p]!.rect.area();
          ink += c.rect.area();
        }
        if (ink / maxf(canvas.area(), 1e-9) > f) {
          if (!dropLowestUnlabeled(s, members)) return null;
          continue;
        }
      }
      const added = members.filter((j) => s.state.placed[j]! < 0);
      let cost = 0;
      for (const [, c] of r.cands) cost += c.cost;
      return { cands: r.cands, added, cost };
    }
    // a placed label in the way joins the column
    let joins = -1;
    for (const [, k] of fails) {
      if (k < 0) continue;
      if (
        !pass.excluded[k]! &&
        !fixed.includes(k) &&
        !members.includes(k) &&
        s.state.placed[k]! >= 0 &&
        onSide(k)
      ) {
        const b = items[k]!.shape.bbox();
        if (b.x1 >= sx0 - em && b.x0 <= sx1 + em) {
          joins = k;
          break;
        }
      }
    }
    if (joins >= 0) {
      members.push(joins);
      continue;
    }
    // a placed member that cannot move into the column keeps its label
    const kept = fails.find(([j]) => s.state.placed[j]! >= 0);
    if (kept !== undefined) {
      const k = kept[0];
      members.splice(members.indexOf(k), 1);
      fixed.push(k);
      continue;
    }
    // the lowest-priority member without a label among those that fail leaves
    let k = -1;
    for (const [j] of fails) if (k < 0 || s.pri.prio[j]!.rank >= s.pri.prio[k]!.rank) k = j;
    members.splice(members.indexOf(k), 1);
  }
}

/** Remove the lowest-priority member without a label (false: there is none). */
function dropLowestUnlabeled(s: Solve, members: number[]): boolean {
  let k = -1;
  for (const j of members) {
    if (s.state.placed[j]! < 0 && (k < 0 || s.pri.prio[j]!.rank >= s.pri.prio[k]!.rank)) k = j;
  }
  if (k < 0) return false;
  members.splice(members.indexOf(k), 1);
  return true;
}

/**
 * Stack `members` in one column and test it against everything else placed: the
 * candidates (`fails` null), or the members that fail, each with the placed item in its
 * way (-1: a reason of its own).
 */
function layout(
  s: Solve,
  area: Rect,
  members: readonly number[],
  right: boolean,
): { cands: [number, Cand][]; fails: Fail[] | null } {
  const model = s.model;
  const items = model.items;
  const order = members.slice();
  order.sort(
    (a, b) =>
      cmpF64(items[a]!.anchor.y, items[b]!.anchor.y) || cmpF64(items[a]!.anchor.x, items[b]!.anchor.x) || a - b,
  );
  // the variant of each member: its placed one, else its first
  const vis = order.map((j) => {
    const c = s.state.placed[j]!;
    return c >= 0 ? s.cands[c]!.variant : 0;
  });
  const hs = order.map((j, k) => s.variants[j]![vis[k]!]!.h);
  const gap = items[order[0]!]!.len.boundaryGap;
  const desired = order.map((j) => items[j]!.anchor.y);
  // at least the larger margin of the two labels apart (spec §6.8)
  const gaps: number[] = [];
  for (let k = 1; k < order.length; k++) {
    const m = maxf(items[order[k - 1]!]!.len.margin, items[order[k]!]!.len.margin);
    gaps.push((hs[k - 1]! + hs[k]!) * 0.5 + maxf(gap, m));
  }
  const ys = stack(desired, gaps, area.y0 + hs[0]! * 0.5, area.y1 - hs[hs.length - 1]! * 0.5);
  // the column stands beyond the members' marks, as far as the steepest leader needs
  let edge = right ? -Infinity : Infinity;
  let wmax = 0;
  for (let k = 0; k < order.length; k++) {
    const b = items[order[k]!]!.shape.bbox();
    edge = right ? maxf(edge, b.x1) : minf(edge, b.x0);
    wmax = maxf(wmax, s.variants[order[k]!]![vis[k]!]!.w);
  }
  let rise = 0;
  for (let k = 0; k < order.length; k++) rise = maxf(rise, Math.abs(desired[k]! - ys[k]!));
  const room = right ? area.x1 - edge - wmax : edge - wmax - area.x0;
  const run = maxf(minf(RUN_PER_RISE * rise, room), MIN_RUN_EM * items[order[0]!]!.em());
  const x = right ? edge + run : edge - run;
  // slots in the anchors' vertical order, unless a matching of shorter total leader
  // length exists (anchors spread horizontally)
  let slotOf = order.map((_, k) => k);
  const style = model.leaders.style;
  if (hs.every((h) => h === hs[0]) && (style === LeaderStyle.Straight || style === LeaderStyle.Angles)) {
    const cost = order.map((j) => ys.map((y) => items[j]!.anchor.dist(new P(x, y))));
    const total = (a: readonly number[]): number => {
      let t = 0;
      for (let k = 0; k < a.length; k++) t += cost[k]![a[k]!]!;
      return t;
    };
    const m = hungarian(cost);
    const keep = total(slotOf);
    if (total(m) < keep - 1e-6 * (1 + keep)) slotOf = m;
  }
  const fresh: [number, Cand][] = [];
  for (let k = 0; k < order.length; k++) {
    const j = order[k]!;
    const v = s.variants[j]![vis[k]!]!;
    const y = ys[slotOf[k]!]!;
    const rect = right
      ? new Rect(x, y - v.h * 0.5, x + v.w, y + v.h * 0.5)
      : new Rect(x - v.w, y - v.h * 0.5, x, y + v.h * 0.5);
    const c = new Cand(j, vis[k]!, v.level, Kind.Fan, SIDE_FAN, 8, rect);
    const l = boundaryLeader(model, items[j]!, right ? 1 : 0, new P(x, y));
    const tooLong = l.len > items[j]!.len.leaderMax + 1e-9;
    if (l.len > 0) c.leaders.push(l);
    c.lshape = labelShape(c.rect, v.shape);
    s.evaluator.eval(c, v, null);
    // fan leaders keep to leaders.max_length like distant ones
    if (tooLong) c.feasible = false;
    fresh.push([j, c]);
  }
  // test against everything else placed, the members' own labels lifted meanwhile
  const saved: [number, number][] = [];
  for (const j of order) {
    const c = s.state.placed[j]!;
    if (c >= 0) saved.push([j, c]);
  }
  for (const [j] of saved) s.state.unplace(j, s.cands);
  const base = s.cands.length;
  const failed: Fail[] = [];
  const placedNow: number[] = [];
  for (const [j, c] of fresh) {
    if (!c.feasible) {
      failed.push([j, -1]);
      continue;
    }
    const k = s.state.firstConflict(c, s.cands, s.obs, j, Infinity);
    if (k >= 0) failed.push([j, k]);
    else {
      const id = s.cands.length;
      s.cands.push(c.clone());
      s.state.place(j, id, s.cands, false);
      placedNow.push(j);
    }
  }
  for (const j of placedNow) s.state.unplace(j, s.cands);
  s.cands.length = base;
  for (const [j, c] of saved) s.state.place(j, c, s.cands, !s.cands[c]!.feasible);
  return failed.length === 0 ? { cands: fresh, fails: null } : { cands: fresh, fails: failed };
}

/**
 * Apply a column, unless it lets an omitted item become placeable once labels of strictly
 * lower key are removed (the removal test of the verification, spec §9.2), where it was
 * not before: the items watched are those with a candidate meeting a label the column
 * places or lifts. Returns whether the column stays.
 */
export function applyUnlessInverting(s: Solve, plan: Plan): boolean {
  const n = s.model.items.length;
  const reach = s.state.leaderReach(s.obs) + s.state.marginMax() + 2 * EPS;
  const changed: Rect[] = [];
  for (const [j, c] of plan.cands) {
    changed.push(c.bbox().inflate(reach));
    const p = s.state.placed[j]!;
    if (p >= 0) changed.push(s.cands[p]!.bbox().inflate(reach));
  }
  const watch: number[] = [];
  for (let h = 0; h < n; h++) {
    if (s.state.placed[h]! >= 0 || plan.cands.some(([j]) => j === h)) continue;
    const meets = s.byItem[h]!.some((c) => {
      const b = s.cands[c]!.bbox();
      return changed.some((r) => r.touches(b));
    });
    if (meets) watch.push(h);
  }
  const buf: number[] = [];
  const before = watch.map((h) => inverted(s, h, buf));
  const old = plan.cands.map(([j]) => [j, s.state.placed[j]!, s.reasons[j]!] as const);
  const base = s.cands.length;
  apply(s, plan);
  let inverts = false;
  for (let k = 0; k < watch.length && !inverts; k++) {
    if (!before[k] && inverted(s, watch[k]!, buf)) inverts = true;
  }
  if (!inverts) return true;
  // undo: the members' labels as they were, the column's candidates gone
  for (const [j] of old) {
    s.state.unplace(j, s.cands);
    const ids = s.byItem[j]!;
    s.byItem[j] = ids.filter((c) => c < base);
  }
  s.cands.length = base;
  for (const [j, c, r] of old) {
    if (c >= 0) s.state.place(j, c, s.cands, !s.cands[c]!.feasible);
    s.reasons[j] = r;
  }
  return false;
}

function apply(s: Solve, plan: Plan): void {
  for (const [j] of plan.cands) if (s.state.placed[j]! >= 0) s.state.unplace(j, s.cands);
  for (const [j, c] of plan.cands) {
    const id = s.cands.length;
    s.cands.push(c);
    s.byItem[j]!.push(id);
    s.state.place(j, id, s.cands, false);
    s.reasons[j] = null;
  }
}
