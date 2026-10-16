//! Greedy placement with the degradation ladder (spec §10.1, ADR 0009).

use super::{Reason, Solve};
use crate::candidates::Cand;
use crate::geom::{seg_intersects, seg_overlaps_rect};
use crate::model::opts::{Omission, Step};
use crate::obstacles::Dynamic;
use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// Exact hard conflict between two candidates of different items.
pub fn pair_conflict(a: &Cand, b: &Cand, dy: &Dynamic) -> bool {
    if dy.label_labels.is_hard() && a.label_overlaps(b) {
        return true;
    }
    if dy.leader_labels.is_hard() {
        for l in &a.leaders {
            if l.segments().any(|(p, q)| seg_overlaps_rect(p, q, &b.rect)) {
                return true;
            }
        }
        for l in &b.leaders {
            if l.segments().any(|(p, q)| seg_overlaps_rect(p, q, &a.rect)) {
                return true;
            }
        }
    }
    if dy.leader_leaders.is_hard() && !a.leaders.is_empty() && !b.leaders.is_empty() {
        for la in &a.leaders {
            for (p, q) in la.segments() {
                for lb in &b.leaders {
                    if lb.segments().any(|(r, s)| seg_intersects(p, q, r, s)) {
                        return true;
                    }
                }
            }
        }
    }
    false
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
    let budget_guard = s.model.solver.time_budget_ms * 10.0;
    if s.model.omission == Omission::Prefix {
        let order = s.pri.order.clone();
        let mut cut = false;
        for &i in &order {
            if g.done[i] {
                continue;
            }
            if cut || g.cap_reached {
                g.done[i] = true;
                s.reasons[i] = Some(Reason::OmittedByPriority);
                continue;
            }
            if !process_unit(s, &mut g, i, false) {
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
        if s.time_guard_hit || (s.now() - s.start_ms > budget_guard && s.now() > 0.0) {
            s.time_guard_hit = true;
            for &i in &band {
                if !g.done[i] {
                    g.done[i] = true;
                    s.reasons[i] = Some(Reason::BudgetExhausted);
                }
            }
            continue;
        }
        // a band that may hit a cap is processed in total order (caps follow priority)
        let capped = cap_may_hit(s, &band);
        let mut deferred: Vec<usize> = Vec::new();
        if capped {
            for &i in &band {
                if !g.done[i] {
                    process_unit(s, &mut g, i, true);
                }
            }
            continue;
        }
        // level-0 pass, most constrained first
        g.heap.clear();
        for &i in &band {
            if !g.done[i] {
                g.heap
                    .push((Reverse(g.live[i]), Reverse(s.pri.prio[i].rank), i));
            }
        }
        while let Some((Reverse(cnt), _, i)) = g.heap.pop() {
            if g.done[i] || g.tried0[i] || cnt != g.live[i] {
                continue;
            }
            if !process_unit(s, &mut g, i, false) && !g.done[i] {
                g.tried0[i] = true;
                deferred.push(i);
            }
        }
        // ladder pass in total order
        deferred.sort_by_key(|&i| s.pri.prio[i].rank);
        for i in deferred {
            if !g.done[i] {
                process_unit(s, &mut g, i, true);
            }
        }
    }
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
        members_sorted.sort_by_key(|&m| s.pri.prio[m].rank);
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
                let ids: Vec<u32> = s.by_item[i].clone();
                best_free(s, &ids, true)
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
    s.cand_ix.query(&bb.inflate(1e-6), &mut ids);
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
        if pair_conflict(&s.cands[k], &s.cands[c as usize], &dy) {
            g.alive[k] = false;
            g.live[j] -= 1;
            if !g.done[j] {
                g.heap
                    .push((Reverse(g.live[j]), Reverse(s.pri.prio[j].rank), j));
            }
        }
    }
}

fn unplace_item(s: &mut Solve, g: &mut Greedy, i: usize) {
    let Some(c) = s.state.placed[i] else { return };
    s.state.unplace(i, &s.cands);
    // revive level-0 candidates that only conflicted with this label
    let bb = s.cands[c as usize].bbox();
    let mut ids = Vec::new();
    s.cand_ix.query(&bb.inflate(1e-6), &mut ids);
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
        if s.state.is_free(&cand, &s.cands, s.obs, j, &mut scratch) {
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
        if !s.state.is_free(&cand, &s.cands, s.obs, i, &mut scratch) {
            continue;
        }
        let d = s
            .state
            .dynamic_cost(&cand, &s.cands, s.obs, buffer, clearance, lw, i);
        scored.push((cand.cost + d, c));
    }
    if scored.is_empty() {
        return None;
    }
    scored.sort_by(|a, b| crate::math::cmp_f64(a.0, b.0).then(a.1.cmp(&b.1)));
    let w = &s.model.weights;
    if w.lookahead == 0.0 && w.starve == 0.0 {
        return Some(scored[0].1);
    }
    let mut best = (f64::INFINITY, u32::MAX);
    for &(base, c) in scored.iter().take(LOOKAHEAD_TOP) {
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
    s.cand_ix.query(&cand.bbox().inflate(1e-6), &mut ids);
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
        if pair_conflict(&s.cands[k], cand, &dy) {
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
        s.state.conflicts(&cand, &s.cands, s.obs, i, &mut confl);
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

/// Why item `i` could not be placed.
pub fn explain(s: &Solve, i: usize) -> Reason {
    let any_static = s.by_item[i].iter().any(|&c| {
        let c = &s.cands[c as usize];
        c.feasible || c.relaxed && s.model.ladder.contains(&Step::SoftOverlap)
    });
    if any_static {
        Reason::OmittedByPriority
    } else {
        Reason::NoFeasibleCandidate
    }
}
