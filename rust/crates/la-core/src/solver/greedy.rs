//! Greedy placement with the degradation ladder (spec §10.1, ADR 0009).

use super::{Reason, Solve};
use crate::candidates::Cand;
use crate::leaders::{cand_leaders_conflict, leader_hits_label, Spacing};
use crate::model::opts::{Omission, Step};
use crate::obstacles::Dynamic;
use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// Exact hard conflict between two candidates of different items; `sp`: the spacing
/// rules between their leaders.
pub fn pair_conflict(a: &Cand, b: &Cand, dy: &Dynamic, sp: Spacing) -> bool {
    if dy.label_labels.is_hard() && a.label_overlaps_gap(b, sp.gap) {
        return true;
    }
    if dy.leader_labels.is_hard() {
        for l in &a.leaders {
            if leader_hits_label(l, &b.rect, sp.gap) {
                return true;
            }
        }
        for l in &b.leaders {
            if leader_hits_label(l, &a.rect, sp.gap) {
                return true;
            }
        }
    }
    dy.leader_leaders.is_hard() && cand_leaders_conflict(a, b, sp)
}

/// Number of lookahead-evaluated cheapest candidates.
const LOOKAHEAD_TOP: usize = 8;

struct Greedy {
    alive: Vec<bool>,
    live: Vec<u32>,
    done: Vec<bool>,
    heap: BinaryHeap<(Reverse<u32>, Reverse<usize>, usize)>,
    killed: Vec<u32>,
    touched: Vec<usize>,
    /// Level-0 attempt failed in the current band pass.
    tried0: Vec<bool>,
    sets: Vec<Option<usize>>,
    set_members: Vec<Vec<usize>>,
    cap_reached: bool,
    /// Largest key level among placed labels (evict_lower needs a lower-key label).
    max_key_placed: usize,
    /// Key of the band whose level-0 pass is running (only its items enter the heap).
    band_key: Option<usize>,
}

pub fn run(s: &mut Solve) {
    let n = s.model.items.len();
    let mut g = Greedy {
        alive: s.cands[..s.n_level0].iter().map(|c| c.feasible).collect(),
        live: vec![0; n],
        done: vec![false; n],
        heap: BinaryHeap::new(),
        killed: vec![0; n],
        touched: Vec::new(),
        tried0: vec![false; n],
        sets: vec![None; n],
        set_members: Vec::new(),
        cap_reached: false,
        max_key_placed: 0,
        band_key: None,
    };
    for k in 0..s.n_level0 {
        if g.alive[k] {
            g.live[s.cands[k].item as usize] += 1;
        }
    }
    // non-representative group members are labeled by their representative
    for i in 0..n {
        if let Some(r) = s.model.group_of.get(i).copied().flatten() {
            if r != i {
                g.done[i] = true;
                s.reasons[i] = Some(Reason::Grouped);
            }
        }
    }
    for (si, set) in crate::priority::keep_with_sets(s.model)
        .into_iter()
        .enumerate()
    {
        for &i in &set {
            g.sets[i] = Some(si);
        }
        g.set_members.push(set);
    }
    // the guard runs from the start of this pass: preparation always completes, and its
    // time must not leave the most important bands unplaced (ADR 0042)
    let budget_guard = s.model.solver.time_budget_ms * 10.0;
    let started = s.now();
    if s.model.omission == Omission::Prefix {
        let order = s.pri.order.clone();
        let mut cut = false;
        // after the guard, level 0 only (ADR 0048): the first item without a free
        // level-0 position ends the prefix, and the guard of that pass ends it as well
        let mut finish: Option<f64> = None;
        for (k, &i) in order.iter().enumerate() {
            if g.done[i] {
                continue;
            }
            if !cut && k % 64 == 63 {
                match finish {
                    None if guard_passed(s, started, budget_guard) => {
                        s.time_guard_hit = true;
                        finish = Some(s.now());
                    }
                    Some(f) if guard_passed(s, f, budget_guard) => cut = true,
                    _ => {}
                }
            }
            if s.time_guard_hit && !g.cap_reached {
                if !cut && !place_level0(s, &mut g, i) && !g.done[i] {
                    cut = true;
                }
                if !g.done[i] {
                    g.done[i] = true;
                    s.reasons[i] = Some(Reason::BudgetExhausted);
                }
                continue;
            }
            if cut || g.cap_reached {
                g.done[i] = true;
                s.reasons[i] = Some(Reason::OmittedByPriority);
                continue;
            }
            // level 0 and then the ladder (spec §10.1), in total order; the first item
            // that fails every step cuts the prefix
            if !process_unit(s, &mut g, i, true) {
                cut = true;
            }
        }
        return;
    }
    // bands in key order
    let order = s.pri.order.clone();
    let mut r = 0;
    while r < order.len() {
        let key = s.pri.prio[order[r]].key;
        let mut band = Vec::new();
        while r < order.len() && s.pri.prio[order[r]].key == key {
            band.push(order[r]);
            r += 1;
        }
        s.env
            .progress("greedy", (r - band.len()) as f64 / order.len() as f64);
        let cancelled = s.poll_cancel();
        if cancelled || s.time_guard_hit || guard_passed(s, started, budget_guard) {
            s.time_guard_hit |= !cancelled;
            // after the guard the undecided items wait for the level-0 pass below
            exhaust(s, &mut g, &band, false);
            continue;
        }
        // a band that may hit a cap is processed in total order (caps follow priority)
        let capped = cap_may_hit(s, &band);
        let mut deferred: Vec<usize> = Vec::new();
        if capped {
            for (k, &i) in band.iter().enumerate() {
                if g.done[i] {
                    continue;
                }
                if k % 64 == 63 && guard_passed(s, started, budget_guard) {
                    s.time_guard_hit = true;
                    break;
                }
                if label_cap_reached(s) {
                    // nothing later in the total order can be placed: evict_lower only
                    // evicts lower keys, and none is placed yet
                    g.done[i] = true;
                    s.reasons[i] = Some(Reason::OmittedByPriority);
                    continue;
                }
                process_unit(s, &mut g, i, true);
            }
            exhaust(s, &mut g, &band, false);
            continue;
        }
        // warm start: labels placed in the previous solve keep their position when it is
        // still free (stability first; within one band, so priority is unaffected)
        if s.model.weights.stability > 0.0 {
            for &i in &band {
                if g.done[i] || g.sets[i].is_some() {
                    continue;
                }
                let Some(c) = s.warm_cand[i] else { continue };
                if g.alive[c as usize] && cap_allows(s, &s.cands[c as usize]) {
                    commit(s, &mut g, i, c, false);
                    g.done[i] = true;
                }
            }
            // a warm box that a small change blocked: the nearest free spot along the
            // slider path instead
            for &i in &band {
                if g.done[i] || g.sets[i].is_some() {
                    continue;
                }
                if let Some(c) = best_nudge(s, i) {
                    if cap_allows(s, &s.cands[c as usize]) {
                        commit(s, &mut g, i, c, false);
                        g.done[i] = true;
                    }
                }
            }
        }
        // level-0 pass, most constrained first
        g.heap.clear();
        g.band_key = Some(key);
        for &i in &band {
            if !g.done[i] {
                g.heap
                    .push((Reverse(g.live[i]), Reverse(s.pri.prio[i].rank), i));
            }
        }
        let mut popped = 0usize;
        while let Some((Reverse(cnt), _, i)) = g.heap.pop() {
            if g.done[i] || g.tried0[i] || cnt != g.live[i] {
                continue;
            }
            popped += 1;
            if popped.is_multiple_of(64) {
                if s.poll_cancel() {
                    break;
                }
                if guard_passed(s, started, budget_guard) {
                    s.time_guard_hit = true;
                    break;
                }
            }
            if !process_unit(s, &mut g, i, false) && !g.done[i] {
                g.tried0[i] = true;
                deferred.push(i);
            }
        }
        g.band_key = None;
        // ladder pass in total order
        crate::sort::sort_by_key(&mut deferred, |&i| s.pri.prio[i].rank);
        for (k, &i) in deferred.iter().enumerate() {
            if s.time_guard_hit || g.done[i] || s.poll_cancel() {
                continue;
            }
            if k % 64 == 63 && guard_passed(s, started, budget_guard) {
                s.time_guard_hit = true;
                continue;
            }
            process_unit(s, &mut g, i, true);
        }
        exhaust(s, &mut g, &band, false);
    }
    if s.time_guard_hit && !s.cancelled {
        finish_level0(s, &mut g, budget_guard);
    }
    let all: Vec<usize> = (0..n).collect();
    exhaust(s, &mut g, &all, true);
}

/// After the greedy guard (ADR 0048): the undecided items, in total order, get their best
/// free level-0 candidate — no ladder, no explanation of a failure — until the guard passes
/// once more from the start of this pass; whatever is left is `budget_exhausted`.
fn finish_level0(s: &mut Solve, g: &mut Greedy, guard: f64) {
    let started = s.now();
    let order = s.pri.order.clone();
    let mut tried = 0usize;
    for &i in &order {
        if g.done[i] || s.state.placed[i].is_some() {
            continue;
        }
        tried += 1;
        if tried.is_multiple_of(64) && (s.poll_cancel() || guard_passed(s, started, guard)) {
            break;
        }
        place_level0(s, g, i);
    }
}

/// The best free level-0 candidate of undecided item `i`, after the greedy guard (ADR 0048).
/// Not for members of a `keep_with` set (placed together or not at all) or items whose
/// level-0 attempt already failed (their candidates have not become freer since). A cap
/// that the candidate would exceed omits the item; any other failure leaves it undecided.
fn place_level0(s: &mut Solve, g: &mut Greedy, i: usize) -> bool {
    if g.sets[i].is_some() || g.tried0[i] {
        return false;
    }
    let Some(c) = best_level0(s, g, i) else {
        return false;
    };
    g.done[i] = true;
    if !cap_allows(s, &s.cands[c as usize]) {
        g.cap_reached = true;
        s.reasons[i] = Some(Reason::OmittedByPriority);
        return false;
    }
    commit(s, g, i, c, false);
    true
}

/// Whether the greedy guard has passed: `guard` ms after `started` (ADR 0042; never
/// without a clock).
fn guard_passed(s: &Solve, started: f64, guard: f64) -> bool {
    s.now() > 0.0 && s.now() - started > guard
}

/// Whether `priority.budget.max_labels` labels are placed.
fn label_cap_reached(s: &Solve) -> bool {
    s.model.max_labels.is_some_and(|m| s.state.n_placed >= m)
}

/// After a cancellation, or at the end of the pass after the time guard (`last`: its
/// level-0 pass is over), the undecided items of `band` are `budget_exhausted`.
fn exhaust(s: &mut Solve, g: &mut Greedy, band: &[usize], last: bool) {
    if !(s.cancelled || (last && s.time_guard_hit)) {
        return;
    }
    for &i in band {
        if !g.done[i] && s.state.placed[i].is_none() {
            g.done[i] = true;
            s.reasons[i] = Some(Reason::BudgetExhausted);
        }
    }
}

/// The free nudge of item `i`'s warm-start box with the smallest step, the cheaper of
/// the two directions on a tie (see [`Solve::warm_nudges`]).
fn best_nudge(s: &mut Solve, i: usize) -> Option<u32> {
    let ids = s.warm_nudges(i);
    let item = &s.model.items[i];
    let (buffer, clearance) = (item.len.buffer, item.len.clearance);
    let lw = s.model.leaders.width;
    let mut scratch = Vec::new();
    let mut best: Option<(usize, f64, u32)> = None;
    for (si, c) in ids {
        if best.is_some_and(|b| si > b.0) {
            break;
        }
        let cand = &s.cands[c as usize];
        if !s.state.is_free(cand, &s.cands, s.obs, i, &mut scratch) {
            continue;
        }
        let t = cand.cost
            + s.state
                .dynamic_cost(cand, &s.cands, s.obs, buffer, clearance, lw, i);
        if best.map(|b| t < b.1).unwrap_or(true) {
            best = Some((si, t, c));
        }
    }
    best.map(|b| b.2)
}

fn cap_may_hit(s: &Solve, band: &[usize]) -> bool {
    if let Some(m) = s.model.max_labels {
        if s.state.n_placed + band.len() > m {
            return true;
        }
    }
    s.model.max_ink_fraction.is_some()
}

fn cap_allows(s: &Solve, c: &Cand) -> bool {
    if let Some(m) = s.model.max_labels {
        if s.state.n_placed >= m {
            return false;
        }
    }
    if let (Some(f), Some(canvas)) = (s.model.max_ink_fraction, s.model.canvas) {
        if (s.state.label_area_sum + c.rect.area()) / canvas.area().max(1e-9) > f {
            return false;
        }
    }
    true
}

/// Process an item (or its whole keep_with set). Returns whether it was placed.
/// With `ladder = false` only level-0 candidates are tried and a failing item stays
/// undecided (deferred); with `ladder = true` the full ladder runs and failures are final.
fn process_unit(s: &mut Solve, g: &mut Greedy, i: usize, ladder: bool) -> bool {
    if let Some(si) = g.sets[i] {
        let members = g.set_members[si].clone();
        let mut members_sorted = members.clone();
        crate::sort::sort_by_key(&mut members_sorted, |&m| s.pri.prio[m].rank);
        let mut placed_now = Vec::new();
        let mut failed: Option<usize> = None;
        for &m in &members_sorted {
            if s.state.placed[m].is_some() {
                continue;
            }
            if place_item(s, g, m, true) {
                placed_now.push(m);
            } else {
                failed = Some(m);
                break;
            }
        }
        if let Some(f) = failed {
            for &m in &placed_now {
                unplace_item(s, g, m);
            }
            for &m in &members {
                g.done[m] = true;
                if s.state.placed[m].is_none() && s.reasons[m].is_none() {
                    s.reasons[m] = Some(Reason::KeepWith);
                }
            }
            if s.reasons[f] == Some(Reason::KeepWith) || s.reasons[f].is_none() {
                s.reasons[f] = Some(explain(s, f));
            }
            return false;
        }
        for &m in &members {
            g.done[m] = true;
        }
        return true;
    }
    if !ladder {
        // level 0 only
        if let Some(c) = best_level0(s, g, i) {
            if cap_allows(s, &s.cands[c as usize]) {
                commit(s, g, i, c, false);
                g.done[i] = true;
                return true;
            }
            g.done[i] = true;
            g.cap_reached = true;
            s.reasons[i] = Some(Reason::OmittedByPriority);
            return false;
        }
        return false;
    }
    place_item(s, g, i, true)
}

/// Try level 0 and then the ladder. Marks the item done; sets the reason on failure.
fn place_item(s: &mut Solve, g: &mut Greedy, i: usize, ladder: bool) -> bool {
    g.done[i] = true;
    if let Some(c) = best_level0(s, g, i) {
        if !cap_allows(s, &s.cands[c as usize]) {
            g.cap_reached = true;
            s.reasons[i] = Some(Reason::OmittedByPriority);
            return false;
        }
        commit(s, g, i, c, false);
        return true;
    }
    if !ladder {
        s.reasons[i] = Some(explain(s, i));
        return false;
    }
    // a label the previous solve degraded keeps its box while that is free (ADR 0025)
    if s.model.weights.stability > 0.0 {
        if let Some(c) = s.warm_ladder_candidate(i) {
            let mut scratch = Vec::new();
            if s.state
                .is_free(&s.cands[c as usize], &s.cands, s.obs, i, &mut scratch)
            {
                if !cap_allows(s, &s.cands[c as usize]) {
                    g.cap_reached = true;
                    s.reasons[i] = Some(Reason::OmittedByPriority);
                    return false;
                }
                commit(s, g, i, c, false);
                return true;
            }
        }
    }
    let steps = s.model.ladder.clone();
    for (si, step) in steps.iter().enumerate() {
        s.steps_tried[i].push(step.name());
        let choice = match step {
            Step::Omit => break,
            Step::EvictLower => {
                if g.max_key_placed > s.pri.prio[i].key {
                    evict_lower(s, g, i)
                } else {
                    None
                }
            }
            Step::SoftOverlap => {
                if s.obs.any_relaxable_hard() {
                    let ids: Vec<u32> = s.by_item[i].clone();
                    best_free(s, &ids, true)
                } else {
                    None
                }
            }
            _ => {
                let ids = s.ladder_candidates(i, si);
                best_free(s, &ids, false)
            }
        };
        if let Some((c, relaxed)) = choice {
            if !cap_allows(s, &s.cands[c as usize]) {
                g.cap_reached = true;
                s.reasons[i] = Some(Reason::OmittedByPriority);
                return false;
            }
            commit(s, g, i, c, relaxed);
            return true;
        }
    }
    s.reasons[i] = Some(explain(s, i));
    false
}

fn commit(s: &mut Solve, g: &mut Greedy, i: usize, c: u32, relaxed: bool) {
    s.state.place(i, c, &s.cands, relaxed);
    g.max_key_placed = g.max_key_placed.max(s.pri.prio[i].key);
    s.reasons[i] = None;
    // kill conflicting level-0 candidates of other undecided items
    let bb = s.cands[c as usize].bbox();
    let mut ids = Vec::new();
    s.cand_ix.query(
        &bb.inflate(1e-6 + s.state.leader_reach(s.obs) + s.state.margin_max()),
        &mut ids,
    );
    lower_affected(s, i, c, &mut ids);
    let dy = s.obs.dynamic;
    for k in ids {
        let k = k as usize;
        if !g.alive[k] {
            continue;
        }
        let j = s.cands[k].item as usize;
        if j == i || s.state.placed[j].is_some() {
            continue;
        }
        let sp = s.state.spacing(i, j);
        if pair_conflict(&s.cands[k], &s.cands[c as usize], &dy, sp)
            || s.state.pair_lower(&s.cands[k], &s.cands[c as usize])
        {
            g.alive[k] = false;
            g.live[j] -= 1;
            // re-queue with its new live count, but only within the running band (items
            // of later bands must not be placed before this band's ladder pass)
            if !g.done[j] && g.band_key == Some(s.pri.prio[j].key) {
                g.heap
                    .push((Reverse(g.live[j]), Reverse(s.pri.prio[j].rank), j));
            }
        }
    }
}

/// With the `lower_items` rule, the label `c` of item `i` also excludes the labels of the
/// less important items whose marks it covers, wherever they are, and the labels of more
/// important items that would cover the mark of `i`: their level-0 candidates join `ids`.
fn lower_affected(s: &mut Solve, i: usize, c: u32, ids: &mut Vec<u32>) {
    let Some(mark) = s.state.mark_bbox(i) else {
        return;
    };
    let mut covered = Vec::new();
    s.state.lower_covered(&s.cands[c as usize], &mut covered);
    for j in covered {
        ids.extend(
            s.by_item[j as usize]
                .iter()
                .copied()
                .filter(|&k| (k as usize) < s.n_level0),
        );
    }
    let mut near = Vec::new();
    s.cand_ix.query(&mark, &mut near);
    ids.extend(near);
}

fn unplace_item(s: &mut Solve, g: &mut Greedy, i: usize) {
    let Some(c) = s.state.placed[i] else { return };
    s.state.unplace(i, &s.cands);
    // The item's own level-0 candidates were not updated while it was placed (commits
    // only kill candidates of unplaced items): recompute them against the current state.
    let mut own_scratch = Vec::new();
    let mut live = 0;
    for k in s.by_item[i].clone() {
        let ku = k as usize;
        if ku >= s.n_level0 {
            continue;
        }
        let ok = s.cands[ku].feasible
            && s.state
                .is_free(&s.cands[ku], &s.cands, s.obs, i, &mut own_scratch);
        g.alive[ku] = ok;
        live += ok as u32;
    }
    g.live[i] = live;
    // revive level-0 candidates that only conflicted with this label
    let bb = s.cands[c as usize].bbox();
    let mut ids = Vec::new();
    s.cand_ix.query(
        &bb.inflate(1e-6 + s.state.leader_reach(s.obs) + s.state.margin_max()),
        &mut ids,
    );
    lower_affected(s, i, c, &mut ids);
    let mut scratch = Vec::new();
    for k in ids {
        let k = k as usize;
        if g.alive[k] || !s.cands[k].feasible {
            continue;
        }
        let j = s.cands[k].item as usize;
        if s.state.placed[j].is_some() {
            continue;
        }
        let cand = &s.cands[k];
        if s.state.is_free(cand, &s.cands, s.obs, j, &mut scratch) {
            g.alive[k] = true;
            g.live[j] += 1;
        }
    }
}

/// Best live level-0 candidate with lookahead.
fn best_level0(s: &mut Solve, g: &mut Greedy, i: usize) -> Option<u32> {
    let item = &s.model.items[i];
    let (buffer, clearance) = (item.len.buffer, item.len.clearance);
    let lw = s.model.leaders.width;
    let mut scored: Vec<(f64, u32)> = Vec::new();
    let ids: Vec<u32> = s.by_item[i]
        .iter()
        .copied()
        .filter(|&c| (c as usize) < s.n_level0 && g.alive[c as usize])
        .collect();
    for c in ids {
        let cand = &s.cands[c as usize];
        let d = s
            .state
            .dynamic_cost(cand, &s.cands, s.obs, buffer, clearance, lw, i);
        scored.push((cand.cost + d, c));
    }
    // on-demand distant candidates: only when they could beat the best adjacent one
    let best_adj = scored.iter().map(|x| x.0).fold(f64::INFINITY, f64::min);
    if s.distant_pending[i] && best_adj > s.leader_cost_bound(i) {
        s.ensure_distant(i);
    }
    let mut scratch = Vec::new();
    let late: Vec<u32> = s.by_item[i]
        .iter()
        .copied()
        .filter(|&c| {
            (c as usize) >= s.n_level0
                && s.cands[c as usize].level == 0
                && s.cands[c as usize].feasible
        })
        .collect();
    for c in late {
        let cand = &s.cands[c as usize];
        if !s.state.is_free(cand, &s.cands, s.obs, i, &mut scratch) {
            continue;
        }
        let d = s
            .state
            .dynamic_cost(cand, &s.cands, s.obs, buffer, clearance, lw, i);
        scored.push((cand.cost + d, c));
    }
    if scored.is_empty() {
        return None;
    }
    crate::sort::sort_by(&mut scored, |a, b| {
        crate::math::cmp_f64(a.0, b.0).then(a.1.cmp(&b.1))
    });
    let w = &s.model.weights;
    if w.lookahead == 0.0 && w.starve == 0.0 {
        return Some(scored[0].1);
    }
    let mut best = (f64::INFINITY, u32::MAX);
    for &(base, c) in scored.iter().take(LOOKAHEAD_TOP) {
        // the lookahead is never negative: a candidate (and every later one) whose cost
        // alone exceeds the best total cannot win
        if base > best.0 {
            break;
        }
        let la = lookahead(s, g, i, c);
        let total = base + la;
        if total < best.0 || (total == best.0 && c < best.1) {
            best = (total, c);
        }
    }
    Some(best.1)
}

fn lookahead(s: &Solve, g: &mut Greedy, i: usize, c: u32) -> f64 {
    let cand = &s.cands[c as usize];
    let mut ids = Vec::new();
    s.cand_ix.query(
        &cand
            .bbox()
            .inflate(1e-6 + s.state.leader_reach(s.obs) + s.state.margin_max()),
        &mut ids,
    );
    let dy = s.obs.dynamic;
    for k in ids {
        let k = k as usize;
        if !g.alive[k] {
            continue;
        }
        let j = s.cands[k].item as usize;
        if j == i || g.done[j] {
            continue;
        }
        if pair_conflict(&s.cands[k], cand, &dy, s.state.spacing(i, j))
            || s.state.pair_lower(&s.cands[k], cand)
        {
            if g.killed[j] == 0 {
                g.touched.push(j);
            }
            g.killed[j] += 1;
        }
    }
    let w = &s.model.weights;
    let mut la = 0.0;
    let mut starve = 0.0;
    for &j in &g.touched {
        let live = g.live[j].max(1) as f64;
        let k = g.killed[j] as f64;
        la += k / live;
        if g.killed[j] >= g.live[j] {
            starve += 1.0;
        }
        g.killed[j] = 0;
    }
    g.touched.clear();
    w.lookahead * la + w.starve * starve
}

/// Cheapest feasible (or, with `relaxed`, relaxed-feasible) free candidate among `ids`.
/// Lazily generated candidates are evaluated only when they are free.
fn best_free(s: &mut Solve, ids: &[u32], relaxed: bool) -> Option<(u32, bool)> {
    let mut best: Option<(f64, u32)> = None;
    let mut scratch = Vec::new();
    for &c in ids {
        let cu = c as usize;
        let i = s.cands[cu].item as usize;
        // lazily generated candidates are evaluated once they are free
        let fresh = !s.cands[cu].evaluated;
        if fresh {
            if !s
                .state
                .is_free(&s.cands[cu], &s.cands, s.obs, i, &mut scratch)
            {
                continue;
            }
            s.ensure_eval(c);
        }
        let cand = &s.cands[cu];
        let usable = if relaxed {
            !cand.feasible && cand.relaxed
        } else {
            cand.feasible
        };
        if !usable {
            continue;
        }
        let item = &s.model.items[i];
        if !fresh && !s.state.is_free(cand, &s.cands, s.obs, i, &mut scratch) {
            continue;
        }
        let d = s.state.dynamic_cost(
            cand,
            &s.cands,
            s.obs,
            item.len.buffer,
            item.len.clearance,
            s.model.leaders.width,
            i,
        );
        let total = cand.cost + d + if relaxed { cand.relax_cost } else { 0.0 };
        if best
            .map(|b| total < b.0 || (total == b.0 && c < b.1))
            .unwrap_or(true)
        {
            best = Some((total, c));
        }
    }
    best.map(|b| (b.1, relaxed))
}

/// evict_lower: displace strictly lower-key labels (fewest, then lowest priority, then cost).
fn evict_lower(s: &mut Solve, g: &mut Greedy, i: usize) -> Option<(u32, bool)> {
    let key_i = s.pri.prio[i].key;
    let ids = s.by_item[i].clone();
    // (eviction rank, candidate, evicted items)
    type Choice = ((usize, f64, f64), u32, Vec<u32>);
    let mut best: Option<Choice> = None;
    let mut confl = Vec::new();
    for c in ids {
        s.ensure_eval(c);
        let cand = &s.cands[c as usize];
        if !cand.feasible {
            continue;
        }
        s.state.conflicts(cand, &s.cands, s.obs, i, &mut confl);
        if confl.is_empty() {
            continue; // would have been chosen already
        }
        if !confl
            .iter()
            .all(|&j| s.pri.prio[j as usize].key > key_i && !s.model.items[j as usize].required)
        {
            continue;
        }
        let gain: f64 = confl.iter().map(|&j| s.pri.prio[j as usize].gain).sum();
        let score = (confl.len(), gain, cand.cost);
        let better = match &best {
            None => true,
            Some((b, bc, _)) => {
                score.0 < b.0
                    || (score.0 == b.0
                        && (score.1 < b.1
                            || (score.1 == b.1 && (score.2 < b.2 || (score.2 == b.2 && c < *bc)))))
            }
        };
        if better {
            best = Some((score, c, confl.clone()));
        }
    }
    let (_, c, evict) = best?;
    for j in evict {
        let j = j as usize;
        unplace_item(s, g, j);
        // evicted items have strictly lower keys: they are processed again with their band
        g.done[j] = false;
        g.tried0[j] = false;
        s.reasons[j] = None;
    }
    Some((c, false))
}

/// Statically feasible candidates an explanation looks at (the cheapest of the kept
/// ones, or the first ones found by [`Solve::feasible_unfiltered`]).
pub const EXPLAIN_CANDIDATES: usize = 5;

/// Why item `i` could not be placed. Without a statically feasible candidate among its
/// kept ones, the candidates that the placed labels blocked while they were generated
/// decide (they were dropped then, spec §6.7): `omitted_by_priority` when one of them is
/// statically feasible (kept in `s.blocked_feasible[i]` for `blocked_by`).
pub fn explain(s: &mut Solve, i: usize) -> Reason {
    let soft = s.model.ladder.contains(&Step::SoftOverlap);
    // ladder candidates are evaluated lazily: one never evaluated is not known to be feasible
    let mut any_static = false;
    for k in 0..s.by_item[i].len() {
        let cid = s.by_item[i][k];
        s.ensure_eval(cid);
        let c = &s.cands[cid as usize];
        if c.feasible || c.relaxed && soft {
            any_static = true;
            break;
        }
    }
    if any_static {
        return Reason::OmittedByPriority;
    }
    let found = s.feasible_unfiltered(i, EXPLAIN_CANDIDATES);
    let reason = if found.is_empty() {
        Reason::NoFeasibleCandidate
    } else {
        Reason::OmittedByPriority
    };
    s.blocked_feasible[i] = found;
    reason
}
