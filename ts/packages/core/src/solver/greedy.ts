/**
 * Greedy placement with the degradation ladder (spec §10.1, ADR priority/key); port of
 * `rust/crates/la-core/src/solver/greedy.rs`.
 *
 * @module
 */

import type { Cand } from "../candidates.js";
import { envProgress } from "../env.js";
import { type Spacing, candLeadersConflict } from "../leaders.js";
import { cmpF64, maxf, minf } from "../math.js";
import { Omission, stepEq, stepName } from "../model/index.js";
import { AvoidKind, type Dynamic } from "../obstacles.js";
import { keepWithSets } from "../priority.js";
import { IdList } from "../spatial.js";
import { Reason, type Solve } from "./index.js";
import { leadersHitLabel } from "./state.js";

/**
 * Exact hard conflict between two candidates of different items; `sp`: the spacing rules
 * between their leaders.
 */
export function pairConflict(a: Cand, b: Cand, dy: Dynamic, sp: Spacing): boolean {
  if (dy.labelLabels.kind === AvoidKind.Hard && a.labelOverlapsGap(b, sp.gap)) return true;
  if (dy.leaderLabels.kind === AvoidKind.Hard) {
    if (leadersHitLabel(a, b.rect, sp.gap)) return true;
    if (leadersHitLabel(b, a.rect, sp.gap)) return true;
  }
  return dy.leaderLeaders.kind === AvoidKind.Hard && candLeadersConflict(a, b, sp);
}

/** Number of lookahead-evaluated cheapest candidates. */
const LOOKAHEAD_TOP = 8;

/**
 * Max-heap of `(Reverse(live), Reverse(rank), item)` (Rust `BinaryHeap`): pops the
 * smallest live count, then the smallest rank, then the largest item.
 */
class ItemHeap {
  private live: number[] = [];
  private rank: number[] = [];
  private item: number[] = [];

  clear(): void {
    this.live.length = 0;
    this.rank.length = 0;
    this.item.length = 0;
  }

  get size(): number {
    return this.item.length;
  }

  /** Entry `a` has priority over entry `b`. */
  private above(a: number, b: number): boolean {
    const la = this.live[a]!;
    const lb = this.live[b]!;
    if (la !== lb) return la < lb;
    const ra = this.rank[a]!;
    const rb = this.rank[b]!;
    if (ra !== rb) return ra < rb;
    return this.item[a]! > this.item[b]!;
  }

  private swap(a: number, b: number): void {
    const l = this.live[a]!;
    this.live[a] = this.live[b]!;
    this.live[b] = l;
    const r = this.rank[a]!;
    this.rank[a] = this.rank[b]!;
    this.rank[b] = r;
    const t = this.item[a]!;
    this.item[a] = this.item[b]!;
    this.item[b] = t;
  }

  push(live: number, rank: number, item: number): void {
    this.live.push(live);
    this.rank.push(rank);
    this.item.push(item);
    let k = this.item.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (!this.above(k, p)) break;
      this.swap(k, p);
      k = p;
    }
  }

  /** Pop the top entry into `POPPED` (`[live, rank, item]`); false when empty. */
  pop(): boolean {
    const n = this.item.length;
    if (n === 0) return false;
    POPPED[0] = this.live[0]!;
    POPPED[1] = this.rank[0]!;
    POPPED[2] = this.item[0]!;
    const last = n - 1;
    if (last > 0) this.swap(0, last);
    this.live.length = last;
    this.rank.length = last;
    this.item.length = last;
    let k = 0;
    for (;;) {
      const l = 2 * k + 1;
      if (l >= last) break;
      const r = l + 1;
      const c = r < last && this.above(r, l) ? r : l;
      if (!this.above(c, k)) break;
      this.swap(c, k);
      k = c;
    }
    return true;
  }
}

const POPPED = new Float64Array(3);

class Greedy {
  alive: Uint8Array;
  live: Int32Array;
  done: Uint8Array;
  heap = new ItemHeap();
  killed: Uint32Array;
  touched: number[] = [];
  /** Level-0 attempt failed in the current band pass. */
  tried0: Uint8Array;
  sets: Int32Array;
  setMembers: number[][] = [];
  capReached = false;
  /** Largest key level among placed labels (evict_lower needs a lower-key label). */
  maxKeyPlaced = 0;
  /** Key of the band whose level-0 pass is running (only its items enter the heap); -1: none. */
  bandKey = -1;
  /** Scratch of candidate index queries. */
  ids = new IdList();

  constructor(s: Solve) {
    const n = s.model.items.length;
    this.alive = new Uint8Array(s.nLevel0);
    for (let k = 0; k < s.nLevel0; k++) this.alive[k] = s.cands[k]!.feasible ? 1 : 0;
    this.live = new Int32Array(n);
    this.done = new Uint8Array(n);
    this.killed = new Uint32Array(n);
    this.tried0 = new Uint8Array(n);
    this.sets = new Int32Array(n).fill(-1);
  }
}

export function run(s: Solve): void {
  const n = s.model.items.length;
  const g = new Greedy(s);
  for (let k = 0; k < s.nLevel0; k++) if (g.alive[k]) g.live[s.cands[k]!.item] += 1;
  // non-representative group members are labeled by their representative
  for (let i = 0; i < n; i++) {
    const r = s.model.groupOf[i];
    if (r !== undefined && r !== null && r !== i) {
      g.done[i] = 1;
      s.reasons[i] = Reason.Grouped;
    }
  }
  keepWithSets(s.model).forEach((set, si) => {
    for (const i of set) g.sets[i] = si;
    g.setMembers.push(set);
  });
  // the guard runs from the start of this pass: preparation always completes, and its
  // time must not leave the most important bands unplaced (ADR solver/time-budget)
  const budgetGuard = s.model.solver.timeBudgetMs * 10;
  const started = s.now();
  if (s.model.omission === Omission.Prefix) {
    const order = s.pri.order.slice();
    let cut = false;
    // after the guard, level 0 only (ADR solver/time-budget): the first item without a free level-0
    // position ends the prefix (as below, not one with a covered mark), and the guard of that
    // pass ends it as well
    let finish: number | null = null;
    for (let k = 0; k < order.length; k++) {
      const i = order[k]!;
      if (g.done[i]) continue;
      if (!cut && k % 64 === 63) {
        if (finish === null) {
          if (guardPassed(s, started, budgetGuard)) {
            s.timeGuardHit = true;
            finish = s.now();
          }
        } else if (guardPassed(s, finish, budgetGuard)) {
          cut = true;
        }
      }
      if (s.timeGuardHit && !g.capReached) {
        if (!cut && !placeLevel0(s, g, i) && !g.done[i] && !s.inPrefix(i)) cut = true;
        if (!g.done[i]) {
          g.done[i] = 1;
          s.reasons[i] = Reason.BudgetExhausted;
        }
        continue;
      }
      if (cut || g.capReached) {
        g.done[i] = 1;
        s.reasons[i] = Reason.OmittedByPriority;
        continue;
      }
      // level 0 and then the ladder (spec §10.1), in total order; the first item that
      // fails every step cuts the prefix, unless the label of a more important item covers
      // its mark (spec §9.2) — every member's, for a `keep_with` set
      if (s.trace !== null) s.trace.pick(i, g.live[i]!, "ordered");
      if (!processUnit(s, g, i, true)) {
        const si = g.sets[i]!;
        const unit = si >= 0 ? g.setMembers[si]!.slice() : [i];
        if (!unit.every((m) => s.inPrefix(m))) cut = true;
      }
    }
    return;
  }
  // bands in key order
  const order = s.pri.order.slice();
  let r = 0;
  while (r < order.length) {
    const key = s.pri.prio[order[r]!]!.key;
    const band: number[] = [];
    while (r < order.length && s.pri.prio[order[r]!]!.key === key) {
      band.push(order[r]!);
      r += 1;
    }
    envProgress(s.env, "greedy", (r - band.length) / order.length);
    if (s.trace !== null) s.trace.band(key, band);
    const cancelled = s.pollCancel();
    if (cancelled || s.timeGuardHit || guardPassed(s, started, budgetGuard)) {
      s.timeGuardHit = s.timeGuardHit || !cancelled;
      // after the guard the undecided items wait for the level-0 pass below
      exhaust(s, g, band, false);
      continue;
    }
    // a band that may hit a cap is processed in total order (caps follow priority)
    const capped = capMayHit(s, band);
    const deferred: number[] = [];
    if (capped) {
      for (let k = 0; k < band.length; k++) {
        const i = band[k]!;
        if (g.done[i]) continue;
        if (k % 64 === 63 && guardPassed(s, started, budgetGuard)) {
          s.timeGuardHit = true;
          break;
        }
        if (labelCapReached(s)) {
          // nothing later in the total order can be placed: evictLower only evicts lower
          // keys, and none is placed yet
          g.done[i] = 1;
          s.reasons[i] = Reason.OmittedByPriority;
          continue;
        }
        if (s.trace !== null) s.trace.pick(i, g.live[i]!, "ordered");
        processUnit(s, g, i, true);
      }
      exhaust(s, g, band, false);
      continue;
    }
    // warm start: labels placed in the previous solve keep their position when it is
    // still free (stability first; within one band, so priority is unaffected)
    if (s.model.weights.stability > 0) {
      for (const i of band) {
        if (g.done[i] || g.sets[i]! >= 0) continue;
        const c = s.warmCand[i];
        if (c === null || c === undefined) continue;
        if (g.alive[c] && capAllows(s, s.cands[c]!)) {
          commit(s, g, i, c, false);
          g.done[i] = 1;
        }
      }
      // a warm box that a small change blocked: the nearest free spot along the slider
      // path instead
      for (const i of band) {
        if (g.done[i] || g.sets[i]! >= 0) continue;
        const c = bestNudge(s, i);
        if (c !== null && capAllows(s, s.cands[c]!)) {
          commit(s, g, i, c, false);
          g.done[i] = 1;
        }
      }
    }
    // level-0 pass, most constrained first
    g.heap.clear();
    g.bandKey = key;
    for (const i of band) if (!g.done[i]) g.heap.push(g.live[i]!, s.pri.prio[i]!.rank, i);
    let popped = 0;
    while (g.heap.pop()) {
      const cnt = POPPED[0]!;
      const i = POPPED[2]!;
      if (g.done[i] || g.tried0[i] || cnt !== g.live[i]) continue;
      popped += 1;
      if (popped % 64 === 0) {
        if (s.pollCancel()) break;
        if (guardPassed(s, started, budgetGuard)) {
          s.timeGuardHit = true;
          break;
        }
      }
      if (s.trace !== null) s.trace.pick(i, cnt, "level0");
      if (!processUnit(s, g, i, false) && !g.done[i]) {
        g.tried0[i] = 1;
        deferred.push(i);
        if (s.trace !== null) s.trace.deferred(i);
      }
    }
    g.bandKey = -1;
    // ladder pass in total order
    deferred.sort((a, b) => s.pri.prio[a]!.rank - s.pri.prio[b]!.rank);
    for (let k = 0; k < deferred.length; k++) {
      const i = deferred[k]!;
      if (s.timeGuardHit || g.done[i] || s.pollCancel()) continue;
      if (k % 64 === 63 && guardPassed(s, started, budgetGuard)) {
        s.timeGuardHit = true;
        continue;
      }
      if (s.trace !== null) s.trace.pick(i, g.live[i]!, "ladder");
      processUnit(s, g, i, true);
    }
    exhaust(s, g, band, false);
  }
  if (s.timeGuardHit && !s.cancelled) finishLevel0(s, g, budgetGuard);
  const all: number[] = [];
  for (let i = 0; i < n; i++) all.push(i);
  exhaust(s, g, all, true);
}

/**
 * After the greedy guard (ADR solver/time-budget): the undecided items, in total order, get their
 * best free level-0 candidate — no ladder, no explanation of a failure — until the guard passes
 * once more from the start of this pass; whatever is left is `budget_exhausted`.
 */
function finishLevel0(s: Solve, g: Greedy, guard: number): void {
  const started = s.now();
  const order = s.pri.order.slice();
  let tried = 0;
  for (const i of order) {
    if (g.done[i] || s.state.placed[i]! >= 0) continue;
    tried += 1;
    if (tried % 64 === 0 && (s.pollCancel() || guardPassed(s, started, guard))) break;
    placeLevel0(s, g, i);
  }
}

/**
 * The best free level-0 candidate of undecided item `i`, after the greedy guard
 * (ADR solver/time-budget). Not for members of a `keep_with` set (placed together or not at
 * all) or items whose level-0 attempt already failed (their candidates have not become freer
 * since). A cap that the candidate would exceed omits the item; any other failure leaves it
 * undecided.
 */
function placeLevel0(s: Solve, g: Greedy, i: number): boolean {
  if (g.sets[i]! >= 0 || g.tried0[i]) return false;
  const c = bestLevel0(s, g, i);
  if (c === null) return false;
  g.done[i] = 1;
  if (!capAllows(s, s.cands[c]!)) {
    g.capReached = true;
    s.reasons[i] = Reason.OmittedByPriority;
    return false;
  }
  commit(s, g, i, c, false);
  return true;
}

/**
 * Whether the greedy guard has passed: `guard` ms after `started` (ADR solver/time-budget;
 * never without a clock).
 */
function guardPassed(s: Solve, started: number, guard: number): boolean {
  return s.now() > 0 && s.now() - started > guard;
}

/** Whether `priority.budget.max_labels` labels are placed. */
function labelCapReached(s: Solve): boolean {
  const m = s.model.maxLabels;
  return m !== null && s.state.nPlaced >= m;
}

/**
 * After a cancellation, or at the end of the pass after the time guard (`last`: its level-0
 * pass is over), the undecided items of `band` are `budget_exhausted`.
 */
function exhaust(s: Solve, g: Greedy, band: readonly number[], last: boolean): void {
  if (!(s.cancelled || (last && s.timeGuardHit))) return;
  for (const i of band) {
    if (!g.done[i] && s.state.placed[i]! < 0) {
      g.done[i] = 1;
      s.reasons[i] = Reason.BudgetExhausted;
    }
  }
}

/**
 * The free nudge of item `i`'s warm-start box with the smallest step, the cheaper of the
 * two directions on a tie (see `Solve.warmNudges`).
 */
function bestNudge(s: Solve, i: number): number | null {
  const ids = s.warmNudges(i);
  const item = s.model.items[i]!;
  const buffer = item.len.buffer;
  const clearance = item.len.clearance;
  const lw = s.model.leaders.width;
  let bestStep = -1;
  let bestCost = 0;
  let best: number | null = null;
  for (const [si, c] of ids) {
    if (best !== null && si > bestStep) break;
    const cand = s.cands[c]!;
    if (!s.state.isFree(cand, s.cands, s.obs, i)) continue;
    const t = cand.cost + s.state.dynamicCost(cand, s.cands, s.obs, buffer, clearance, lw, i);
    if (best === null || t < bestCost) {
      bestStep = si;
      bestCost = t;
      best = c;
    }
  }
  return best;
}

function capMayHit(s: Solve, band: readonly number[]): boolean {
  const m = s.model.maxLabels;
  if (m !== null && s.state.nPlaced + band.length > m) return true;
  return s.model.maxInkFraction !== null;
}

function capAllows(s: Solve, c: Cand): boolean {
  const m = s.model.maxLabels;
  if (m !== null && s.state.nPlaced >= m) return false;
  const f = s.model.maxInkFraction;
  const canvas = s.model.canvas;
  if (f !== null && canvas !== null) {
    if ((s.state.labelAreaSum + c.rect.area()) / maxf(canvas.area(), 1e-9) > f) return false;
  }
  return true;
}

/**
 * Process an item (or its whole keep_with set). Returns whether it was placed. With
 * `ladder = false` only level-0 candidates are tried and a failing item stays undecided
 * (deferred); with `ladder = true` the full ladder runs and failures are final.
 */
function processUnit(s: Solve, g: Greedy, i: number, ladder: boolean): boolean {
  const si = g.sets[i]!;
  if (si >= 0) {
    const members = g.setMembers[si]!.slice();
    const membersSorted = members.slice().sort((a, b) => s.pri.prio[a]!.rank - s.pri.prio[b]!.rank);
    const placedNow: number[] = [];
    let failed = -1;
    for (const m of membersSorted) {
      if (s.state.placed[m]! >= 0) continue;
      if (placeItem(s, g, m, true)) placedNow.push(m);
      else {
        failed = m;
        break;
      }
    }
    if (failed >= 0) {
      for (const m of placedNow) unplaceItem(s, g, m);
      for (const m of members) {
        g.done[m] = 1;
        if (s.state.placed[m]! < 0 && s.reasons[m] === null) s.reasons[m] = Reason.KeepWith;
      }
      if (s.reasons[failed] === Reason.KeepWith || s.reasons[failed] === null) s.reasons[failed] = explain(s, failed);
      return false;
    }
    for (const m of members) g.done[m] = 1;
    return true;
  }
  if (!ladder) {
    // level 0 only
    const c = bestLevel0(s, g, i);
    if (c !== null) {
      if (capAllows(s, s.cands[c]!)) {
        commit(s, g, i, c, false);
        g.done[i] = 1;
        return true;
      }
      g.done[i] = 1;
      g.capReached = true;
      s.reasons[i] = Reason.OmittedByPriority;
      if (s.trace !== null) s.trace.omitted(i);
      return false;
    }
    return false;
  }
  return placeItem(s, g, i, true);
}

/** Try level 0 and then the ladder. Marks the item done; sets the reason on failure. */
function placeItem(s: Solve, g: Greedy, i: number, ladder: boolean): boolean {
  g.done[i] = 1;
  const c0 = bestLevel0(s, g, i);
  if (c0 !== null) {
    if (!capAllows(s, s.cands[c0]!)) {
      g.capReached = true;
      s.reasons[i] = Reason.OmittedByPriority;
      if (s.trace !== null) s.trace.omitted(i);
      return false;
    }
    commit(s, g, i, c0, false);
    return true;
  }
  if (!ladder) {
    s.reasons[i] = explain(s, i);
    if (s.trace !== null) s.trace.omitted(i);
    return false;
  }
  // a label the previous solve degraded keeps its box while that is free (ADR motion/warm-starts)
  if (s.model.weights.stability > 0) {
    const c = s.warmLadderCandidate(i);
    if (c !== null && s.state.isFree(s.cands[c]!, s.cands, s.obs, i)) {
      if (!capAllows(s, s.cands[c]!)) {
        g.capReached = true;
        s.reasons[i] = Reason.OmittedByPriority;
        if (s.trace !== null) s.trace.omitted(i);
        return false;
      }
      commit(s, g, i, c, false);
      return true;
    }
  }
  const steps = s.model.ladder.slice();
  for (let si = 0; si < steps.length; si++) {
    const step = steps[si]!;
    s.stepsTried[i]!.push(stepName(step));
    let choice: [number, boolean] | null;
    let ids: readonly number[] = [];
    if (step.kind === "omit") break;
    else if (step.kind === "evict_lower") {
      choice = g.maxKeyPlaced > s.pri.prio[i]!.key ? evictLower(s, g, i) : null;
    } else if (step.kind === "soft_overlap") {
      choice = s.obs.anyRelaxableHard() ? bestFree(s, s.byItem[i]!.slice(), true) : null;
    } else {
      ids = s.ladderCandidates(i, si);
      choice = bestFree(s, ids, false);
    }
    if (s.trace !== null) s.trace.ladder(i, stepName(step), ids, choice === null ? null : choice[0]);
    if (choice !== null) {
      const [c, relaxed] = choice;
      if (!capAllows(s, s.cands[c]!)) {
        g.capReached = true;
        s.reasons[i] = Reason.OmittedByPriority;
        if (s.trace !== null) s.trace.omitted(i);
        return false;
      }
      commit(s, g, i, c, relaxed);
      return true;
    }
  }
  s.reasons[i] = explain(s, i);
  if (s.trace !== null) s.trace.omitted(i);
  return false;
}

function commit(s: Solve, g: Greedy, i: number, c: number, relaxed: boolean): void {
  s.state.place(i, c, s.cands, relaxed);
  const ki = s.pri.prio[i]!.key;
  if (ki > g.maxKeyPlaced) g.maxKeyPlaced = ki;
  s.reasons[i] = null;
  // kill conflicting level-0 candidates of other undecided items
  const cand = s.cands[c]!;
  const ids = g.ids;
  s.candIx.query(cand.bbox().inflate(1e-6 + s.state.leaderReach(s.obs) + s.state.marginMax()), ids);
  const all: number[] = [];
  for (let q = 0; q < ids.len; q++) all.push(ids.get(q));
  lowerAffected(s, i, c, all);
  const dy = s.obs.dynamic;
  const killed: number[] | null = s.trace !== null ? [] : null;
  for (const k of all) {
    if (!g.alive[k]) continue;
    const j = s.cands[k]!.item;
    if (j === i || s.state.placed[j]! >= 0) continue;
    if (pairConflict(s.cands[k]!, cand, dy, s.state.spacing(i, j)) || s.state.pairLower(s.cands[k]!, cand)) {
      g.alive[k] = 0;
      g.live[j] -= 1;
      if (killed !== null) killed.push(k);
      // re-queue with its new live count, but only within the running band (items of
      // later bands must not be placed before this band's ladder pass)
      if (!g.done[j] && g.bandKey === s.pri.prio[j]!.key) g.heap.push(g.live[j]!, s.pri.prio[j]!.rank, j);
    }
  }
  if (killed !== null) s.trace!.placed(i, c, killed);
}

/**
 * With the `lower_items` rule, the label `c` of item `i` also excludes the labels of the
 * less important items whose marks it covers, wherever they are, and the labels of more
 * important items that would cover the mark of `i`: their level-0 candidates join `ids`.
 */
function lowerAffected(s: Solve, i: number, c: number, ids: number[]): void {
  const mark = s.state.markBBox(i);
  if (mark === null) return;
  const covered: number[] = [];
  s.state.lowerCovered(s.cands[c]!, covered);
  for (const j of covered) for (const k of s.byItem[j]!) if (k < s.nLevel0) ids.push(k);
  const near = new IdList();
  s.candIx.query(mark, near);
  for (let q = 0; q < near.len; q++) ids.push(near.get(q));
}

function unplaceItem(s: Solve, g: Greedy, i: number): void {
  const c = s.state.placed[i]!;
  if (c < 0) return;
  s.state.unplace(i, s.cands);
  // The item's own level-0 candidates were not updated while it was placed (commits only
  // kill candidates of unplaced items): recompute them against the current state.
  let live = 0;
  for (const k of s.byItem[i]!.slice()) {
    if (k >= s.nLevel0) continue;
    const ok = s.cands[k]!.feasible && s.state.isFree(s.cands[k]!, s.cands, s.obs, i);
    g.alive[k] = ok ? 1 : 0;
    live += ok ? 1 : 0;
  }
  g.live[i] = live;
  // revive level-0 candidates that only conflicted with this label
  const ids = new IdList();
  s.candIx.query(s.cands[c]!.bbox().inflate(1e-6 + s.state.leaderReach(s.obs) + s.state.marginMax()), ids);
  const all: number[] = [];
  for (let q = 0; q < ids.len; q++) all.push(ids.get(q));
  lowerAffected(s, i, c, all);
  for (const k of all) {
    if (g.alive[k] || !s.cands[k]!.feasible) continue;
    const j = s.cands[k]!.item;
    if (s.state.placed[j]! >= 0) continue;
    if (s.state.isFree(s.cands[k]!, s.cands, s.obs, j)) {
      g.alive[k] = 1;
      g.live[j] += 1;
    }
  }
}

/** Best live level-0 candidate with lookahead. */
function bestLevel0(s: Solve, g: Greedy, i: number): number | null {
  const item = s.model.items[i]!;
  const buffer = item.len.buffer;
  const clearance = item.len.clearance;
  const lw = s.model.leaders.width;
  const scoredCost: number[] = [];
  const scoredId: number[] = [];
  const byItem = s.byItem[i]!;
  const n0 = s.nLevel0;
  for (let q = 0; q < byItem.length; q++) {
    const c = byItem[q]!;
    if (c >= n0 || !g.alive[c]) continue;
    const cand = s.cands[c]!;
    const d = s.state.dynamicCost(cand, s.cands, s.obs, buffer, clearance, lw, i);
    scoredCost.push(cand.cost + d);
    scoredId.push(c);
  }
  // on-demand distant candidates: only when they could beat the best adjacent one
  let bestAdj = Infinity;
  for (const x of scoredCost) bestAdj = minf(bestAdj, x);
  if (s.distantPending[i] && bestAdj > s.leaderCostBound(i)) s.ensureDistant(i);
  const late = s.byItem[i]!.filter((c) => c >= n0 && s.cands[c]!.level === 0 && s.cands[c]!.feasible);
  for (const c of late) {
    const cand = s.cands[c]!;
    if (!s.state.isFree(cand, s.cands, s.obs, i)) continue;
    const d = s.state.dynamicCost(cand, s.cands, s.obs, buffer, clearance, lw, i);
    scoredCost.push(cand.cost + d);
    scoredId.push(c);
  }
  const m = scoredId.length;
  const tr = s.trace;
  if (m === 0) {
    if (tr !== null) tr.scored(i, scoredId, scoredCost, null, null, null);
    return null;
  }
  const idx: number[] = [];
  for (let k = 0; k < m; k++) idx.push(k);
  idx.sort((a, b) => cmpF64(scoredCost[a]!, scoredCost[b]!) || scoredId[a]! - scoredId[b]!);
  const w = s.model.weights;
  if (w.lookahead === 0 && w.starve === 0) {
    if (tr !== null) tr.scored(i, scoredId, scoredCost, null, null, scoredId[idx[0]!]!);
    return scoredId[idx[0]!]!;
  }
  let bestTotal = Infinity;
  let bestC = 4294967295;
  const laIds: number[] | null = tr !== null ? [] : null;
  const laVals: number[] | null = tr !== null ? [] : null;
  for (let t = 0; t < m && t < LOOKAHEAD_TOP; t++) {
    const base = scoredCost[idx[t]!]!;
    // the lookahead is never negative: a candidate (and every later one) whose cost alone
    // exceeds the best total cannot win
    if (base > bestTotal) break;
    const c = scoredId[idx[t]!]!;
    const la = lookahead(s, g, i, c);
    if (laIds !== null) {
      laIds.push(c);
      laVals!.push(la);
    }
    const total = base + la;
    if (total < bestTotal || (total === bestTotal && c < bestC)) {
      bestTotal = total;
      bestC = c;
    }
  }
  if (tr !== null) tr.scored(i, scoredId, scoredCost, laIds, laVals, bestC);
  return bestC;
}

function lookahead(s: Solve, g: Greedy, i: number, c: number): number {
  const cand = s.cands[c]!;
  const ids = g.ids;
  s.candIx.query(cand.bbox().inflate(1e-6 + s.state.leaderReach(s.obs) + s.state.marginMax()), ids);
  const dy = s.obs.dynamic;
  for (let q = 0; q < ids.len; q++) {
    const k = ids.get(q);
    if (!g.alive[k]) continue;
    const j = s.cands[k]!.item;
    if (j === i || g.done[j]) continue;
    if (pairConflict(s.cands[k]!, cand, dy, s.state.spacing(i, j)) || s.state.pairLower(s.cands[k]!, cand)) {
      if (g.killed[j] === 0) g.touched.push(j);
      g.killed[j] += 1;
    }
  }
  const w = s.model.weights;
  let la = 0;
  let starve = 0;
  for (const j of g.touched) {
    const lj = g.live[j]!;
    const live = lj > 1 ? lj : 1;
    const k = g.killed[j]!;
    la += k / live;
    if (k >= lj) starve += 1;
    g.killed[j] = 0;
  }
  g.touched.length = 0;
  return w.lookahead * la + w.starve * starve;
}

/**
 * Cheapest feasible (or, with `relaxed`, relaxed-feasible) free candidate among `ids`.
 * Lazily generated candidates are evaluated only when they are free.
 */
function bestFree(s: Solve, ids: readonly number[], relaxed: boolean): [number, boolean] | null {
  let bestTotal = 0;
  let bestC = -1;
  for (const c of ids) {
    const i = s.cands[c]!.item;
    // lazily generated candidates are evaluated once they are free
    const fresh = !s.cands[c]!.evaluated;
    if (fresh) {
      if (!s.state.isFree(s.cands[c]!, s.cands, s.obs, i)) continue;
      s.ensureEval(c);
    }
    const cand = s.cands[c]!;
    const usable = relaxed ? !cand.feasible && cand.relaxed : cand.feasible;
    if (!usable) continue;
    const item = s.model.items[i]!;
    if (!fresh && !s.state.isFree(cand, s.cands, s.obs, i)) continue;
    const d = s.state.dynamicCost(cand, s.cands, s.obs, item.len.buffer, item.len.clearance, s.model.leaders.width, i);
    const total = cand.cost + d + (relaxed ? cand.relaxCost : 0);
    if (bestC < 0 || total < bestTotal || (total === bestTotal && c < bestC)) {
      bestTotal = total;
      bestC = c;
    }
  }
  return bestC < 0 ? null : [bestC, relaxed];
}

/** evict_lower: displace strictly lower-key labels (fewest, then lowest priority, then cost). */
function evictLower(s: Solve, g: Greedy, i: number): [number, boolean] | null {
  const keyI = s.pri.prio[i]!.key;
  const ids = s.byItem[i]!.slice();
  // (eviction rank, candidate, evicted items)
  let best: [number, number, number, number, number[]] | null = null;
  const confl: number[] = [];
  for (const c of ids) {
    s.ensureEval(c);
    const cand = s.cands[c]!;
    if (!cand.feasible) continue;
    s.state.conflicts(cand, s.cands, s.obs, i, confl);
    if (confl.length === 0) continue; // would have been chosen already
    if (!confl.every((j) => s.pri.prio[j]!.key > keyI && !s.model.items[j]!.required)) continue;
    let gain = -0;
    for (const j of confl) gain += s.pri.prio[j]!.gain;
    const s0 = confl.length;
    const s1 = gain;
    const s2 = cand.cost;
    let better: boolean;
    if (best === null) better = true;
    else {
      const [b0, b1, b2, bc] = best;
      better = s0 < b0 || (s0 === b0 && (s1 < b1 || (s1 === b1 && (s2 < b2 || (s2 === b2 && c < bc)))));
    }
    if (better) best = [s0, s1, s2, c, confl.slice()];
  }
  if (best === null) return null;
  const c = best[3];
  for (const j of best[4]) {
    unplaceItem(s, g, j);
    // evicted items have strictly lower keys: they are processed again with their band
    g.done[j] = 0;
    g.tried0[j] = 0;
    s.reasons[j] = null;
  }
  if (s.trace !== null) s.trace.evicted(i, best[4]);
  return [c, false];
}

/**
 * Statically feasible candidates an explanation looks at (the cheapest of the kept ones,
 * or the first ones found by `Solve.feasibleUnfiltered`).
 */
export const EXPLAIN_CANDIDATES = 5;

/**
 * Why item `i` could not be placed. Without a statically feasible candidate among its
 * kept ones, the candidates that the placed labels blocked while they were generated
 * decide (they were dropped then, spec §6.7): `omitted_by_priority` when one of them is
 * statically feasible (kept in `s.blockedFeasible[i]` for `blocked_by`).
 */
export function explain(s: Solve, i: number): Reason {
  const soft = s.model.ladder.some((st) => stepEq(st, { kind: "soft_overlap" }));
  // ladder candidates are evaluated lazily: one never evaluated is not known to be feasible
  const anyStatic = s.byItem[i]!.some((c) => {
    s.ensureEval(c);
    const cd = s.cands[c]!;
    return cd.feasible || (cd.relaxed && soft);
  });
  if (anyStatic) return Reason.OmittedByPriority;
  const found = s.feasibleUnfiltered(i, EXPLAIN_CANDIDATES);
  s.blockedFeasible[i] = found;
  return found.length > 0 ? Reason.OmittedByPriority : Reason.NoFeasibleCandidate;
}

