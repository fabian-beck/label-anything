/**
 * Post-search repairs: joint boundary slot assignment (spec §6.6), leader uncrossing and
 * the priority repair of strict omission (spec §10.3); port of
 * `rust/crates/la-core/src/solver/repair.rs`.
 *
 * @module
 */

import { columnCandidate, columnPort, sideCode, slotArea } from "../boundary.js";
import { Cand, Kind, Leader, labelShape } from "../candidates.js";
import { EPS, P, Rect, segSegDistXY } from "../geom/index.js";
import { leaderStart } from "../leaders.js";
import { clampf, cmpF64, maxf } from "../math.js";
import { LeaderStyle, Models, Omission } from "../model/index.js";
import { applyUnlessInverting } from "./fan.js";
import { explain } from "./greedy.js";
import { Reason, type Solve } from "./index.js";

/**
 * Bounded isotonic stacking: positions `y_i` (sorted order) minimizing Σ (y_i − d_i)²
 * subject to `y_{i+1} − y_i ≥ g_i` and `lo ≤ y_0`, `y_{n−1} ≤ hi` (pool adjacent
 * violators).
 */
export function stack(desired: readonly number[], gaps: readonly number[], lo: number, hi: number): number[] {
  const n = desired.length;
  if (n === 0) return [];
  const offs = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) offs[i] = offs[i - 1]! + gaps[i - 1]!;
  const z: number[] = [];
  for (let i = 0; i < n; i++) z.push(desired[i]! - offs[i]!);
  // PAV on z with unit weights: (mean, count)
  const bm: number[] = [];
  const bc: number[] = [];
  for (const v of z) {
    bm.push(v);
    bc.push(1);
    while (bm.length >= 2) {
      const m2 = bm[bm.length - 1]!;
      const c2 = bc[bc.length - 1]!;
      const m1 = bm[bm.length - 2]!;
      const c1 = bc[bc.length - 2]!;
      if (m1 <= m2) break;
      bm.length -= 2;
      bc.length -= 2;
      const c = c1 + c2;
      bm.push((m1 * c1 + m2 * c2) / c);
      bc.push(c);
    }
  }
  const out: number[] = [];
  for (let b = 0; b < bm.length; b++) for (let k = 0; k < bc[b]!; k++) out.push(bm[b]!);
  // constant bounds in z-space: z ≥ lo, z ≤ hi − offs[n−1]
  const zlo = lo;
  const zhi = hi - offs[n - 1]!;
  for (let i = 0; i < n; i++) {
    const clamped = zhi < zlo ? zlo : clampf(out[i]!, zlo, zhi);
    out[i] = clamped + offs[i]!;
  }
  return out;
}

/**
 * Minimum-cost perfect assignment of rows to columns (square cost matrix), Hungarian
 * algorithm with potentials (O(n³)). Ties resolve deterministically by index.
 */
export function hungarian(cost: readonly (readonly number[])[]): number[] {
  const n = cost.length;
  if (n === 0) return [];
  const inf = Infinity;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const p = new Array<number>(n + 1).fill(0);
  const way = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(inf);
    const used = new Array<boolean>(n + 1).fill(false);
    for (;;) {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = inf;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (!used[j]) {
          const cur = cost[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
          if (cur < minv[j]!) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j]! < delta) {
            delta = minv[j]!;
            j1 = j;
          }
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]!] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
      if (p[j0] === 0) break;
    }
    for (;;) {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
      if (j0 === 0) break;
    }
  }
  const assign = new Array<number>(n).fill(0);
  for (let j = 1; j <= n; j++) if (p[j]! > 0) assign[p[j]! - 1] = j - 1;
  return assign;
}

function totalCost(s: Solve, items: readonly number[]): number {
  let t = 0;
  for (const i of items) {
    const c = s.state.placed[i]!;
    if (c >= 0) {
      const it = s.model.items[i]!;
      const cand = s.cands[c]!;
      t += cand.cost + s.state.dynamicCost(cand, s.cands, s.obs, it.len.buffer, it.len.clearance, s.model.leaders.width, i);
    }
  }
  return t;
}

/**
 * The labels of a boundary column along `side` (spec §6.6): `members` ordered by their
 * anchors along the side, stacked (`stack`, or evenly spread), matched to the slots by
 * total leader length (straight and `angles` leaders; else in order) and aligned on the
 * column's line facing the picture; each keeps its placed variant (else its first), its
 * rank and its level, and is evaluated. In the members' order along the side.
 */
function columnCands(s: Solve, area: Rect, side: number, members: readonly number[]): [number, Cand][] {
  const model = s.model;
  const items = model.items;
  const horizontalSide = side <= 1;
  const key = (i: number): number => (horizontalSide ? items[i]!.anchor.y : items[i]!.anchor.x);
  const order = members.slice().sort((a, b) => cmpF64(key(a), key(b)) || a - b);
  // a member without a label takes its first variant, at the level its boundary
  // candidates have: 0 with the boundary model, else that of the ladder's boundary step
  const si = model.ladder.findIndex((st) => st.kind === "boundary");
  const stepLevel = si < 0 ? 0 : si + 1;
  const placed: (Cand | null)[] = order.map((j) => {
    const c = s.state.placed[j]!;
    return c >= 0 ? s.cands[c]! : null;
  });
  const vis = placed.map((c) => (c === null ? 0 : c.variant));
  const along: number[] = [];
  const across: number[] = [];
  for (let k = 0; k < order.length; k++) {
    const v = s.variants[order[k]!]![vis[k]!]!;
    along.push(horizontalSide ? v.h : v.w);
    across.push(horizontalSide ? v.w : v.h);
  }
  let depth = 0;
  for (const d of across) depth = maxf(depth, d);
  const gap = items[order[0]!]!.len.boundaryGap;
  const lo = horizontalSide ? area.y0 : area.x0;
  const hi = horizontalSide ? area.y1 : area.x1;
  let positions: number[];
  if (model.placement.boundary.spread) {
    const k = order.length;
    positions = order.map((_, j) => lo + ((hi - lo) * (j + 0.5)) / k);
  } else {
    const desired = order.map((i) => key(i));
    // at least the larger margin of the two labels apart
    const gaps: number[] = [];
    for (let j = 1; j < order.length; j++) {
      const m = maxf(items[order[j - 1]!]!.len.margin, items[order[j]!]!.len.margin);
      gaps.push((along[j - 1]! + along[j]!) * 0.5 + maxf(gap, m));
    }
    positions = stack(desired, gaps, lo + along[0]! * 0.5, hi - along[along.length - 1]! * 0.5);
  }
  // assignment: straight leaders → min total length (to the ports, all on the column's
  // line); otherwise keep the order
  let assign: number[];
  const style = model.leaders.style;
  if (style === LeaderStyle.Straight || style === LeaderStyle.Angles) {
    const cost = order.map((i) => {
      const a = items[i]!.anchor;
      return positions.map((p) => a.dist(columnPort(area, items[i]!, side, p, depth)));
    });
    assign = hungarian(cost);
  } else assign = order.map((_, k) => k);
  const fresh: [number, Cand][] = [];
  for (let k = 0; k < order.length; k++) {
    const j = order[k]!;
    const v = s.variants[j]![vis[k]!]!;
    const item = items[j]!;
    const p = placed[k]!;
    const rank = p === null ? 9 : p.rank;
    const c = columnCandidate(model, area, item, vis[k]!, v, side, positions[assign[k]!]!, depth, rank);
    c.level = p !== null ? p.level : (item.models & Models.BOUNDARY) !== 0 ? v.level : stepLevel;
    c.lshape = labelShape(c.rect, v.shape);
    s.evaluator.eval(c, v, null);
    fresh.push([j, c]);
  }
  return fresh;
}

/**
 * Re-stack the boundary labels of each side jointly; keep the result when every label
 * stays feasible and the total cost drops.
 */
export function boundaryPass(s: Solve): void {
  const area = slotArea(s.model, s.obs);
  if (area === null) return;
  const n = s.model.items.length;
  for (let side = 0; side < 4; side++) {
    const members: number[] = [];
    for (let i = 0; i < n; i++) {
      const c = s.state.placed[i]!;
      if (c >= 0 && s.cands[c]!.kind === Kind.Boundary && s.cands[c]!.bside === side) members.push(i);
    }
    if (members.length < 2) continue;
    const fresh = columnCands(s, area, side, members);
    if (fresh.some(([, c]) => !c.feasible)) continue;
    const order = fresh.map(([i]) => i);
    const old: [number, number][] = order.map((i) => [i, s.state.placed[i]!]);
    const before = totalCost(s, order);
    for (const i of order) s.state.unplace(i, s.cands);
    let ok = true;
    const placedNow: number[] = [];
    for (const [i, c] of fresh) {
      const id = s.cands.length;
      s.cands.push(c);
      s.byItem[i]!.push(id);
      if (!s.state.isFree(s.cands[id]!, s.cands, s.obs, i)) {
        ok = false;
        break;
      }
      s.state.place(i, id, s.cands, false);
      placedNow.push(i);
    }
    if (ok) {
      const after = totalCost(s, order);
      if (after < before - 1e-9) continue;
    }
    for (const i of placedNow) s.state.unplace(i, s.cands);
    for (const [i, c] of old) s.state.place(i, c, s.cands, !s.cands[c]!.feasible);
  }
}

/** Label evaluations of the boundary fill: at least this many, or this many per item. */
const FILL_WORK_MIN = 20000;
const FILL_WORK_PER_ITEM = 20;

/** A failing member and the placed item in its way (-1: a reason of its own). */
type Fail = [number, number];

/**
 * Boundary columns (spec §6.6): on each side in `placement.boundary.sides`, items without a
 * label that may take a boundary label join the side's column one after the other, in
 * priority order, when the column stacked again with them stays feasible and free. A placed
 * label in the way of a member whose item may take a boundary label, and that stands on
 * the column's side of its anchor, moves into the column too. Not with `prefix` omission,
 * after a cancellation or the time guard.
 */
export function boundaryFill(s: Solve): void {
  const model = s.model;
  if (model.omission === Omission.Prefix || s.cancelled || s.timeGuardHit) return;
  const area = slotArea(model, s.obs);
  if (area === null) return;
  const n = model.items.length;
  // items that may take a boundary label: the boundary model or the ladder's step
  const capable: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const it = model.items[i]!;
    const g = model.groupOf[i];
    capable.push(
      (s.models[i]! & Models.BOUNDARY) !== 0 &&
        s.variants[i]!.length > 0 &&
        it.keepWith === null &&
        !(g !== undefined && g !== null),
    );
  }
  let work = Math.max(FILL_WORK_MIN, FILL_WORK_PER_ITEM * n);
  for (const sideName of model.placement.boundary.sides) {
    const side = sideCode(sideName);
    // a placed label that may move into the column: not internal, on the column's side
    // of its anchor
    const movable = (i: number): boolean => {
      const ci = s.state.placed[i]!;
      if (ci < 0) return false;
      const c = s.cands[ci]!;
      if (c.kind === Kind.Internal) return false;
      const a = model.items[i]!.anchor;
      const m = c.rect.center();
      switch (side) {
        case 0:
          return m.x < a.x;
        case 1:
          return m.x >= a.x;
        case 2:
          return m.y < a.y;
        default:
          return m.y >= a.y;
      }
    };
    let members: number[] = [];
    for (let i = 0; i < n; i++) {
      const ci = s.state.placed[i]!;
      if (ci >= 0 && s.cands[ci]!.kind === Kind.Boundary && s.cands[ci]!.bside === side) members.push(i);
    }
    for (const u of s.pri.order.slice()) {
      const r = s.reasons[u]!;
      if (
        s.state.placed[u]! >= 0 ||
        !capable[u]! ||
        !(r === null || r === Reason.OmittedByPriority || r === Reason.NoFeasibleCandidate)
      ) {
        continue;
      }
      const maxLabels = model.maxLabels;
      if (maxLabels !== null && s.state.nPlaced >= maxLabels) return;
      const trial = members.slice();
      trial.push(u);
      for (;;) {
        if (work === 0 || s.pollCancel()) return;
        work = Math.max(0, work - trial.length);
        const res = sideLayout(s, area, side, trial);
        if (res.fails === null) {
          if (!withinInk(s, res.cands)) break;
          let cost = 0;
          for (const [, c] of res.cands) cost += c.cost;
          if (applyUnlessInverting(s, { cands: res.cands, added: [u], cost })) members = trial;
          break;
        }
        // a placed label in the way joins the column
        let joins = -1;
        for (const [, b] of res.fails) {
          if (b >= 0 && capable[b]! && !trial.includes(b) && movable(b)) {
            joins = b;
            break;
          }
        }
        if (joins < 0) break;
        trial.push(joins);
      }
    }
  }
}

/**
 * Whether the labels `cands` (replacing the members' own) keep the label area within
 * `priority.budget.max_ink_fraction`.
 */
function withinInk(s: Solve, cands: readonly [number, Cand][]): boolean {
  const f = s.model.maxInkFraction;
  const canvas = s.model.canvas;
  if (f === null || canvas === null) return true;
  let ink = s.state.labelAreaSum;
  for (const [j, c] of cands) {
    const p = s.state.placed[j]!;
    if (p >= 0) ink -= s.cands[p]!.rect.area();
    ink += c.rect.area();
  }
  return ink / maxf(canvas.area(), 1e-9) <= f;
}

/**
 * Lay out a boundary column of `members` ({@link columnCands}) and test it against
 * everything else placed, the members' own labels lifted meanwhile. `fails`: the members
 * that fail, each with the placed item in its way (-1: a reason of its own).
 */
function sideLayout(
  s: Solve,
  area: Rect,
  side: number,
  members: readonly number[],
): { cands: [number, Cand][]; fails: Fail[] | null } {
  const fresh = columnCands(s, area, side, members);
  const saved: [number, number][] = [];
  for (const [j] of fresh) {
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

/** Whether any leader segments of `a` and `b` intersect (`seg_intersects`). */
function leadersCross(a: Cand, b: Cand): boolean {
  for (const la of a.leaders) {
    const n = la.segCount();
    for (let k = 0; k < n; k++) {
      const p = la.segA(k);
      const q = la.segB(k);
      for (const lb of b.leaders) {
        const m = lb.segCount();
        for (let t = 0; t < m; t++) {
          const r = lb.segA(t);
          const u = lb.segB(t);
          if (segSegDistXY(p.x, p.y, q.x, q.y, r.x, r.y, u.x, u.y) <= EPS) return true;
        }
      }
    }
  }
  return false;
}

export { leadersCross };

/**
 * Uncross leaders (only possible when crossings are soft): swap the label positions of a
 * crossing pair when that shortens the total leader length and keeps everything feasible.
 */
export function uncross(s: Solve): void {
  if (s.obs.dynamic.leaderLeaders.isHard()) return;
  const n = s.model.items.length;
  for (let round = 0; round < 50; round++) {
    let improved = false;
    pairs: for (let i = 0; i < n; i++) {
      const ci = s.state.placed[i]!;
      if (ci < 0) continue;
      if (s.cands[ci]!.leaders.length === 0) continue;
      for (let j = i + 1; j < n; j++) {
        const cj = s.state.placed[j]!;
        if (cj < 0) continue;
        const a = s.cands[ci]!;
        const b = s.cands[cj]!;
        if (b.leaders.length === 0 || !a.bbox().touches(b.bbox())) continue;
        if (!leadersCross(a, b)) continue;
        // try: i at j's box center, j at i's box center (same variants)
        const lenBefore = a.leaders[0]!.len + b.leaders[0]!.len;
        const ni = movedTo(s, i, ci, b.rect.center());
        const nj = movedTo(s, j, cj, a.rect.center());
        if (
          ni.leaders.length === 0 ||
          nj.leaders.length === 0 ||
          ni.leaders[0]!.len + nj.leaders[0]!.len >= lenBefore - 1e-9 ||
          !ni.feasible ||
          !nj.feasible
        ) {
          continue;
        }
        s.state.unplace(i, s.cands);
        s.state.unplace(j, s.cands);
        const idI = s.cands.length;
        s.cands.push(ni);
        s.byItem[i]!.push(idI);
        const idJ = s.cands.length;
        s.cands.push(nj);
        s.byItem[j]!.push(idJ);
        if (s.state.isFree(s.cands[idI]!, s.cands, s.obs, i)) {
          s.state.place(i, idI, s.cands, false);
          if (s.state.isFree(s.cands[idJ]!, s.cands, s.obs, j)) {
            s.state.place(j, idJ, s.cands, false);
            improved = true;
            break pairs;
          }
          s.state.unplace(i, s.cands);
        }
        s.state.place(i, ci, s.cands, !s.cands[ci]!.feasible);
        s.state.place(j, cj, s.cands, !s.cands[cj]!.feasible);
      }
    }
    if (!improved) break;
  }
}

/**
 * Candidate of item `i` with the variant of `from`, label centered at `center`, and a
 * straight leader to the nearest point of the label.
 */
function movedTo(s: Solve, i: number, from: number, center: P): Cand {
  const f = s.cands[from]!;
  const v = s.variants[i]![f.variant]!;
  const rect = Rect.fromCenter(center, v.w * 0.5, v.h * 0.5);
  const item = s.model.items[i]!;
  const c = new Cand(i, f.variant, f.level, f.kind, f.side, f.rank, rect);
  c.lshape = labelShape(rect, v.shape);
  const start0 = leaderStart(s.model, item, rect.center());
  const port = rect.closestPoint(start0);
  const start = leaderStart(s.model, item, port);
  c.leaders.push(new Leader([start, rect.closestPoint(start)], f.leaders.length > 0 ? f.leaders[0]!.style : LeaderStyle.Straight));
  s.evaluator.eval(c, v, null);
  return c;
}

/**
 * Strict omission (spec §9.2, §10.3): an omitted item that has a usable candidate in
 * conflict with no placed label or only with labels of strictly lower priority takes it,
 * in priority order, and those labels are tried again in their turn. The search keeps the
 * priority objective, but a move can free a position that a lower label then takes; after
 * this pass the removal test of the verification finds no inversion.
 */
export function priorityRepair(s: Solve): void {
  if (s.model.omission !== Omission.Strict || s.cancelled) return;
  const softOk = s.model.ladder.some((x) => x.kind === "soft_overlap");
  const prio = s.pri.prio;
  const items = s.model.items;
  const order = s.pri.order.slice();
  const confl: number[] = [];
  for (const h of order) {
    if (s.state.placed[h]! >= 0 || items[h]!.keepWith !== null) continue;
    // null: removed by this pass
    const rh = s.reasons[h];
    if (rh !== null && rh !== Reason.OmittedByPriority && rh !== Reason.NoFeasibleCandidate) continue;
    const keyH = prio[h]!.key;
    let bestN = 0;
    let bestGain = 0;
    let bestCost = 0;
    let bestC = -1;
    let bestRemoved: number[] = [];
    let bestRelaxed = false;
    for (const c of s.byItem[h]!.slice()) {
      let cand = s.cands[c]!;
      if (cand.evaluated && !(cand.feasible || (softOk && cand.relaxed))) continue;
      if (s.state.firstConflict(cand, s.cands, s.obs, h, keyH) >= 0) continue;
      s.ensureEval(c);
      cand = s.cands[c]!;
      if (!(cand.feasible || (softOk && cand.relaxed))) continue;
      s.state.conflicts(cand, s.cands, s.obs, h, confl);
      if (!confl.every((j) => prio[j]!.key > keyH && !items[j]!.required)) continue;
      const maxLabels = s.model.maxLabels;
      if (maxLabels !== null && s.state.nPlaced + 1 > maxLabels + confl.length) continue;
      const f = s.model.maxInkFraction;
      const canvas = s.model.canvas;
      if (f !== null && canvas !== null) {
        let area = s.state.labelAreaSum;
        for (const j of confl) area -= s.cands[s.state.placed[j]!]!.rect.area();
        if ((area + cand.rect.area()) / maxf(canvas.area(), 1e-9) > f) continue;
      }
      const relaxed = !cand.feasible;
      const cost = cand.cost + (relaxed ? cand.relaxCost : 0);
      let gain = -0;
      for (const j of confl) gain += prio[j]!.gain;
      const n = confl.length;
      const better =
        bestC < 0 ||
        n < bestN ||
        (n === bestN && (gain < bestGain || (gain === bestGain && (cost < bestCost || (cost === bestCost && c < bestC)))));
      if (better) {
        bestN = n;
        bestGain = gain;
        bestCost = cost;
        bestC = c;
        bestRemoved = confl.slice();
        bestRelaxed = relaxed;
      }
    }
    if (bestC >= 0) {
      for (const j of bestRemoved) {
        s.state.unplace(j, s.cands);
        s.reasons[j] = null;
      }
      s.state.place(h, bestC, s.cands, bestRelaxed);
      s.reasons[h] = null;
    } else if (s.reasons[h] === null) {
      s.reasons[h] = explain(s, h);
    }
  }
}
