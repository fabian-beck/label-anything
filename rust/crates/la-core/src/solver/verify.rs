//! Independent verification of the final placement (spec §10.3).

use super::{Reason, Solve};
use crate::candidates::Cand;
use crate::geom::{seg_intersects, Rect};
use crate::model::opts::{Omission, Step};

#[derive(Clone, Debug, Default)]
pub struct Verification {
    pub hard_violations: usize,
    pub leader_crossings: usize,
    pub priority_inversions: usize,
    /// Items removed by the repair step (should never happen).
    pub repaired: Vec<usize>,
}

/// Re-check all hard constraints exactly; repair (remove the lower-priority label of a
/// violating pair) and report.
pub fn verify(s: &mut Solve) -> Verification {
    let mut v = Verification::default();
    let n = s.model.items.len();
    // static feasibility
    for i in 0..n {
        let Some(c) = s.state.placed[i] else { continue };
        let cand = &s.cands[c as usize];
        let ok = cand.feasible || (s.state.relaxed[i] && cand.relaxed);
        if !ok {
            v.hard_violations += 1;
            v.repaired.push(i);
        }
    }
    for &i in &v.repaired {
        s.state.unplace(i, &s.cands);
        s.reasons[i] = Some(Reason::NoFeasibleCandidate);
    }
    // pairwise conflicts, lower priority loses
    let mut buf = Vec::new();
    loop {
        let mut worst: Option<usize> = None;
        for i in 0..n {
            let Some(c) = s.state.placed[i] else { continue };
            let cand = &s.cands[c as usize];
            s.state.conflicts(cand, &s.cands, s.obs, i, &mut buf);
            for &j in &buf {
                let j = j as usize;
                let lose = if s.pri.prio[i].rank > s.pri.prio[j].rank {
                    i
                } else {
                    j
                };
                worst = Some(
                    worst
                        .map(|w| {
                            if s.pri.prio[lose].rank > s.pri.prio[w].rank {
                                lose
                            } else {
                                w
                            }
                        })
                        .unwrap_or(lose),
                );
            }
        }
        match worst {
            Some(w) => {
                v.hard_violations += 1;
                v.repaired.push(w);
                s.state.unplace(w, &s.cands);
                s.reasons[w] = Some(Reason::OmittedByPriority);
            }
            None => break,
        }
    }
    // leader crossings (any policy): placed labels with leaders, and their boxes
    let led: Vec<(&Cand, Rect)> = s
        .state
        .placed
        .iter()
        .flatten()
        .map(|&c| &s.cands[c as usize])
        .filter(|c| !c.leaders.is_empty())
        .map(|c| (c, c.bbox()))
        .collect();
    for (a, &(ci, bi)) in led.iter().enumerate() {
        for &(cj, bj) in &led[a + 1..] {
            if !bi.touches(&bj) {
                continue;
            }
            let crosses = ci.leaders.iter().any(|la| {
                la.segments().any(|(p, q)| {
                    cj.leaders
                        .iter()
                        .any(|lb| lb.segments().any(|(r, t)| seg_intersects(p, q, r, t)))
                })
            });
            if crosses {
                v.leader_crossings += 1;
            }
        }
    }
    v.priority_inversions = inversions(s);
    v
}

/// Count priority inversions (removal test for strict/weighted, prefix property for prefix).
pub fn inversions(s: &mut Solve) -> usize {
    let n = s.model.items.len();
    if s.model.omission == Omission::Prefix {
        // the labels after the first omitted item that ends the prefix (spec §9.2)
        let end = s.prefix_end(0);
        return s.pri.order[end..]
            .iter()
            .filter(|&&i| s.state.placed[i].is_some())
            .count();
    }
    let keys: Vec<usize> = s.pri.prio.iter().map(|p| p.key).collect();
    let mut count = 0;
    let mut buf = Vec::new();
    for h in 0..n {
        if inverted(s, h, &keys, &mut buf) {
            count += 1;
        }
    }
    count
}

/// Whether item `h` is omitted (by priority, or without a feasible candidate) although one
/// of its usable candidates conflicts only with labels of strictly lower key: the removal
/// test of strict and weighted omission (spec §9.2).
pub fn inverted(s: &mut Solve, h: usize, keys: &[usize], buf: &mut Vec<u32>) -> bool {
    if s.state.placed[h].is_some() {
        return false;
    }
    match s.reasons[h] {
        Some(Reason::OmittedByPriority) | Some(Reason::NoFeasibleCandidate) => {}
        _ => return false,
    }
    let soft_ok = s.model.ladder.contains(&Step::SoftOverlap);
    let key_h = keys[h];
    let ids = s.by_item[h].clone();
    for c in ids {
        // cheap rejection first: a conflict with a higher- or equal-key label
        let cand = &s.cands[c as usize];
        if cand.evaluated && !(cand.feasible || (soft_ok && cand.relaxed)) {
            continue;
        }
        if s.state
            .first_conflict(cand, &s.cands, s.obs, h, |j| keys[j] <= key_h)
            .is_some()
        {
            continue;
        }
        s.ensure_eval(c);
        let cand = &s.cands[c as usize];
        if !(cand.feasible || (soft_ok && cand.relaxed)) {
            continue;
        }
        s.state.conflicts(cand, &s.cands, s.obs, h, buf);
        // placeable once the (strictly) lower-key labels in its way are removed
        if !buf.is_empty() && buf.iter().all(|&j| keys[j as usize] > key_h) {
            return true;
        }
    }
    false
}
