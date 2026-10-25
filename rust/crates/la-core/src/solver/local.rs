//! Local search (spec §10.2): simulated annealing over relocate / swap / insert moves.
//!
//! Invariants: hard feasibility always holds; the priority objective of the omission mode
//! never gets worse (strict: placed key multiset, lexicographically; prefix: prefix length;
//! weighted: tier-wise weight sums); cost changes are accepted by the Metropolis rule with a
//! geometric temperature schedule over a deterministic iteration budget (ADR solver/time-budget).

use super::{verify, Reason, Solve};
use crate::geom::Rect;
use crate::model::opts::{Omission, Step};
use la_expr::det_math::{exp, Pcg32};

/// Moves per millisecond of `time_budget_ms` (Rust). The TypeScript implementation uses
/// 40 with its 2.5× larger default budget, so both run the same number of moves.
pub const MOVES_PER_MS: f64 = 100.0;

/// Candidates an insertion tries (the cheapest usable ones, from a random offset).
const INSERT_TRIES: usize = 12;

/// Candidates a relocation chain tries to free by relocating their single blocker.
const CHAIN_TRIES: usize = 16;

pub struct LocalStats {
    pub iterations: u64,
    pub accepted: u64,
    pub inserted: u64,
}

/// Total cost of item `i` at candidate `c` given the other placed labels.
fn item_cost(s: &mut Solve, i: usize, c: u32) -> f64 {
    let item = &s.model.items[i];
    let cand = &s.cands[c as usize];
    let relax = if !cand.feasible { cand.relax_cost } else { 0.0 };
    let d = s.state.dynamic_cost(
        cand,
        &s.cands,
        s.obs,
        item.len.buffer,
        item.len.clearance,
        s.model.leaders.width,
        i,
    );
    cand.cost + relax + d
}

/// Whether item `i` may use candidate `c` statically.
fn usable(s: &mut Solve, c: u32, soft_ok: bool) -> bool {
    s.ensure_eval(c);
    let cand = &s.cands[c as usize];
    cand.feasible || (soft_ok && cand.relaxed)
}

/// The number of candidates [`try_insert`] tries for item `u` (it draws its random offset
/// below this number).
fn insert_tries(s: &mut Solve, u: usize, soft_ok: bool) -> u32 {
    let mut k = 0;
    for j in 0..s.by_item[u].len() {
        if k == INSERT_TRIES {
            break;
        }
        let c = s.by_item[u][j];
        k += usable(s, c, soft_ok) as usize;
    }
    k as u32
}

fn is_free(s: &mut Solve, i: usize, c: u32) -> bool {
    let cand = &s.cands[c as usize];
    let mut scratch = Vec::new();
    s.state.is_free(cand, &s.cands, s.obs, i, &mut scratch)
}

fn place(s: &mut Solve, i: usize, c: u32) {
    let relaxed = !s.cands[c as usize].feasible;
    s.state.place(i, c, &s.cands, relaxed);
    s.reasons[i] = None;
}

pub fn run(s: &mut Solve, iterations: u64, deadline_ms: f64) -> LocalStats {
    let n = s.model.items.len();
    let mut st = LocalStats {
        iterations: 0,
        accepted: 0,
        inserted: 0,
    };
    if n == 0 || iterations == 0 {
        return st;
    }
    let soft_ok = s.model.ladder.contains(&Step::SoftOverlap);
    let mode = s.model.omission;
    let mut rng = Pcg32::new(s.model.solver.seed ^ 0x9E37_79B9);
    let sets: Vec<bool> = {
        let mut v = vec![false; n];
        for set in crate::priority::keep_with_sets(s.model) {
            for i in set {
                v[i] = true;
            }
        }
        v
    };
    // temperature from probe moves
    let mut probes: Vec<f64> = Vec::new();
    for _ in 0..50 {
        let i = rng.next_below(n as u32) as usize;
        let Some(cur) = s.state.placed[i] else {
            continue;
        };
        let list = &s.by_item[i];
        if list.len() < 2 {
            continue;
        }
        let k = list[rng.next_below(list.len() as u32) as usize];
        if k == cur || !usable(s, k, soft_ok) {
            continue;
        }
        let a = s.cands[cur as usize].cost;
        let b = s.cands[k as usize].cost;
        if b > a {
            probes.push(b - a);
        }
    }
    crate::sort::sort_by(&mut probes, |a, b| crate::math::cmp_f64(*a, *b));
    let t0 = probes
        .get(probes.len() / 2)
        .copied()
        .unwrap_or(0.1)
        .max(1e-6);
    let ln_ratio = crate::math::ln(1e-3);
    let mut scratch: Vec<u32> = Vec::new();
    // best-so-far: the cheapest state seen since the last priority improvement
    let mut cur = total(s);
    let mut best = cur;
    let mut snapshot: Vec<Option<u32>> = s.state.placed.clone();
    let mut snap_reasons = s.reasons.clone();
    // Every state change is an accepted move, so `st.accepted` versions the state. An
    // insertion that failed on this version fails again (an attempt rolls back whatever it
    // tried, and below the label cap the order of its tries does not matter): a retry only
    // draws the random offset it would draw (prefix mode retries the first omitted item at
    // every insertion move).
    let mut failed_at: Vec<Option<u64>> = vec![None; n];
    for it in 0..iterations {
        if it % 256 == 0 {
            if s.env.now_ms() > deadline_ms && deadline_ms > 0.0 {
                s.time_guard_hit = true;
                break;
            }
            if s.poll_cancel() {
                break;
            }
            s.env.progress("local", it as f64 / iterations as f64);
        }
        st.iterations += 1;
        let temp = t0 * exp(ln_ratio * it as f64 / iterations as f64);
        let r = rng.next_f64();
        let any_unplaced = s.state.n_placed < n;
        if r < 0.2 && any_unplaced {
            // insertion (ejection chain)
            let u = match mode {
                Omission::Prefix => s
                    .pri
                    .order
                    .iter()
                    .copied()
                    .find(|&i| s.state.placed[i].is_none()),
                _ => {
                    // pick an unplaced item, biased to higher priority: two draws, keep the better
                    let a = rng.next_below(n as u32) as usize;
                    let b = rng.next_below(n as u32) as usize;
                    let pick = if s.pri.prio[a].rank < s.pri.prio[b].rank {
                        a
                    } else {
                        b
                    };
                    if s.state.placed[pick].is_none() {
                        Some(pick)
                    } else {
                        None
                    }
                }
            };
            let Some(u) = u else { continue };
            if sets[u]
                || matches!(
                    s.reasons[u],
                    Some(Reason::KeepWith) | Some(Reason::Grouped) | Some(Reason::BudgetExhausted)
                )
            {
                continue;
            }
            if let Some(m) = s.model.max_labels {
                if s.state.n_placed >= m && mode != Omission::Strict {
                    continue;
                }
            }
            if failed_at[u] == Some(st.accepted) {
                let tries = insert_tries(s, u, soft_ok);
                if tries > 0 {
                    rng.next_below(tries);
                }
                continue;
            }
            if try_insert(s, u, soft_ok, &sets, &mut rng, &mut scratch) {
                st.inserted += 1;
                st.accepted += 1;
                // the priority objective improved: this state becomes the new reference
                cur = total(s);
                best = cur;
                snapshot.clone_from(&s.state.placed);
                snap_reasons.clone_from(&s.reasons);
            } else if !cap_full(s) {
                failed_at[u] = Some(st.accepted);
            }
            continue;
        }
        // relocate or swap
        let i = rng.next_below(n as u32) as usize;
        let Some(cur_c) = s.state.placed[i] else {
            continue;
        };
        let list_len = s.by_item[i].len();
        if list_len < 2 {
            continue;
        }
        let k = s.by_item[i][rng.next_below(list_len as u32) as usize];
        if k == cur_c || !usable(s, k, soft_ok) {
            continue;
        }
        let old = item_cost(s, i, cur_c);
        s.state.unplace(i, &s.cands);
        let cand = &s.cands[k as usize];
        s.state.conflicts(cand, &s.cands, s.obs, i, &mut scratch);
        if scratch.is_empty() {
            let new = item_cost(s, i, k);
            let delta = new - old;
            if delta <= 0.0 || rng.next_f64() < exp(-delta / temp) {
                place(s, i, k);
                st.accepted += 1;
                cur += delta;
                if cur < best - 1e-9 {
                    best = cur;
                    snapshot.clone_from(&s.state.placed);
                    snap_reasons.clone_from(&s.reasons);
                }
            } else {
                place(s, i, cur_c);
            }
            continue;
        }
        if scratch.len() == 1 && r < 0.5 {
            // swap: relocate the single blocker j
            let j = scratch[0] as usize;
            let jc = s.state.placed[j].unwrap();
            let old_j = item_cost(s, j, jc);
            s.state.unplace(j, &s.cands);
            place(s, i, k);
            let new_i = item_cost(s, i, k);
            let mut best_j: Option<(f64, u32)> = None;
            let jlist = s.by_item[j].clone();
            for &kj in jlist.iter() {
                if kj == jc || !usable(s, kj, soft_ok) || !is_free(s, j, kj) {
                    continue;
                }
                let cj = item_cost(s, j, kj);
                if best_j.map(|b| cj < b.0).unwrap_or(true) {
                    best_j = Some((cj, kj));
                }
            }
            match best_j {
                Some((cj, kj)) => {
                    let delta = new_i + cj - old - old_j;
                    if delta <= 0.0 || rng.next_f64() < exp(-delta / temp) {
                        place(s, j, kj);
                        st.accepted += 1;
                        cur += delta;
                        if cur < best - 1e-9 {
                            best = cur;
                            snapshot.clone_from(&s.state.placed);
                            snap_reasons.clone_from(&s.reasons);
                        }
                        continue;
                    }
                    s.state.unplace(i, &s.cands);
                    place(s, i, cur_c);
                    place(s, j, jc);
                }
                None => {
                    s.state.unplace(i, &s.cands);
                    place(s, i, cur_c);
                    place(s, j, jc);
                }
            }
            continue;
        }
        place(s, i, cur_c);
    }
    // Restore the best state if the walk ended above it. `best` adds up the moves' cost
    // changes, which count the moved labels' own costs (static, and dynamic against the
    // other labels) but not what a move changes in the dynamic costs of the other labels
    // (a leader through another label's buffer ring): the snapshot stays only when its
    // total is lower than the walk's.
    if snapshot != s.state.placed {
        let end = total(s);
        if end > best + 1e-9 {
            let walked = s.state.placed.clone();
            let walked_reasons = std::mem::replace(&mut s.reasons, snap_reasons);
            set_placement(s, &snapshot);
            if total(s) >= end {
                set_placement(s, &walked);
                s.reasons = walked_reasons;
            }
        }
    }
    st
}

/// Replace the placement by `placed` (the reasons stay as they are).
fn set_placement(s: &mut Solve, placed: &[Option<u32>]) {
    let reasons = s.reasons.clone();
    for i in 0..placed.len() {
        s.state.unplace(i, &s.cands);
    }
    for (i, c) in placed.iter().enumerate() {
        if let Some(c) = *c {
            place(s, i, c);
        }
    }
    s.reasons = reasons;
}

/// Total cost of the current placement (static + relaxation + dynamic).
fn total(s: &mut Solve) -> f64 {
    let mut t = 0.0;
    for i in 0..s.model.items.len() {
        if let Some(c) = s.state.placed[i] {
            t += item_cost(s, i, c);
        }
    }
    t
}

/// Undo log for compound moves: every item's state before its first change.
#[derive(Default)]
struct Tx {
    log: Vec<(usize, Option<u32>, Option<Reason>)>,
}

impl Tx {
    fn touch(&mut self, s: &Solve, i: usize) {
        if !self.log.iter().any(|x| x.0 == i) {
            self.log.push((i, s.state.placed[i], s.reasons[i]));
        }
    }
    fn unplace(&mut self, s: &mut Solve, i: usize) {
        self.touch(s, i);
        s.state.unplace(i, &s.cands);
    }
    fn place(&mut self, s: &mut Solve, i: usize, c: u32) {
        self.touch(s, i);
        place(s, i, c);
    }
    fn rollback(self, s: &mut Solve) {
        set_items(s, &self.log);
    }
}

/// Try to place unplaced item `u`: directly, by relocating blockers (ejection chain of
/// depth ≤ 3), or — when the omission mode allows it — by evicting blockers whose removal
/// improves the priority objective.
fn try_insert(
    s: &mut Solve,
    u: usize,
    soft_ok: bool,
    sets: &[bool],
    rng: &mut Pcg32,
    scratch: &mut Vec<u32>,
) -> bool {
    let ids: Vec<u32> = s.by_item[u].clone();
    let mut scored: Vec<(f64, u32)> = Vec::new();
    for &c in &ids {
        if !usable(s, c, soft_ok) {
            continue;
        }
        let cand = &s.cands[c as usize];
        scored.push((
            cand.cost + if cand.feasible { 0.0 } else { cand.relax_cost },
            c,
        ));
    }
    crate::sort::sort_by(&mut scored, |a, b| {
        crate::math::cmp_f64(a.0, b.0).then(a.1.cmp(&b.1))
    });
    let tries = scored.len().min(INSERT_TRIES);
    let offset = if tries > 0 {
        rng.next_below(tries as u32) as usize
    } else {
        0
    };
    let key_u = s.pri.prio[u].key;
    let mode = s.model.omission;
    for t in 0..tries {
        let c = scored[(t + offset) % tries].1;
        let cand = &s.cands[c as usize];
        s.state.conflicts(cand, &s.cands, s.obs, u, scratch);
        let blockers: Vec<usize> = scratch.iter().map(|&j| j as usize).collect();
        if blockers.is_empty() {
            let mut tx = Tx::default();
            if cap_full(s) && !evict_one_lower(s, u, sets, &mut tx) {
                return false;
            }
            tx.place(s, u, c);
            if inverts(s, &tx) {
                tx.rollback(s);
                continue;
            }
            return true;
        }
        if blockers.len() > 2 {
            continue;
        }
        // ejection chain: relocate the blockers (they stay placed)
        let mut tx = Tx::default();
        let saved: Vec<(usize, u32)> = blockers
            .iter()
            .map(|&j| (j, s.state.placed[j].unwrap()))
            .collect();
        for &(j, _) in &saved {
            tx.unplace(s, j);
        }
        tx.place(s, u, c);
        let mut ok = true;
        for &(j, jc) in &saved {
            if !relocate_chain(s, j, jc, 2, soft_ok, &mut tx) {
                ok = false;
                break;
            }
        }
        if ok && !cap_full_after_insert(s) && !inverts(s, &tx) {
            return true;
        }
        tx.rollback(s);
        // eviction (priority-improving): strict → all blockers have strictly lower keys;
        // weighted → same tier and the weights improve
        let evictable = blockers
            .iter()
            .all(|&j| !sets[j] && !s.model.items[j].required)
            && match mode {
                Omission::Strict => blockers.iter().all(|&j| s.pri.prio[j].key > key_u),
                Omission::Weighted => {
                    let tier_u = (
                        s.pri.prio[u].required,
                        s.pri.prio[u].tier,
                        s.pri.prio[u].reserved,
                    );
                    blockers.iter().all(|&j| {
                        (
                            s.pri.prio[j].required,
                            s.pri.prio[j].tier,
                            s.pri.prio[j].reserved,
                        ) <= tier_u
                    }) && blockers.iter().map(|&j| s.pri.prio[j].weight).sum::<f64>()
                        < s.pri.prio[u].weight
                }
                Omission::Prefix => false,
            };
        if evictable {
            let mut tx = Tx::default();
            for &j in &blockers {
                tx.unplace(s, j);
                s.reasons[j] = Some(Reason::OmittedByPriority);
            }
            tx.place(s, u, c);
            if inverts(s, &tx) {
                tx.rollback(s);
                continue;
            }
            return true;
        }
    }
    false
}

/// Whether the insertion logged in `tx` lets an omitted item become placeable once labels
/// of strictly lower key are removed (the removal test of the verification, spec §9.2),
/// where it was not before. Only with weighted omission, which no priority repair follows
/// (spec §10.3): moving a more important label aside can free the room such an item needed
/// but for a less important label, the one inserted say. The items watched are those with
/// a candidate meeting a label the insertion placed, moved or removed.
fn inverts(s: &mut Solve, tx: &Tx) -> bool {
    if s.model.omission != Omission::Weighted {
        return false;
    }
    let reach = s.state.leader_reach(s.obs) + s.state.margin_max() + 2.0 * crate::geom::EPS;
    let mut changed: Vec<Rect> = Vec::new();
    for &(j, old, _) in &tx.log {
        for c in [old, s.state.placed[j]].into_iter().flatten() {
            changed.push(s.cands[c as usize].bbox().inflate(reach));
        }
    }
    let keys: Vec<usize> = s.pri.prio.iter().map(|p| p.key).collect();
    let mut buf = Vec::new();
    let mut after = Vec::new();
    for h in 0..s.model.items.len() {
        let meets = s.state.placed[h].is_none()
            && s.by_item[h].iter().any(|&c| {
                let b = s.cands[c as usize].bbox();
                changed.iter().any(|r| r.touches(&b))
            });
        if meets && verify::inverted(s, h, &keys, &mut buf) {
            after.push(h);
        }
    }
    if after.is_empty() {
        return false;
    }
    // back to the state before the insertion for the removal test, then forward again
    let new: Vec<(usize, Option<u32>, Option<Reason>)> = tx
        .log
        .iter()
        .map(|&(i, _, _)| (i, s.state.placed[i], s.reasons[i]))
        .collect();
    set_items(s, &tx.log);
    let created = after
        .iter()
        .any(|&h| !verify::inverted(s, h, &keys, &mut buf));
    set_items(s, &new);
    created
}

/// Set the labels and reasons of the items in `states` (item, candidate, reason).
fn set_items(s: &mut Solve, states: &[(usize, Option<u32>, Option<Reason>)]) {
    for &(i, _, _) in states {
        s.state.unplace(i, &s.cands);
    }
    for &(i, c, reason) in states {
        if let Some(c) = c {
            place(s, i, c);
        }
        s.reasons[i] = reason;
    }
}

fn cap_full(s: &Solve) -> bool {
    s.model
        .max_labels
        .map(|m| s.state.n_placed >= m)
        .unwrap_or(false)
}

fn cap_full_after_insert(s: &Solve) -> bool {
    s.model
        .max_labels
        .map(|m| s.state.n_placed > m)
        .unwrap_or(false)
}

/// Make room under the label cap by evicting the lowest-priority placed label, if it has
/// a strictly lower key than `u`.
fn evict_one_lower(s: &mut Solve, u: usize, sets: &[bool], tx: &mut Tx) -> bool {
    let key_u = s.pri.prio[u].key;
    let worst = s
        .pri
        .order
        .iter()
        .rev()
        .copied()
        .find(|&j| s.state.placed[j].is_some());
    match worst {
        Some(j) if s.pri.prio[j].key > key_u && !sets[j] && !s.model.items[j].required => {
            tx.unplace(s, j);
            s.reasons[j] = Some(Reason::OmittedByPriority);
            true
        }
        _ => false,
    }
}

/// Re-place item `j` (currently unplaced, previously at `old`) at another free candidate;
/// if none is free, relocate one of its blockers recursively (`depth` levels).
fn relocate_chain(
    s: &mut Solve,
    j: usize,
    old: u32,
    depth: u32,
    soft_ok: bool,
    tx: &mut Tx,
) -> bool {
    let list = s.by_item[j].clone();
    let mut best: Option<(f64, u32)> = None;
    // the first blocker of each of the first `CHAIN_TRIES` candidates
    let mut blocker = [None; CHAIN_TRIES];
    for (q, &k) in list.iter().enumerate() {
        if k == old || !usable(s, k, soft_ok) {
            continue;
        }
        let cand = &s.cands[k as usize];
        if let Some(b) = s.state.first_conflict(cand, &s.cands, s.obs, j, |_| true) {
            if q < CHAIN_TRIES {
                blocker[q] = Some(b);
            }
            continue;
        }
        let c = item_cost(s, j, k);
        if best.map(|b| c < b.0).unwrap_or(true) {
            best = Some((c, k));
        }
    }
    if let Some((_, k)) = best {
        tx.place(s, j, k);
        return true;
    }
    if depth == 0 {
        return false;
    }
    // Every branch below restores the placement it changes, so the blockers found above
    // stay valid: a candidate has a single blocker when nothing else conflicts with it.
    for (q, &k) in list.iter().enumerate().take(CHAIN_TRIES) {
        let Some(b) = blocker[q] else { continue };
        let cand = &s.cands[k as usize];
        if s.state
            .first_conflict(cand, &s.cands, s.obs, j, |x| x != b)
            .is_some()
        {
            continue;
        }
        let bc = s.state.placed[b].unwrap();
        tx.unplace(s, b);
        tx.place(s, j, k);
        if relocate_chain(s, b, bc, depth - 1, soft_ok, tx) {
            return true;
        }
        // undo this branch (b back to bc, j unplaced again)
        s.state.unplace(j, &s.cands);
        place(s, b, bc);
    }
    false
}
