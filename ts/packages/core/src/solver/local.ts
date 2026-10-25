/**
 * Local search (spec §10.2): simulated annealing over relocate / swap / insert moves;
 * port of `rust/crates/la-core/src/solver/local.rs`.
 *
 * Invariants: hard feasibility always holds; the priority objective of the omission mode
 * never gets worse (strict: placed key multiset, lexicographically; prefix: prefix length;
 * weighted: tier-wise weight sums); cost changes are accepted by the Metropolis rule with
 * a geometric temperature schedule over a deterministic iteration budget (ADR solver/time-budget).
 *
 * @module
 */

import { envNow, envProgress } from "../env.js";
import { EPS, type Rect } from "../geom/index.js";
import { cmpF64, exp, ln, maxf } from "../math.js";
import { Omission } from "../model/index.js";
import { Pcg32 } from "../pcg.js";
import { keepWithSets } from "../priority.js";
import { Reason, type Solve } from "./index.js";
import { inverted } from "./verify.js";

/**
 * Moves per millisecond of `time_budget_ms` in TypeScript. Rust uses 100 with its 2.5×
 * smaller default budget, so both run the same number of moves (ADR solver/time-budget).
 */
export const MOVES_PER_MS = 40;
/** The Rust rate (used by the `rust` budget profile of the parity tests). */
export const MOVES_PER_MS_RUST = 100;

export interface LocalStats {
  iterations: number;
  accepted: number;
  inserted: number;
}

/** Total cost of item `i` at candidate `c` given the other placed labels. */
function itemCost(s: Solve, i: number, c: number): number {
  const item = s.model.items[i]!;
  const cand = s.cands[c]!;
  const relax = !cand.feasible ? cand.relaxCost : 0;
  const d = s.state.dynamicCost(cand, s.cands, s.obs, item.len.buffer, item.len.clearance, s.model.leaders.width, i);
  return cand.cost + relax + d;
}

/** Whether item `i` may use candidate `c` statically. */
function usable(s: Solve, c: number, softOk: boolean): boolean {
  s.ensureEval(c);
  const cand = s.cands[c]!;
  return cand.feasible || (softOk && cand.relaxed);
}

/** Candidates an insertion tries (the cheapest usable ones, from a random offset). */
const INSERT_TRIES = 12;

/** Candidates a relocation chain tries to free by relocating their single blocker. */
const CHAIN_TRIES = 16;

/**
 * The number of candidates {@link tryInsert} tries for item `u` (it draws its random
 * offset below this number).
 */
function insertTries(s: Solve, u: number, softOk: boolean): number {
  const list = s.byItem[u]!;
  let k = 0;
  for (let j = 0; j < list.length && k < INSERT_TRIES; j++) if (usable(s, list[j]!, softOk)) k += 1;
  return k;
}

function isFree(s: Solve, i: number, c: number): boolean {
  return s.state.isFree(s.cands[c]!, s.cands, s.obs, i);
}

function place(s: Solve, i: number, c: number): void {
  const relaxed = !s.cands[c]!.feasible;
  s.state.place(i, c, s.cands, relaxed);
  s.reasons[i] = null;
}

/** `seed ^ 0x9E37_79B9` on a 64-bit seed (a non-negative safe integer). */
function seedXor(seed: number): number {
  const hi = Math.floor(seed / 4294967296);
  const lo = seed % 4294967296;
  return hi * 4294967296 + ((lo ^ 0x9e3779b9) >>> 0);
}

function sameArray(a: Int32Array, b: Int32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function run(s: Solve, iterations: number, deadlineMs: number): LocalStats {
  const n = s.model.items.length;
  const st: LocalStats = { iterations: 0, accepted: 0, inserted: 0 };
  if (n === 0 || iterations === 0) return st;
  const softOk = s.model.ladder.some((x) => x.kind === "soft_overlap");
  const mode = s.model.omission;
  const rng = new Pcg32(seedXor(s.model.solver.seed));
  const sets = new Array<boolean>(n).fill(false);
  for (const set of keepWithSets(s.model)) for (const i of set) sets[i] = true;
  // temperature from probe moves
  const probes: number[] = [];
  for (let p = 0; p < 50; p++) {
    const i = rng.nextBelow(n);
    const cur = s.state.placed[i]!;
    if (cur < 0) continue;
    const list = s.byItem[i]!;
    if (list.length < 2) continue;
    const k = list[rng.nextBelow(list.length)]!;
    if (k === cur || !usable(s, k, softOk)) continue;
    const a = s.cands[cur]!.cost;
    const b = s.cands[k]!.cost;
    if (b > a) probes.push(b - a);
  }
  probes.sort(cmpF64);
  const t0 = maxf(probes.length > 0 ? probes[probes.length >> 1]! : 0.1, 1e-6);
  const lnRatio = ln(1e-3);
  const scratch: number[] = [];
  // best-so-far: the cheapest state seen since the last priority improvement
  let cur = total(s);
  let best = cur;
  let snapshot = s.state.placed.slice();
  let snapReasons = s.reasons.slice();
  // Every state change is an accepted move, so `st.accepted` versions the state. An
  // insertion that failed on this version fails again (an attempt rolls back whatever it
  // tried, and below the label cap the order of its tries does not matter): a retry only
  // draws the random offset it would draw (prefix mode retries the first omitted item at
  // every insertion move).
  const failedAt = new Array<number>(n).fill(-1);
  const tr = s.trace;
  if (tr !== null) tr.anneal(iterations, t0, cur);
  for (let it = 0; it < iterations; it++) {
    if (it % 256 === 0) {
      if (envNow(s.env) > deadlineMs && deadlineMs > 0) {
        s.timeGuardHit = true;
        break;
      }
      if (s.pollCancel()) break;
      envProgress(s.env, "local", it / iterations);
    }
    st.iterations += 1;
    const temp = t0 * exp((lnRatio * it) / iterations);
    const r = rng.nextF64();
    const anyUnplaced = s.state.nPlaced < n;
    if (r < 0.2 && anyUnplaced) {
      // insertion (ejection chain)
      let u = -1;
      if (mode === Omission.Prefix) {
        for (const i of s.pri.order) {
          if (s.state.placed[i]! < 0) {
            u = i;
            break;
          }
        }
      } else {
        // pick an unplaced item, biased to higher priority: two draws, keep the better
        const a = rng.nextBelow(n);
        const b = rng.nextBelow(n);
        const pick = s.pri.prio[a]!.rank < s.pri.prio[b]!.rank ? a : b;
        if (s.state.placed[pick]! < 0) u = pick;
      }
      if (u < 0) {
        if (tr !== null) tr.move(it, "insert", u, -1, -1, -1, -1, 0, null, temp, "idle", "labeled", cur, best);
        continue;
      }
      const ru = s.reasons[u];
      if (sets[u] || ru === Reason.KeepWith || ru === Reason.Grouped || ru === Reason.BudgetExhausted) {
        if (tr !== null) tr.move(it, "insert", u, -1, -1, -1, -1, 0, null, temp, "idle", "excluded", cur, best);
        continue;
      }
      const m = s.model.maxLabels;
      if (m !== null && s.state.nPlaced >= m && mode !== Omission.Strict) {
        if (tr !== null) tr.move(it, "insert", u, -1, -1, -1, -1, 0, null, temp, "idle", "cap", cur, best);
        continue;
      }
      if (failedAt[u] === st.accepted) {
        const tries = insertTries(s, u, softOk);
        if (tries > 0) rng.nextBelow(tries);
        if (tr !== null) tr.move(it, "insert", u, -1, -1, -1, -1, 0, null, temp, "idle", "known", cur, best);
        continue;
      }
      if (tryInsert(s, u, softOk, sets, rng, scratch)) {
        st.inserted += 1;
        st.accepted += 1;
        // the priority objective improved: this state becomes the new reference
        cur = total(s);
        best = cur;
        snapshot = s.state.placed.slice();
        snapReasons = s.reasons.slice();
        if (tr !== null) tr.move(it, "insert", u, -1, s.state.placed[u]!, -1, -1, 0, null, temp, "inserted", null, cur, best);
      } else {
        if (!capFull(s)) failedAt[u] = st.accepted;
        if (tr !== null) tr.move(it, "insert", u, -1, -1, -1, -1, 0, null, temp, "not_inserted", null, cur, best);
      }
      continue;
    }
    // relocate or swap
    const i = rng.nextBelow(n);
    const curC = s.state.placed[i]!;
    if (curC < 0) {
      if (tr !== null) tr.move(it, "relocate", i, -1, -1, -1, -1, 0, null, temp, "idle", "unlabeled", cur, best);
      continue;
    }
    const listLen = s.byItem[i]!.length;
    if (listLen < 2) {
      if (tr !== null) tr.move(it, "relocate", i, curC, -1, -1, -1, 0, null, temp, "idle", "single", cur, best);
      continue;
    }
    const k = s.byItem[i]![rng.nextBelow(listLen)]!;
    if (k === curC || !usable(s, k, softOk)) {
      if (tr !== null) tr.move(it, "relocate", i, curC, k, -1, -1, 0, null, temp, "idle", "same", cur, best);
      continue;
    }
    const old = itemCost(s, i, curC);
    s.state.unplace(i, s.cands);
    s.state.conflicts(s.cands[k]!, s.cands, s.obs, i, scratch);
    if (scratch.length === 0) {
      const nw = itemCost(s, i, k);
      const delta = nw - old;
      if (delta <= 0 || rng.nextF64() < exp(-delta / temp)) {
        place(s, i, k);
        st.accepted += 1;
        cur += delta;
        if (cur < best - 1e-9) {
          best = cur;
          snapshot = s.state.placed.slice();
          snapReasons = s.reasons.slice();
        }
        if (tr !== null) tr.move(it, "relocate", i, curC, k, -1, -1, 0, delta, temp, delta <= 0 ? "improved" : "accepted", null, cur, best);
      } else {
        place(s, i, curC);
        if (tr !== null) tr.move(it, "relocate", i, curC, k, -1, -1, 0, delta, temp, "rejected", null, cur, best);
      }
      continue;
    }
    if (scratch.length === 1 && r < 0.5) {
      // swap: relocate the single blocker j
      const j = scratch[0]!;
      const jc = s.state.placed[j]!;
      const oldJ = itemCost(s, j, jc);
      s.state.unplace(j, s.cands);
      place(s, i, k);
      const newI = itemCost(s, i, k);
      let bestJc = 0;
      let bestJ = -1;
      const jlist = s.byItem[j]!.slice();
      for (const kj of jlist) {
        if (kj === jc || !usable(s, kj, softOk) || !isFree(s, j, kj)) continue;
        const cj = itemCost(s, j, kj);
        if (bestJ < 0 || cj < bestJc) {
          bestJc = cj;
          bestJ = kj;
        }
      }
      if (bestJ >= 0) {
        const delta = newI + bestJc - old - oldJ;
        if (delta <= 0 || rng.nextF64() < exp(-delta / temp)) {
          place(s, j, bestJ);
          st.accepted += 1;
          cur += delta;
          if (cur < best - 1e-9) {
            best = cur;
            snapshot = s.state.placed.slice();
            snapReasons = s.reasons.slice();
          }
          if (tr !== null) tr.move(it, "swap", i, curC, k, j, bestJ, 1, delta, temp, delta <= 0 ? "improved" : "accepted", null, cur, best);
          continue;
        }
        s.state.unplace(i, s.cands);
        place(s, i, curC);
        place(s, j, jc);
        if (tr !== null) tr.move(it, "swap", i, curC, k, j, bestJ, 1, delta, temp, "rejected", null, cur, best);
      } else {
        s.state.unplace(i, s.cands);
        place(s, i, curC);
        place(s, j, jc);
        if (tr !== null) tr.move(it, "swap", i, curC, k, j, -1, 1, null, temp, "no_room", null, cur, best);
      }
      continue;
    }
    place(s, i, curC);
    if (tr !== null) tr.move(it, "relocate", i, curC, k, -1, -1, scratch.length, null, temp, "blocked", null, cur, best);
  }
  // Restore the best state if the walk ended above it. `best` adds up the moves' cost
  // changes, which count the moved labels' own costs (static, and dynamic against the other
  // labels) but not what a move changes in the dynamic costs of the other labels (a leader
  // through another label's buffer ring): the snapshot stays only when its total is lower
  // than the walk's.
  if (!sameArray(snapshot, s.state.placed)) {
    const end = total(s);
    if (end > best + 1e-9) {
      const walked = s.state.placed.slice();
      const walkedReasons = s.reasons;
      s.reasons = snapReasons;
      setPlacement(s, snapshot);
      if (total(s) >= end) {
        setPlacement(s, walked);
        s.reasons = walkedReasons;
      }
      if (tr !== null) tr.pass("local", "restore", []);
    }
  }
  return st;
}

/** Replace the placement by `placed` (the reasons stay as they are). */
function setPlacement(s: Solve, placed: Int32Array): void {
  const reasons = s.reasons.slice();
  for (let i = 0; i < placed.length; i++) s.state.unplace(i, s.cands);
  for (let i = 0; i < placed.length; i++) {
    const c = placed[i]!;
    if (c >= 0) place(s, i, c);
  }
  s.reasons = reasons;
}

/** Total cost of the current placement (static + relaxation + dynamic). */
function total(s: Solve): number {
  let t = 0;
  for (let i = 0; i < s.model.items.length; i++) {
    const c = s.state.placed[i]!;
    if (c >= 0) t += itemCost(s, i, c);
  }
  return t;
}

/** Undo log for compound moves: every item's state before its first change. */
class Tx {
  log: [number, number, Reason | null][] = [];

  touch(s: Solve, i: number): void {
    if (!this.log.some((x) => x[0] === i)) this.log.push([i, s.state.placed[i]!, s.reasons[i]!]);
  }

  unplace(s: Solve, i: number): void {
    this.touch(s, i);
    s.state.unplace(i, s.cands);
  }

  place(s: Solve, i: number, c: number): void {
    this.touch(s, i);
    place(s, i, c);
  }

  rollback(s: Solve): void {
    setItems(s, this.log);
  }
}

/**
 * Try to place unplaced item `u`: directly, by relocating blockers (ejection chain of
 * depth ≤ 3), or — when the omission mode allows it — by evicting blockers whose removal
 * improves the priority objective.
 */
function tryInsert(s: Solve, u: number, softOk: boolean, sets: readonly boolean[], rng: Pcg32, scratch: number[]): boolean {
  const ids = s.byItem[u]!.slice();
  const scoredCost: number[] = [];
  const scoredId: number[] = [];
  for (const c of ids) {
    if (!usable(s, c, softOk)) continue;
    const cand = s.cands[c]!;
    scoredCost.push(cand.cost + (cand.feasible ? 0 : cand.relaxCost));
    scoredId.push(c);
  }
  const idx: number[] = [];
  for (let k = 0; k < scoredId.length; k++) idx.push(k);
  idx.sort((a, b) => cmpF64(scoredCost[a]!, scoredCost[b]!) || scoredId[a]! - scoredId[b]!);
  const tries = idx.length < INSERT_TRIES ? idx.length : INSERT_TRIES;
  const offset = tries > 0 ? rng.nextBelow(tries) : 0;
  const keyU = s.pri.prio[u]!.key;
  const mode = s.model.omission;
  for (let t = 0; t < tries; t++) {
    const c = scoredId[idx[(t + offset) % tries]!]!;
    s.state.conflicts(s.cands[c]!, s.cands, s.obs, u, scratch);
    const blockers = scratch.slice();
    if (blockers.length === 0) {
      const tx = new Tx();
      if (capFull(s) && !evictOneLower(s, u, sets, tx)) return false;
      tx.place(s, u, c);
      if (inverts(s, tx)) {
        tx.rollback(s);
        continue;
      }
      return true;
    }
    if (blockers.length > 2) continue;
    // ejection chain: relocate the blockers (they stay placed)
    const tx = new Tx();
    const saved: [number, number][] = blockers.map((j) => [j, s.state.placed[j]!]);
    for (const [j] of saved) tx.unplace(s, j);
    tx.place(s, u, c);
    let ok = true;
    for (const [j, jc] of saved) {
      if (!relocateChain(s, j, jc, 2, softOk, tx)) {
        ok = false;
        break;
      }
    }
    if (ok && !capFullAfterInsert(s) && !inverts(s, tx)) return true;
    tx.rollback(s);
    // eviction (priority-improving): strict → all blockers have strictly lower keys;
    // weighted → same tier and the weights improve
    let evictable = blockers.every((j) => !sets[j] && !s.model.items[j]!.required);
    if (evictable) {
      if (mode === Omission.Strict) evictable = blockers.every((j) => s.pri.prio[j]!.key > keyU);
      else if (mode === Omission.Weighted) {
        const pu = s.pri.prio[u]!;
        let sum = -0;
        for (const j of blockers) sum += s.pri.prio[j]!.weight;
        evictable = blockers.every((j) => tierLe(s.pri.prio[j]!, pu)) && sum < pu.weight;
      } else evictable = false;
    }
    if (evictable) {
      const tx2 = new Tx();
      for (const j of blockers) {
        tx2.unplace(s, j);
        s.reasons[j] = Reason.OmittedByPriority;
      }
      tx2.place(s, u, c);
      if (inverts(s, tx2)) {
        tx2.rollback(s);
        continue;
      }
      return true;
    }
  }
  return false;
}

/**
 * Whether the insertion logged in `tx` lets an omitted item become placeable once labels
 * of strictly lower key are removed (the removal test of the verification, spec §9.2),
 * where it was not before. Only with weighted omission, which no priority repair follows
 * (spec §10.3): moving a more important label aside can free the room such an item needed
 * but for a less important label, the one inserted say. The items watched are those with
 * a candidate meeting a label the insertion placed, moved or removed.
 */
function inverts(s: Solve, tx: Tx): boolean {
  if (s.model.omission !== Omission.Weighted) return false;
  const reach = s.state.leaderReach(s.obs) + s.state.marginMax() + 2 * EPS;
  const changed: Rect[] = [];
  for (const [j, old] of tx.log) {
    if (old >= 0) changed.push(s.cands[old]!.bbox().inflate(reach));
    const c = s.state.placed[j]!;
    if (c >= 0) changed.push(s.cands[c]!.bbox().inflate(reach));
  }
  const buf: number[] = [];
  const after: number[] = [];
  for (let h = 0; h < s.model.items.length; h++) {
    if (s.state.placed[h]! >= 0) continue;
    const meets = s.byItem[h]!.some((c) => {
      const b = s.cands[c]!.bbox();
      return changed.some((r) => r.touches(b));
    });
    if (meets && inverted(s, h, buf)) after.push(h);
  }
  if (after.length === 0) return false;
  // back to the state before the insertion for the removal test, then forward again
  const now = tx.log.map(([i]) => [i, s.state.placed[i]!, s.reasons[i]!] as const);
  setItems(s, tx.log);
  const created = after.some((h) => !inverted(s, h, buf));
  setItems(s, now);
  return created;
}

/** Set the labels and reasons of the items in `states` (item, candidate or -1, reason). */
function setItems(s: Solve, states: readonly (readonly [number, number, Reason | null])[]): void {
  for (const [i] of states) s.state.unplace(i, s.cands);
  for (const [i, c, reason] of states) {
    if (c >= 0) place(s, i, c);
    s.reasons[i] = reason;
  }
}

/** `(required, tier, reserved)` of `a` ≤ that of `b` (lexicographic, `false < true`). */
function tierLe(a: { required: boolean; tier: number; reserved: boolean }, b: { required: boolean; tier: number; reserved: boolean }): boolean {
  if (a.required !== b.required) return !a.required;
  if (a.tier !== b.tier) return a.tier < b.tier;
  if (a.reserved !== b.reserved) return !a.reserved;
  return true;
}

function capFull(s: Solve): boolean {
  const m = s.model.maxLabels;
  return m !== null && s.state.nPlaced >= m;
}

function capFullAfterInsert(s: Solve): boolean {
  const m = s.model.maxLabels;
  return m !== null && s.state.nPlaced > m;
}

/**
 * Make room under the label cap by evicting the lowest-priority placed label, if it has a
 * strictly lower key than `u`.
 */
function evictOneLower(s: Solve, u: number, sets: readonly boolean[], tx: Tx): boolean {
  const keyU = s.pri.prio[u]!.key;
  let worst = -1;
  const order = s.pri.order;
  for (let k = order.length - 1; k >= 0; k--) {
    if (s.state.placed[order[k]!]! >= 0) {
      worst = order[k]!;
      break;
    }
  }
  if (worst >= 0 && s.pri.prio[worst]!.key > keyU && !sets[worst] && !s.model.items[worst]!.required) {
    tx.unplace(s, worst);
    s.reasons[worst] = Reason.OmittedByPriority;
    return true;
  }
  return false;
}

/**
 * Re-place item `j` (currently unplaced, previously at `old`) at another free candidate;
 * if none is free, relocate one of its blockers recursively (`depth` levels).
 */
function relocateChain(s: Solve, j: number, old: number, depth: number, softOk: boolean, tx: Tx): boolean {
  const list = s.byItem[j]!.slice();
  let bestCost = 0;
  let bestK = -1;
  // the first blocker of each of the first CHAIN_TRIES candidates (-1: none)
  const blocker = new Int32Array(Math.min(list.length, CHAIN_TRIES)).fill(-1);
  for (let q = 0; q < list.length; q++) {
    const k = list[q]!;
    if (k === old || !usable(s, k, softOk)) continue;
    const b = s.state.firstConflict(s.cands[k]!, s.cands, s.obs, j, Infinity);
    if (b >= 0) {
      if (q < CHAIN_TRIES) blocker[q] = b;
      continue;
    }
    const c = itemCost(s, j, k);
    if (bestK < 0 || c < bestCost) {
      bestCost = c;
      bestK = k;
    }
  }
  if (bestK >= 0) {
    tx.place(s, j, bestK);
    return true;
  }
  if (depth === 0) return false;
  // Every branch below restores the placement it changes, so the blockers found above
  // stay valid: a candidate has a single blocker when nothing else conflicts with it.
  for (let q = 0; q < blocker.length; q++) {
    const b = blocker[q]!;
    if (b < 0) continue;
    const k = list[q]!;
    if (s.state.firstConflict(s.cands[k]!, s.cands, s.obs, j, Infinity, b) >= 0) continue;
    const bc = s.state.placed[b]!;
    tx.unplace(s, b);
    tx.place(s, j, k);
    if (relocateChain(s, b, bc, depth - 1, softOk, tx)) return true;
    // undo this branch (b back to bc, j unplaced again)
    s.state.unplace(j, s.cands);
    place(s, b, bc);
  }
  return false;
}
