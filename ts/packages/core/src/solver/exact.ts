/**
 * Exact search (spec §5.6 "exact"): branch and bound over items in priority order on the
 * candidate conflict graph (a maximum-weight independent set); port of
 * `rust/crates/la-core/src/solver/exact.rs`.
 *
 * The objective is the omission mode's priority objective, then the total static cost.
 * The search is limited by a node budget (deterministic) and never returns worse than the
 * incumbent.
 *
 * @module
 */

import { envCancelled } from "../env.js";
import { cmpF64 } from "../math.js";
import { Omission } from "../model/index.js";
import { pairConflict } from "./greedy.js";
import { Reason, type Solve } from "./index.js";

/** Objective: lexicographic priority vector (larger is better), then cost (smaller). */
interface Obj {
  prio: number[];
  cost: number;
}

function better(a: Obj, o: Obj): boolean {
  const n = a.prio.length < o.prio.length ? a.prio.length : o.prio.length;
  for (let k = 0; k < n; k++) {
    const x = a.prio[k]!;
    const y = o.prio[k]!;
    if (x > y) return true;
    if (x < y) return false;
  }
  return a.cost < o.cost - 1e-12;
}

function binarySearch(v: readonly number[], x: number): boolean {
  let lo = 0;
  let hi = v.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const m = v[mid]!;
    if (m === x) return true;
    if (m < x) lo = mid + 1;
    else hi = mid;
  }
  return false;
}

class Search {
  chosen: (number | null)[];
  bestChoice: (number | null)[];
  nodes = 0;

  constructor(
    readonly order: number[],
    /** Candidate ids per item (feasible, cheapest first). */
    readonly cands: number[][],
    /** Conflicting candidate ids per candidate (sorted). */
    readonly conflicts: Map<number, number[]>,
    readonly slot: number[],
    readonly nSlots: number,
    readonly weight: number[],
    readonly minCost: number[],
    readonly cost: readonly number[],
    readonly cancel: () => boolean,
    readonly mode: Omission,
    n: number,
    public best: Obj,
    bestChoice: (number | null)[],
    public maxNodes: number,
  ) {
    this.chosen = new Array<number | null>(n).fill(null);
    this.bestChoice = bestChoice;
  }

  /**
   * Rust's recursive `dfs`. The final call (leave item `order[k]` unplaced) is a tail call
   * and runs as the next iteration of the loop, so the recursion depth is bounded by the
   * number of chosen items rather than the number of items.
   */
  dfs(k0: number, prio: number[], cost0: number, alive0: boolean): void {
    let k = k0;
    const cost = cost0;
    let prefixAlive = alive0;
    const order = this.order;
    for (;;) {
      this.nodes += 1;
      if (this.nodes > this.maxNodes) return;
      if (this.nodes % 4096 === 0 && this.cancel()) {
        this.maxNodes = this.nodes; // stop: keep the best solution found so far
        return;
      }
      if (k === order.length) {
        const o: Obj = { prio: prio.slice(), cost };
        if (better(o, this.best)) {
          this.best = o;
          this.bestChoice = this.chosen.slice();
        }
        return;
      }
      // bound: every remaining item placed at its cheapest candidate
      const opt = prio.slice();
      let optCost = cost;
      for (let q = k; q < order.length; q++) {
        const i = order[q]!;
        if (this.cands[i]!.length > 0 && (this.mode !== Omission.Prefix || prefixAlive)) {
          opt[this.slot[i]!] += this.weight[i]!;
          optCost += this.minCost[i]!;
        }
      }
      if (!better({ prio: opt, cost: optCost }, this.best)) return;
      const i = order[k]!;
      const list = this.cands[i]!.slice();
      if (this.mode !== Omission.Prefix || prefixAlive) {
        for (const c of list) {
          const conf = this.conflicts.get(c);
          let ok = true;
          if (conf !== undefined) {
            for (const o of this.chosen) {
              if (o !== null && binarySearch(conf, o)) {
                ok = false;
                break;
              }
            }
          }
          if (!ok) continue;
          this.chosen[i] = c;
          prio[this.slot[i]!] += this.weight[i]!;
          const cc = this.cost[c]!;
          this.dfs(k + 1, prio, cost + cc, prefixAlive);
          prio[this.slot[i]!] -= this.weight[i]!;
          this.chosen[i] = null;
          if (this.nodes > this.maxNodes) return;
        }
      }
      // leave item i unplaced (tail call)
      k += 1;
      prefixAlive = prefixAlive && this.mode !== Omission.Prefix;
    }
  }
}

/** Run the exact search with a node budget. Returns whether the solution changed. */
export function run(s: Solve, maxNodes: number): boolean {
  const n = s.model.items.length;
  const order = s.pri.order.filter((i) => s.reasons[i] !== Reason.Grouped && s.reasons[i] !== Reason.KeepWith);
  // candidates: evaluated feasible ones (evaluate lazily generated ones)
  const total = s.cands.length;
  for (let c = 0; c < total; c++) if (!s.cands[c]!.evaluated) s.ensureEval(c);
  const cands: number[][] = [];
  for (let i = 0; i < n; i++) cands.push([]);
  for (const i of order) {
    const v = s.byItem[i]!.filter((c) => s.cands[c]!.feasible);
    v.sort((a, b) => cmpF64(s.cands[a]!.cost, s.cands[b]!.cost) || a - b);
    if (v.length > 24) v.length = 24;
    cands[i] = v;
  }
  const pool: number[] = [];
  for (const v of cands) for (const c of v) pool.push(c);
  if (pool.length > 3000) return false;
  const dy = s.obs.dynamic;
  const conflicts = new Map<number, number[]>();
  const addConflict = (a: number, b: number): void => {
    let v = conflicts.get(a);
    if (v === undefined) {
      v = [];
      conflicts.set(a, v);
    }
    v.push(b);
  };
  const reach = s.state.leaderReach(s.obs) + s.state.marginMax();
  const bboxes = pool.map((c) => s.cands[c]!.bbox());
  for (let x = 0; x < pool.length; x++) {
    const a = pool[x]!;
    const ca = s.cands[a]!;
    const bba = bboxes[x]!.inflate(reach);
    for (let y = x + 1; y < pool.length; y++) {
      const b = pool[y]!;
      const cb = s.cands[b]!;
      if (ca.item === cb.item) continue;
      // a label may exclude the label of an item whose mark it covers, wherever that is
      const near = bba.touches(bboxes[y]!);
      if (!near && !s.state.hasLower()) continue;
      if ((near && pairConflict(ca, cb, dy, s.state.spacing(ca.item, cb.item))) || s.state.pairLower(ca, cb)) {
        addConflict(a, b);
        addConflict(b, a);
      }
    }
  }
  for (const v of conflicts.values()) v.sort((a, b) => a - b);
  // priority slots per omission mode
  let slot: number[];
  let nSlots: number;
  let weight: number[];
  if (s.model.omission === Omission.Strict) {
    slot = s.pri.prio.map((p) => p.key);
    nSlots = s.pri.nKeys;
    weight = new Array<number>(n).fill(1);
  } else if (s.model.omission === Omission.Prefix) {
    slot = new Array<number>(n).fill(0);
    nSlots = 1;
    weight = new Array<number>(n).fill(1);
  } else {
    // one slot per (required, tier, reserved) class, in priority order
    const classes: [boolean, number, boolean][] = [];
    const sameClass = (c: [boolean, number, boolean], p: { required: boolean; tier: number; reserved: boolean }): boolean =>
      c[0] === p.required && c[1] === p.tier && c[2] === p.reserved;
    for (const i of s.pri.order) {
      const p = s.pri.prio[i]!;
      if (!classes.some((c) => sameClass(c, p))) classes.push([p.required, p.tier, p.reserved]);
    }
    slot = s.pri.prio.map((p) => {
      const k = classes.findIndex((c) => sameClass(c, p));
      return k < 0 ? 0 : k;
    });
    nSlots = classes.length;
    weight = s.pri.prio.map((p) => p.weight);
  }
  const costs = s.cands.map((c) => c.cost);
  const env = s.env;
  const cancelFn = (): boolean => envCancelled(env);
  const minCost = cands.map((v) => (v.length > 0 ? costs[v[0]!]! : 0));
  // incumbent: the current solution
  const incPrio = new Array<number>(nSlots).fill(0);
  let incCost = 0;
  const chosen = new Array<number | null>(n).fill(null);
  for (const i of order) {
    const c = s.state.placed[i]!;
    if (c >= 0) {
      incPrio[slot[i]!] += weight[i]!;
      incCost += costs[c]!;
      chosen[i] = c;
    }
  }
  if (s.model.omission === Omission.Prefix) {
    let count = 0;
    for (const i of order) {
      if (s.state.placed[i]! < 0) break;
      count += 1;
    }
    incPrio[0] = count;
  }
  const search = new Search(
    order.slice(),
    cands,
    conflicts,
    slot,
    nSlots,
    weight,
    minCost,
    costs,
    cancelFn,
    s.model.omission,
    n,
    { prio: incPrio, cost: incCost },
    chosen.slice(),
    maxNodes,
  );
  const prio = new Array<number>(search.nSlots).fill(0);
  search.dfs(0, prio, 0, true);
  const bestChoice = search.bestChoice;
  let same = true;
  for (let i = 0; i < n; i++) {
    if (bestChoice[i] !== chosen[i]) {
      same = false;
      break;
    }
  }
  if (s.model.maxLabels !== null || same) return false;
  // apply
  const best = bestChoice.slice();
  for (const i of order) s.state.unplace(i, s.cands);
  for (const i of order) {
    const c = best[i];
    if (c !== null && c !== undefined) {
      const cand = s.cands[c]!;
      if (s.state.isFree(cand, s.cands, s.obs, i)) {
        s.state.place(i, c, s.cands, false);
        s.reasons[i] = null;
        continue;
      }
    }
    if (s.reasons[i] === null) s.reasons[i] = Reason.OmittedByPriority;
  }
  return true;
}
