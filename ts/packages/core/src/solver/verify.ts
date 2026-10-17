/**
 * Independent verification of the final placement (spec §10.3); port of
 * `rust/crates/la-core/src/solver/verify.rs`.
 *
 * @module
 */

import { Omission } from "../model/index.js";
import { Reason, type Solve } from "./index.js";
import { leadersCross } from "./repair.js";

export interface Verification {
  hardViolations: number;
  leaderCrossings: number;
  priorityInversions: number;
  /** Items removed by the repair step (should never happen). */
  repaired: number[];
}

/**
 * Re-check all hard constraints exactly; repair (remove the lower-priority label of a
 * violating pair) and report.
 */
export function verify(s: Solve): Verification {
  const v: Verification = { hardViolations: 0, leaderCrossings: 0, priorityInversions: 0, repaired: [] };
  const n = s.model.items.length;
  // static feasibility
  for (let i = 0; i < n; i++) {
    const c = s.state.placed[i]!;
    if (c < 0) continue;
    const cand = s.cands[c]!;
    const ok = cand.feasible || (s.state.relaxed[i] === 1 && cand.relaxed);
    if (!ok) {
      v.hardViolations += 1;
      v.repaired.push(i);
    }
  }
  for (const i of v.repaired) {
    s.state.unplace(i, s.cands);
    s.reasons[i] = Reason.NoFeasibleCandidate;
  }
  // pairwise conflicts, lower priority loses
  const buf: number[] = [];
  for (;;) {
    let worst = -1;
    for (let i = 0; i < n; i++) {
      const c = s.state.placed[i]!;
      if (c < 0) continue;
      s.state.conflicts(s.cands[c]!, s.cands, s.obs, i, buf);
      for (const j of buf) {
        const lose = s.pri.prio[i]!.rank > s.pri.prio[j]!.rank ? i : j;
        worst = worst < 0 ? lose : s.pri.prio[lose]!.rank > s.pri.prio[worst]!.rank ? lose : worst;
      }
    }
    if (worst < 0) break;
    v.hardViolations += 1;
    v.repaired.push(worst);
    s.state.unplace(worst, s.cands);
    s.reasons[worst] = Reason.OmittedByPriority;
  }
  // leader crossings (any policy)
  const placed: number[] = [];
  for (let i = 0; i < n; i++) if (s.state.placed[i]! >= 0) placed.push(i);
  for (let a = 0; a < placed.length; a++) {
    const ci = s.cands[s.state.placed[placed[a]!]!]!;
    if (ci.leaders.length === 0) continue;
    for (let b = a + 1; b < placed.length; b++) {
      const cj = s.cands[s.state.placed[placed[b]!]!]!;
      if (cj.leaders.length === 0 || !ci.bbox().touches(cj.bbox())) continue;
      if (leadersCross(ci, cj)) v.leaderCrossings += 1;
    }
  }
  v.priorityInversions = inversions(s);
  return v;
}

/** Count priority inversions (removal test for strict/weighted, prefix property for prefix). */
export function inversions(s: Solve): number {
  const n = s.model.items.length;
  if (s.model.omission === Omission.Prefix) {
    const order = s.pri.order;
    const r = order.findIndex((i) => s.state.placed[i]! < 0);
    if (r < 0) return 0;
    let count = 0;
    for (let k = r; k < order.length; k++) if (s.state.placed[order[k]!]! >= 0) count += 1;
    return count;
  }
  let count = 0;
  const buf: number[] = [];
  for (let h = 0; h < n; h++) if (inverted(s, h, buf)) count += 1;
  return count;
}

/**
 * Whether item `h` is omitted (by priority, or without a feasible candidate) although one
 * of its usable candidates conflicts only with labels of strictly lower key: the removal
 * test of strict and weighted omission (spec §9.2).
 */
export function inverted(s: Solve, h: number, buf: number[]): boolean {
  if (s.state.placed[h]! >= 0) return false;
  const rh = s.reasons[h];
  if (rh !== Reason.OmittedByPriority && rh !== Reason.NoFeasibleCandidate) return false;
  const softOk = s.model.ladder.some((x) => x.kind === "soft_overlap");
  const keyH = s.pri.prio[h]!.key;
  const ids = s.byItem[h]!.slice();
  for (const c of ids) {
    // cheap rejection first: a conflict with a higher- or equal-key label
    let cand = s.cands[c]!;
    if (cand.evaluated && !(cand.feasible || (softOk && cand.relaxed))) continue;
    if (s.state.firstConflict(cand, s.cands, s.obs, h, keyH) >= 0) continue;
    s.ensureEval(c);
    cand = s.cands[c]!;
    if (!(cand.feasible || (softOk && cand.relaxed))) continue;
    s.state.conflicts(cand, s.cands, s.obs, h, buf);
    // placeable once the (strictly) lower-key labels in its way are removed
    if (buf.length > 0 && buf.every((j) => s.pri.prio[j]!.key > keyH)) return true;
  }
  return false;
}
