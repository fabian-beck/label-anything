//! Independent verification of the final placement (spec §10.3).

use super::{Reason, Solve};
use crate::geom::seg_intersects;
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
            s.state.conflicts(&cand, &s.cands, s.obs, i, &mut buf);
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
    // leader crossings (any policy)
    let placed: Vec<usize> = (0..n).filter(|&i| s.state.placed[i].is_some()).collect();
    for (a, &i) in placed.iter().enumerate() {
        let ci = &s.cands[s.state.placed[i].unwrap() as usize];
        if ci.leaders.is_empty() {
            continue;
        }
        for &j in &placed[a + 1..] {
            let cj = &s.cands[s.state.placed[j].unwrap() as usize];
            if cj.leaders.is_empty() || !ci.bbox().touches(&cj.bbox()) {
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
        let first_omitted = s
            .pri
            .order
            .iter()
            .position(|&i| s.state.placed[i].is_none());
        return match first_omitted {
            Some(r) => s.pri.order[r..]
                .iter()
                .filter(|&&i| s.state.placed[i].is_some())
                .count(),
            None => 0,
        };
    }
    let soft_ok = s.model.ladder.contains(&Step::SoftOverlap);
    let keys: Vec<usize> = s.pri.prio.iter().map(|p| p.key).collect();
    let mut count = 0;
    let mut buf = Vec::new();
    for h in 0..n {
        if s.state.placed[h].is_some() {
            continue;
        }
        match s.reasons[h] {
            Some(Reason::OmittedByPriority) | Some(Reason::NoFeasibleCandidate) => {}
            _ => continue,
        }
        let key_h = s.pri.prio[h].key;
        let ids = s.by_item[h].clone();
        let mut inverted = false;
        for c in ids {
            // cheap rejection first: a conflict with a higher- or equal-key label
            let cand = &s.cands[c as usize];
            if cand.evaluated && !(cand.feasible || (soft_ok && cand.relaxed)) {
                continue;
            }
            if s.state
                .first_conflict(&cand, &s.cands, s.obs, h, |j| keys[j] <= key_h)
                .is_some()
            {
                continue;
            }
            s.ensure_eval(c);
            let cand = &s.cands[c as usize];
            if !(cand.feasible || (soft_ok && cand.relaxed)) {
                continue;
            }
            s.state.conflicts(&cand, &s.cands, s.obs, h, &mut buf);
            // placeable once the (strictly) lower-key labels in its way are removed
            if !buf.is_empty() && buf.iter().all(|&j| s.pri.prio[j as usize].key > key_h) {
                inverted = true;
                break;
            }
        }
        if inverted {
            count += 1;
        }
    }
    count
}
