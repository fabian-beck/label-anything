//! Post-search repairs: joint boundary slot assignment (spec §6.6), leader uncrossing and
//! the priority repair of strict omission (spec §10.3).

use super::greedy::{explain, pair_conflict};
use super::{Reason, Solve};
use crate::boundary::{column_candidate, column_port, slot_area};
use crate::candidates::{Cand, Kind};
use crate::cost::Evaluator;
use crate::geom::{seg_intersects, Rect};
use crate::math::maxf;
use crate::model::opts::{LeaderStyle, Models, Omission, Step};

/// Bounded isotonic stacking: positions `y_i` (sorted order) minimizing Σ (y_i − d_i)²
/// subject to `y_{i+1} − y_i ≥ g_i` and `lo ≤ y_0`, `y_{n−1} ≤ hi` (pool adjacent violators).
pub fn stack(desired: &[f64], gaps: &[f64], lo: f64, hi: f64) -> Vec<f64> {
    let n = desired.len();
    if n == 0 {
        return vec![];
    }
    let mut offs = vec![0.0; n];
    for i in 1..n {
        offs[i] = offs[i - 1] + gaps[i - 1];
    }
    let z: Vec<f64> = (0..n).map(|i| desired[i] - offs[i]).collect();
    // PAV on z with unit weights
    let mut blocks: Vec<(f64, usize)> = Vec::with_capacity(n); // (mean, count)
    for &v in &z {
        blocks.push((v, 1));
        while blocks.len() >= 2 {
            let (m2, c2) = blocks[blocks.len() - 1];
            let (m1, c1) = blocks[blocks.len() - 2];
            if m1 <= m2 {
                break;
            }
            blocks.pop();
            blocks.pop();
            let c = c1 + c2;
            blocks.push(((m1 * c1 as f64 + m2 * c2 as f64) / c as f64, c));
        }
    }
    let mut out = Vec::with_capacity(n);
    for (m, c) in blocks {
        for _ in 0..c {
            out.push(m);
        }
    }
    // constant bounds in z-space: z ≥ lo, z ≤ hi − offs[n−1]
    let zlo = lo;
    let zhi = hi - offs[n - 1];
    for (i, v) in out.iter_mut().enumerate() {
        let clamped = if zhi < zlo { zlo } else { v.clamp(zlo, zhi) };
        *v = clamped + offs[i];
    }
    out
}

/// Minimum-cost perfect assignment of rows to columns (square cost matrix), Hungarian
/// algorithm with potentials (O(n³)). Ties resolve deterministically by index.
pub fn hungarian(cost: &[Vec<f64>]) -> Vec<usize> {
    let n = cost.len();
    if n == 0 {
        return vec![];
    }
    let inf = f64::INFINITY;
    let mut u = vec![0.0; n + 1];
    let mut v = vec![0.0; n + 1];
    let mut p = vec![0usize; n + 1];
    let mut way = vec![0usize; n + 1];
    for i in 1..=n {
        p[0] = i;
        let mut j0 = 0usize;
        let mut minv = vec![inf; n + 1];
        let mut used = vec![false; n + 1];
        loop {
            used[j0] = true;
            let i0 = p[j0];
            let mut delta = inf;
            let mut j1 = 0usize;
            for j in 1..=n {
                if !used[j] {
                    let cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
                    if cur < minv[j] {
                        minv[j] = cur;
                        way[j] = j0;
                    }
                    if minv[j] < delta {
                        delta = minv[j];
                        j1 = j;
                    }
                }
            }
            for j in 0..=n {
                if used[j] {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else {
                    minv[j] -= delta;
                }
            }
            j0 = j1;
            if p[j0] == 0 {
                break;
            }
        }
        loop {
            let j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
            if j0 == 0 {
                break;
            }
        }
    }
    let mut assign = vec![0usize; n];
    for j in 1..=n {
        if p[j] > 0 {
            assign[p[j] - 1] = j - 1;
        }
    }
    assign
}

fn total_cost(s: &mut Solve, items: &[usize]) -> f64 {
    let mut t = 0.0;
    for &i in items {
        if let Some(c) = s.state.placed[i] {
            let it = &s.model.items[i];
            let cand = &s.cands[c as usize];
            t += cand.cost
                + s.state.dynamic_cost(
                    cand,
                    &s.cands,
                    s.obs,
                    it.len.buffer,
                    it.len.clearance,
                    s.model.leaders.width,
                    i,
                );
        }
    }
    t
}

/// The labels of a boundary column along `side` (spec §6.6): `members` ordered by their
/// anchors along the side, stacked (`stack`, or evenly spread), matched to the slots by
/// total leader length (straight and `angles` leaders; else in order) and aligned on the
/// column's line facing the picture; each keeps its placed variant (with `full` at full
/// size when the ladder shrank it; else its first), its rank and its level, and is
/// evaluated. In the members' order along the side.
fn column_cands(
    s: &Solve,
    area: &Rect,
    side: u8,
    members: &[usize],
    full: bool,
) -> Vec<(usize, Cand)> {
    let model = s.model;
    let items = &model.items;
    let horizontal_side = side <= 1;
    let key = |i: usize| {
        if horizontal_side {
            items[i].anchor.y
        } else {
            items[i].anchor.x
        }
    };
    let mut order: Vec<usize> = members.to_vec();
    crate::sort::sort_by(&mut order, |&a, &b| {
        crate::math::cmp_f64(key(a), key(b)).then(a.cmp(&b))
    });
    // a member without a label takes its first variant, at the level its boundary
    // candidates have: 0 with the boundary model, else that of the ladder's boundary step
    let step_level = model
        .ladder
        .iter()
        .position(|st| matches!(st, Step::Boundary))
        .map_or(0, |si| (si + 1) as u8);
    let placed: Vec<Option<&Cand>> = order
        .iter()
        .map(|&j| s.state.placed[j].map(|c| &s.cands[c as usize]))
        .collect();
    let vis: Vec<usize> = order
        .iter()
        .map(|&j| s.state.placed[j].map_or(0, |c| s.column_variant(j, c, full)))
        .collect();
    let (along, across): (Vec<f64>, Vec<f64>) = order
        .iter()
        .zip(&vis)
        .map(|(&j, &v)| {
            let v = &s.variants[j][v];
            if horizontal_side {
                (v.h, v.w)
            } else {
                (v.w, v.h)
            }
        })
        .unzip();
    let depth = across.iter().copied().fold(0.0, f64::max);
    let gap = items[order[0]].len.boundary_gap;
    let (lo, hi) = if horizontal_side {
        (area.y0, area.y1)
    } else {
        (area.x0, area.x1)
    };
    let positions: Vec<f64> = if model.placement.boundary.spread {
        let k = order.len() as f64;
        (0..order.len())
            .map(|j| lo + (hi - lo) * (j as f64 + 0.5) / k)
            .collect()
    } else {
        let desired: Vec<f64> = order.iter().map(|&i| key(i)).collect();
        // at least the larger label gap of the two labels apart
        let gaps: Vec<f64> = (1..order.len())
            .map(|j| {
                let m = maxf(
                    items[order[j - 1]].len.label_gap(),
                    items[order[j]].len.label_gap(),
                );
                (along[j - 1] + along[j]) * 0.5 + maxf(gap, m)
            })
            .collect();
        stack(
            &desired,
            &gaps,
            lo + along[0] * 0.5,
            hi - along[along.len() - 1] * 0.5,
        )
    };
    // assignment: straight leaders → min total length (to the ports, all on the column's
    // line); otherwise keep the order
    let assign: Vec<usize> = if matches!(
        model.leaders.style,
        LeaderStyle::Straight | LeaderStyle::Angles
    ) {
        let cost: Vec<Vec<f64>> = order
            .iter()
            .map(|&i| {
                let a = items[i].anchor;
                positions
                    .iter()
                    .map(|&p| a.dist(column_port(area, &items[i], side, p, depth)))
                    .collect()
            })
            .collect();
        hungarian(&cost)
    } else {
        (0..order.len()).collect()
    };
    let mut ev = Evaluator::new(model, s.obs, s.env);
    let mut fresh: Vec<(usize, Cand)> = Vec::with_capacity(order.len());
    for (k, &j) in order.iter().enumerate() {
        let v = &s.variants[j][vis[k]];
        let item = &items[j];
        let rank = placed[k].map_or(9.0, |c| c.rank);
        let mut c = column_candidate(
            model,
            area,
            item,
            vis[k],
            v,
            side,
            positions[assign[k]],
            depth,
            rank,
        );
        c.level = match placed[k] {
            Some(p) => p.level,
            None if item.models.has(Models::BOUNDARY) => v.level,
            None => step_level,
        };
        c.lshape = crate::candidates::label_shape(&c.rect, &v.shape);
        ev.eval(&mut c, v, None);
        fresh.push((j, c));
    }
    fresh
}

/// Re-stack the boundary labels of each side jointly; keep the result when every label
/// stays feasible and the total cost drops. Labels the ladder shrank take their full size,
/// or their placed size when only that column is kept.
pub fn boundary_pass(s: &mut Solve) {
    let Some(area) = slot_area(s.model, s.obs) else {
        return;
    };
    let n = s.model.items.len();
    for side in 0u8..4 {
        let members: Vec<usize> = (0..n)
            .filter(|&i| {
                s.state.placed[i]
                    .map(|c| {
                        s.cands[c as usize].kind == Kind::Boundary
                            && s.cands[c as usize].bside == side
                    })
                    .unwrap_or(false)
            })
            .collect();
        if members.len() < 2 {
            continue;
        }
        if !restack(s, &area, side, &members, true) && s.any_shrunk(&members) {
            restack(s, &area, side, &members, false);
        }
    }
}

/// Lay out the boundary column of `members` on `side` (`full`: shrunk labels at full size)
/// and keep it when every label stays feasible and free and the total cost drops.
fn restack(s: &mut Solve, area: &Rect, side: u8, members: &[usize], full: bool) -> bool {
    let fresh = column_cands(s, area, side, members, full);
    if fresh.iter().any(|(_, c)| !c.feasible) {
        return false;
    }
    let order: Vec<usize> = fresh.iter().map(|&(i, _)| i).collect();
    let old: Vec<(usize, u32)> = order
        .iter()
        .map(|&i| (i, s.state.placed[i].unwrap()))
        .collect();
    let before = total_cost(s, &order);
    for &i in &order {
        s.state.unplace(i, &s.cands);
    }
    let mut ok = true;
    let mut placed_now: Vec<usize> = Vec::new();
    for (i, c) in fresh {
        let id = s.cands.len() as u32;
        s.cands.push(c);
        s.by_item[i].push(id);
        let cand = &s.cands[id as usize];
        let mut scratch = Vec::new();
        if !s.state.is_free(cand, &s.cands, s.obs, i, &mut scratch) {
            ok = false;
            break;
        }
        s.state.place(i, id, &s.cands, false);
        placed_now.push(i);
    }
    if ok {
        let after = total_cost(s, &order);
        if after < before - 1e-9 {
            return true;
        }
    }
    for &i in &placed_now {
        s.state.unplace(i, &s.cands);
    }
    for (i, c) in old {
        let relaxed = !s.cands[c as usize].feasible;
        s.state.place(i, c, &s.cands, relaxed);
    }
    false
}

/// Label evaluations of the boundary fill: at least this many, or this many per item.
const FILL_WORK_MIN: usize = 20_000;
const FILL_WORK_PER_ITEM: usize = 20;

/// Boundary columns (spec §6.6): on each side in `placement.boundary.sides`, items without a
/// label that may take a boundary label join the side's column one after the other, in
/// priority order, when the column stacked again with them stays feasible and free. A placed
/// label in the way of a member whose item may take a boundary label, and that stands on
/// the column's side of its anchor, moves into the column too. Not with `prefix` omission,
/// after a cancellation or the time guard.
pub fn boundary_fill(s: &mut Solve) {
    if s.model.omission == Omission::Prefix || s.cancelled || s.time_guard_hit {
        return;
    }
    let Some(area) = slot_area(s.model, s.obs) else {
        return;
    };
    let model = s.model;
    let n = model.items.len();
    // items that may take a boundary label: the boundary model or the ladder's step
    let capable: Vec<bool> = (0..n)
        .map(|i| {
            let it = &model.items[i];
            s.models[i].has(Models::BOUNDARY)
                && !s.variants[i].is_empty()
                && it.keep_with.is_none()
                && !model.group_of.get(i).is_some_and(|g| g.is_some())
        })
        .collect();
    let mut work = FILL_WORK_MIN.max(FILL_WORK_PER_ITEM * n);
    for side_name in &model.placement.boundary.sides {
        let side = crate::boundary::side_code(side_name);
        // a placed label that may move into the column: not internal, on the column's
        // side of its anchor
        let movable = |s: &Solve, i: usize| {
            s.state.placed[i].is_some_and(|c| {
                let c = &s.cands[c as usize];
                let (a, m) = (model.items[i].anchor, c.rect.center());
                c.kind != Kind::Internal
                    && match side {
                        0 => m.x < a.x,
                        1 => m.x >= a.x,
                        2 => m.y < a.y,
                        _ => m.y >= a.y,
                    }
            })
        };
        let mut members: Vec<usize> = (0..n)
            .filter(|&i| {
                s.state.placed[i].is_some_and(|c| {
                    let c = &s.cands[c as usize];
                    c.kind == Kind::Boundary && c.bside == side
                })
            })
            .collect();
        for u in s.pri.order.clone() {
            if s.state.placed[u].is_some()
                || !capable[u]
                || !matches!(
                    s.reasons[u],
                    None | Some(Reason::OmittedByPriority) | Some(Reason::NoFeasibleCandidate)
                )
            {
                continue;
            }
            if model.max_labels.is_some_and(|m| s.state.n_placed >= m) {
                return;
            }
            let mut trial = members.clone();
            trial.push(u);
            loop {
                if work == 0 || s.poll_cancel() {
                    return;
                }
                work = work.saturating_sub(trial.len());
                // the members' labels at full size first, at their placed sizes when that
                // fails
                let mut laid = side_layout(s, &area, side, &trial, true);
                if laid.is_err() && s.any_shrunk(&trial) {
                    work = work.saturating_sub(trial.len());
                    laid = side_layout(s, &area, side, &trial, false);
                }
                match laid {
                    Ok(cands) => {
                        if !within_ink(s, &cands) {
                            break;
                        }
                        let added: Vec<usize> = vec![u];
                        let cost = cands.iter().map(|(_, c)| c.cost).sum();
                        let plan = super::fan::Plan { cands, added, cost };
                        if super::fan::apply_unless_inverting(s, plan) {
                            members = trial;
                        }
                        break;
                    }
                    Err(fails) => {
                        // a placed label in the way joins the column
                        let joins = fails
                            .iter()
                            .filter_map(|&(_, b)| b)
                            .find(|&k| capable[k] && !trial.contains(&k) && movable(s, k));
                        match joins {
                            Some(k) => trial.push(k),
                            None => break,
                        }
                    }
                }
            }
        }
    }
}

/// Whether the labels `cands` (replacing the members' own) keep the label area within
/// `priority.budget.max_ink_fraction`.
fn within_ink(s: &Solve, cands: &[(usize, Cand)]) -> bool {
    let (Some(f), Some(canvas)) = (s.model.max_ink_fraction, s.model.canvas) else {
        return true;
    };
    let mut ink = s.state.label_area_sum;
    for (j, c) in cands {
        if let Some(p) = s.state.placed[*j] {
            ink -= s.cands[p as usize].rect.area();
        }
        ink += c.rect.area();
    }
    ink / canvas.area().max(1e-9) <= f
}

/// Lay out a boundary column of `members` (`column_cands`, `full` as there) and test it
/// against everything else placed, the members' own labels lifted meanwhile. `Err`: the
/// members that fail, each with the placed item in its way (none: a reason of its own).
#[allow(clippy::type_complexity)]
fn side_layout(
    s: &mut Solve,
    area: &Rect,
    side: u8,
    members: &[usize],
    full: bool,
) -> Result<Vec<(usize, Cand)>, Vec<(usize, Option<usize>)>> {
    let fresh = column_cands(s, area, side, members, full);
    let saved: Vec<(usize, u32)> = fresh
        .iter()
        .filter_map(|&(j, _)| s.state.placed[j].map(|c| (j, c)))
        .collect();
    for &(j, _) in &saved {
        s.state.unplace(j, &s.cands);
    }
    let base = s.cands.len();
    let mut failed: Vec<(usize, Option<usize>)> = Vec::new();
    let mut placed_now: Vec<usize> = Vec::new();
    for (j, c) in &fresh {
        if !c.feasible {
            failed.push((*j, None));
            continue;
        }
        match s.state.first_conflict(c, &s.cands, s.obs, *j, |_| true) {
            Some(k) => failed.push((*j, Some(k))),
            None => {
                let id = s.cands.len() as u32;
                s.cands.push(c.clone());
                s.state.place(*j, id, &s.cands, false);
                placed_now.push(*j);
            }
        }
    }
    for &j in &placed_now {
        s.state.unplace(j, &s.cands);
    }
    s.cands.truncate(base);
    for &(j, c) in &saved {
        let relaxed = !s.cands[c as usize].feasible;
        s.state.place(j, c, &s.cands, relaxed);
    }
    if failed.is_empty() {
        Ok(fresh)
    } else {
        Err(failed)
    }
}

/// Uncross leaders (only possible when crossings are soft): swap the label positions of a
/// crossing pair when that shortens the total leader length and keeps everything feasible.
pub fn uncross(s: &mut Solve) {
    if s.obs.dynamic.leader_leaders.is_hard() {
        return;
    }
    let n = s.model.items.len();
    for _round in 0..50 {
        let mut improved = false;
        'pairs: for i in 0..n {
            let Some(ci) = s.state.placed[i] else {
                continue;
            };
            // (stubs stay with their marks)
            if s.cands[ci as usize].leaders.is_empty() || s.cands[ci as usize].has_stub() {
                continue;
            }
            for j in (i + 1)..n {
                let Some(cj) = s.state.placed[j] else {
                    continue;
                };
                let (a, b) = (&s.cands[ci as usize], &s.cands[cj as usize]);
                if b.leaders.is_empty() || b.has_stub() || !a.bbox().touches(&b.bbox()) {
                    continue;
                }
                let cross = a.leaders.iter().any(|la| {
                    la.segments().any(|(p, q)| {
                        b.leaders
                            .iter()
                            .any(|lb| lb.segments().any(|(r, t)| seg_intersects(p, q, r, t)))
                    })
                });
                if !cross {
                    continue;
                }
                // try: i at j's box center, j at i's box center (same variants)
                let len_before = a.leaders[0].len + b.leaders[0].len;
                let ni = moved_to(s, i, ci, b.rect.center());
                let nj = moved_to(s, j, cj, a.rect.center());
                let (Some(ni), Some(nj)) = (ni, nj) else {
                    continue;
                };
                if ni.leaders.is_empty()
                    || nj.leaders.is_empty()
                    || ni.leaders[0].len + nj.leaders[0].len >= len_before - 1e-9
                    || !ni.feasible
                    || !nj.feasible
                {
                    continue;
                }
                s.state.unplace(i, &s.cands);
                s.state.unplace(j, &s.cands);
                let id_i = s.cands.len() as u32;
                s.cands.push(ni);
                s.by_item[i].push(id_i);
                let id_j = s.cands.len() as u32;
                s.cands.push(nj);
                s.by_item[j].push(id_j);
                let mut scratch = Vec::new();
                let ci2 = &s.cands[id_i as usize];
                let ok_i = s.state.is_free(ci2, &s.cands, s.obs, i, &mut scratch);
                if ok_i {
                    s.state.place(i, id_i, &s.cands, false);
                    let cj2 = &s.cands[id_j as usize];
                    if s.state.is_free(cj2, &s.cands, s.obs, j, &mut scratch) {
                        s.state.place(j, id_j, &s.cands, false);
                        improved = true;
                        break 'pairs;
                    }
                    s.state.unplace(i, &s.cands);
                }
                s.state
                    .place(i, ci, &s.cands, !s.cands[ci as usize].feasible);
                s.state
                    .place(j, cj, &s.cands, !s.cands[cj as usize].feasible);
            }
        }
        if !improved {
            break;
        }
    }
}

/// Candidate of item `i` with the variant of `from`, label centered at `center`, and a
/// straight leader to the nearest point of the label.
fn moved_to(s: &Solve, i: usize, from: u32, center: crate::geom::P) -> Option<Cand> {
    let f = &s.cands[from as usize];
    let v = &s.variants[i][f.variant as usize];
    let rect = crate::geom::Rect::from_center(center, v.w * 0.5, v.h * 0.5);
    let item = &s.model.items[i];
    let mut c = Cand::new(i as u32, f.variant, f.level, f.kind, f.side, f.rank, rect);
    c.lshape = crate::candidates::label_shape(&rect, &v.shape);
    let start = crate::leaders::leader_start(s.model, item, rect.center());
    let port = rect.closest_point(start);
    let start = crate::leaders::leader_start(s.model, item, port);
    c.leaders.push(crate::candidates::Leader::new(
        vec![start, rect.closest_point(start)],
        f.leaders
            .first()
            .map(|l| l.style)
            .unwrap_or(LeaderStyle::Straight),
    ));
    let mut ev = Evaluator::new(s.model, s.obs, s.env);
    ev.eval(&mut c, v, None);
    Some(c)
}

/// Strict omission (spec §9.2, §10.3): an omitted item that has a usable candidate in
/// conflict with no placed label or only with labels of strictly lower priority takes it,
/// in priority order, and those labels are tried again in their turn. The search keeps
/// the priority objective, but a move can free a position that a lower label then takes;
/// after this pass the removal test of the verification finds no inversion.
pub fn priority_repair(s: &mut Solve) {
    if s.model.omission != Omission::Strict || s.cancelled {
        return;
    }
    // a label moved aside may leave room for an item visited before: the pass without
    // moves, once more, leaves no inversion
    let mut freed = Vec::new();
    priority_pass(s, true, &mut freed);
    if !freed.is_empty() {
        priority_pass(s, false, &mut freed);
    }
}

/// One pass of the priority repair over the omitted items in total order. With
/// `relocate`, an item may move one label aside (ADR 0049), whose old place joins `freed`;
/// without, an item near a place in `freed` also tries its pruned level-0 candidates.
fn priority_pass(s: &mut Solve, relocate: bool, freed: &mut Vec<crate::geom::Rect>) {
    let soft_ok = s.model.ladder.contains(&Step::SoftOverlap);
    let keys: Vec<usize> = s.pri.prio.iter().map(|p| p.key).collect();
    let order = s.pri.order.clone();
    let mut confl = Vec::new();
    for h in order {
        if s.state.placed[h].is_some() || s.model.items[h].keep_with.is_some() {
            continue;
        }
        // `None`: removed by this pass
        if !matches!(
            s.reasons[h],
            None | Some(Reason::OmittedByPriority) | Some(Reason::NoFeasibleCandidate)
        ) {
            continue;
        }
        let key_h = keys[h];
        // ((removed labels, their gain, cost), candidate, removed, relaxed)
        type Choice = ((usize, f64, f64), u32, Vec<u32>, bool);
        let mut best: Option<Choice> = None;
        for c in s.by_item[h].clone() {
            let cand = &s.cands[c as usize];
            if cand.evaluated && !(cand.feasible || soft_ok && cand.relaxed) {
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
            if !(cand.feasible || soft_ok && cand.relaxed) {
                continue;
            }
            s.state.conflicts(cand, &s.cands, s.obs, h, &mut confl);
            if !confl
                .iter()
                .all(|&j| keys[j as usize] > key_h && !s.model.items[j as usize].required)
            {
                continue;
            }
            if let Some(m) = s.model.max_labels {
                if s.state.n_placed + 1 > m + confl.len() {
                    continue;
                }
            }
            if let (Some(f), Some(canvas)) = (s.model.max_ink_fraction, s.model.canvas) {
                let mut area = s.state.label_area_sum;
                for &j in &confl {
                    area -= s.cands[s.state.placed[j as usize].unwrap() as usize]
                        .rect
                        .area();
                }
                if (area + cand.rect.area()) / canvas.area().max(1e-9) > f {
                    continue;
                }
            }
            let relaxed = !cand.feasible;
            let cost = cand.cost + if relaxed { cand.relax_cost } else { 0.0 };
            let gain: f64 = confl.iter().map(|&j| s.pri.prio[j as usize].gain).sum();
            let score = (confl.len(), gain, cost);
            let better = match &best {
                None => true,
                Some((b, bc, _, _)) => {
                    score.0 < b.0
                        || (score.0 == b.0
                            && (score.1 < b.1
                                || (score.1 == b.1
                                    && (score.2 < b.2 || (score.2 == b.2 && c < *bc)))))
                }
            };
            if better {
                best = Some((score, c, confl.clone(), relaxed));
            }
        }
        match best {
            Some((_, c, removed, relaxed)) => {
                for j in removed {
                    s.state.unplace(j as usize, &s.cands);
                    s.reasons[j as usize] = None;
                }
                s.state.place(h, c, &s.cands, relaxed);
                s.reasons[h] = None;
            }
            None if !relocate && near_freed(s, h, freed) => {
                match pruned_choice(s, h, &keys, soft_ok) {
                    Some((c, removed)) => {
                        let id = s.cands.len() as u32;
                        s.cands.push(c);
                        s.by_item[h].push(id);
                        for j in removed {
                            s.state.unplace(j as usize, &s.cands);
                            s.reasons[j as usize] = None;
                        }
                        let relaxed = !s.cands[id as usize].feasible;
                        s.state.place(h, id, &s.cands, relaxed);
                        s.reasons[h] = None;
                    }
                    None if s.reasons[h].is_none() => s.reasons[h] = Some(explain(s, h)),
                    None => {}
                }
            }
            None => match relocate.then(|| relocation(s, h, &keys, soft_ok)).flatten() {
                Some(m) => {
                    if let Some(j) = m.removed {
                        s.state.unplace(j, &s.cands);
                        s.reasons[j] = None;
                    }
                    let old = s.state.placed[m.b].expect("moved labels are placed");
                    freed.push(s.cands[old as usize].bbox());
                    s.state.unplace(m.b, &s.cands);
                    let to = match m.fresh {
                        Some(c) => {
                            let id = s.cands.len() as u32;
                            s.cands.push(c);
                            s.by_item[m.b].push(id);
                            id
                        }
                        None => m.to,
                    };
                    let relaxed = !s.cands[to as usize].feasible;
                    s.state.place(m.b, to, &s.cands, relaxed);
                    let relaxed = !s.cands[m.c as usize].feasible;
                    s.state.place(h, m.c, &s.cands, relaxed);
                    s.reasons[h] = None;
                }
                None if s.reasons[h].is_none() => s.reasons[h] = Some(explain(s, h)),
                None => {}
            },
        }
    }
}

/// Whether the level-0 labels of item `h` (its largest box beside its mark or area, at
/// `placement.offset`) may reach a place in `freed` (within the largest margin).
fn near_freed(s: &Solve, h: usize, freed: &[crate::geom::Rect]) -> bool {
    if freed.is_empty() {
        return false;
    }
    let item = &s.model.items[h];
    let mut r = item.shape.bbox();
    if let Some(a) = &item.area {
        r = r.union(&a.shape.bbox());
    }
    let size = s.variants[h]
        .iter()
        .filter(|v| v.level == 0)
        .map(|v| maxf(v.w, v.h))
        .fold(0.0, maxf);
    let r = r.inflate(item.len.offset + size + s.state.margin_max());
    freed.iter().any(|f| f.touches(&r))
}

/// The first rule of the priority repair over the level-0 candidates of `h` that the
/// pruning dropped (fan and boundary ones excepted): the candidate and the labels removed.
fn pruned_choice(
    s: &mut Solve,
    h: usize,
    keys: &[usize],
    soft_ok: bool,
) -> Option<(Cand, Vec<u32>)> {
    let key_h = keys[h];
    let fresh = s.unpruned_level0(h, soft_ok);
    let mut confl = Vec::new();
    // ((removed labels, their gain, cost), candidate, removed)
    type Choice = ((usize, f64, f64), usize, Vec<u32>);
    let mut best: Option<Choice> = None;
    for (k, cand) in fresh.iter().enumerate() {
        if matches!(cand.kind, Kind::Fan | Kind::Boundary)
            || s.state
                .first_conflict(cand, &s.cands, s.obs, h, |j| keys[j] <= key_h)
                .is_some()
        {
            continue;
        }
        s.state.conflicts(cand, &s.cands, s.obs, h, &mut confl);
        if !confl
            .iter()
            .all(|&j| keys[j as usize] > key_h && !s.model.items[j as usize].required)
        {
            continue;
        }
        if let Some(m) = s.model.max_labels {
            if s.state.n_placed + 1 > m + confl.len() {
                continue;
            }
        }
        if let (Some(f), Some(canvas)) = (s.model.max_ink_fraction, s.model.canvas) {
            let mut area = s.state.label_area_sum;
            for &j in &confl {
                area -= s.cands[s.state.placed[j as usize].unwrap() as usize]
                    .rect
                    .area();
            }
            if (area + cand.rect.area()) / canvas.area().max(1e-9) > f {
                continue;
            }
        }
        let gain: f64 = confl.iter().map(|&j| s.pri.prio[j as usize].gain).sum();
        let score = (confl.len(), gain, relaxed_cost(cand));
        let better = match &best {
            None => true,
            Some((b, _, _)) => {
                score.0 < b.0
                    || (score.0 == b.0 && (score.1 < b.1 || (score.1 == b.1 && score.2 < b.2)))
            }
        };
        if better {
            best = Some((score, k, confl.clone()));
        }
    }
    let (_, k, removed) = best?;
    Some((
        fresh
            .into_iter()
            .nth(k)
            .expect("index of a fresh candidate"),
        removed,
    ))
}

/// The candidates of an omitted item that the relocation tries, and the places it tries
/// for the label moved aside (spec §10.3).
const RELOCATE_TRIES: usize = 8;
const RELOCATE_MOVES: usize = 16;
/// Ids of the moved label's regenerated level-0 candidates: after all others.
const FRESH: u32 = u32::MAX / 2;

/// Item `h` takes candidate `c` once label `b` moved to `to` (or to the regenerated
/// candidate `fresh`) and the label `removed` is removed.
struct Relocation {
    c: u32,
    b: usize,
    to: u32,
    fresh: Option<Cand>,
    removed: Option<usize>,
}

/// The usable candidates of item `i` but `except` (statically feasible, or relaxed when
/// `soft_ok`; no fan or boundary labels), cheapest first (relaxed ones at their relaxed
/// cost), ties by id.
fn usable_by_cost(s: &mut Solve, i: usize, soft_ok: bool, except: Option<u32>) -> Vec<(f64, u32)> {
    let mut out = Vec::new();
    for k in 0..s.by_item[i].len() {
        let c = s.by_item[i][k];
        let cand = &s.cands[c as usize];
        if Some(c) == except
            || matches!(cand.kind, Kind::Fan | Kind::Boundary)
            || cand.evaluated && !(cand.feasible || soft_ok && cand.relaxed)
        {
            continue;
        }
        s.ensure_eval(c);
        let cand = &s.cands[c as usize];
        if cand.feasible || soft_ok && cand.relaxed {
            out.push((relaxed_cost(cand), c));
        }
    }
    crate::sort::sort_by(&mut out, |a, b| {
        crate::math::cmp_f64(a.0, b.0).then(a.1.cmp(&b.1))
    });
    out
}

fn relaxed_cost(c: &Cand) -> f64 {
    c.cost + if c.feasible { 0.0 } else { c.relax_cost }
}

/// Move one label aside (spec §10.3, ADR 0049): omitted item `h` takes one of its usable
/// candidates whose conflicts are one label `b` of a key not lower than its own (or a
/// required one) and at most one removable label (strictly lower key, not required); `b`
/// moves to one of its usable candidates, or of its level-0 candidates the pruning
/// dropped, that conflicts with neither `h`'s nor a placed label but removable ones. At
/// most one label is removed in all. Fewest removed, then the smallest gain removed, then
/// the smallest cost change (`h`'s candidate plus `b`'s move); the first found on ties.
fn relocation(s: &mut Solve, h: usize, keys: &[usize], soft_ok: bool) -> Option<Relocation> {
    let key_h = keys[h];
    let removable = |s: &Solve, j: usize| keys[j] > key_h && !s.model.items[j].required;
    let ours = usable_by_cost(s, h, soft_ok, None);
    let dy = s.obs.dynamic;
    let mut confl = Vec::new();
    let mut confl_b = Vec::new();
    let mut fresh: Vec<(usize, Vec<Cand>)> = Vec::new();
    let mut tried = 0;
    // ((removed, their gain, cost change), relocation)
    let mut best: Option<((usize, f64, f64), Relocation)> = None;
    for &(cost_c, c) in &ours {
        if tried == RELOCATE_TRIES {
            break;
        }
        s.state
            .conflicts(&s.cands[c as usize], &s.cands, s.obs, h, &mut confl);
        let mut fixed = confl
            .iter()
            .map(|&j| j as usize)
            .filter(|&j| !removable(s, j));
        let (Some(b), None) = (fixed.next(), fixed.next()) else {
            continue;
        };
        let lower: Vec<usize> = confl
            .iter()
            .map(|&j| j as usize)
            .filter(|&j| j != b)
            .collect();
        let old = s.state.placed[b].expect("conflicts are placed");
        if lower.len() > 1 || matches!(s.cands[old as usize].kind, Kind::Fan | Kind::Boundary) {
            continue;
        }
        tried += 1;
        let cost_old = relaxed_cost(&s.cands[old as usize]);
        // its usable candidates, then the pruned level-0 ones (generated once per item)
        let mut places = usable_by_cost(s, b, soft_ok, Some(old));
        let f = match fresh.iter().position(|e| e.0 == b) {
            Some(f) => f,
            None => {
                let regenerated = s.unpruned_level0(b, soft_ok);
                fresh.push((b, regenerated));
                fresh.len() - 1
            }
        };
        for (k, fc) in fresh[f].1.iter().enumerate() {
            places.push((relaxed_cost(fc), FRESH + k as u32));
        }
        crate::sort::sort_by(&mut places, |a, b| {
            crate::math::cmp_f64(a.0, b.0).then(a.1.cmp(&b.1))
        });
        let sp = s.state.spacing(b, h);
        for &(cost_b, to) in places.iter().take(RELOCATE_MOVES) {
            let place = if to >= FRESH {
                &fresh[f].1[(to - FRESH) as usize]
            } else {
                &s.cands[to as usize]
            };
            let ch = &s.cands[c as usize];
            if pair_conflict(place, ch, &dy, sp) || s.state.pair_lower(place, ch) {
                continue;
            }
            s.state.conflicts(place, &s.cands, s.obs, b, &mut confl_b);
            if !confl_b.iter().all(|&j| removable(s, j as usize)) {
                continue;
            }
            let mut removed = lower.clone();
            removed.extend(confl_b.iter().map(|&j| j as usize));
            removed.sort_unstable();
            removed.dedup();
            if removed.len() > 1 {
                continue;
            }
            if let Some(m) = s.model.max_labels {
                if s.state.n_placed + 1 > m + removed.len() {
                    continue;
                }
            }
            if let (Some(f), Some(canvas)) = (s.model.max_ink_fraction, s.model.canvas) {
                let mut area = s.state.label_area_sum - s.cands[old as usize].rect.area()
                    + place.rect.area()
                    + ch.rect.area();
                for &j in &removed {
                    area -= s.cands[s.state.placed[j].unwrap() as usize].rect.area();
                }
                if area / canvas.area().max(1e-9) > f {
                    continue;
                }
            }
            let gain: f64 = removed.iter().map(|&j| s.pri.prio[j].gain).sum();
            let score = (removed.len(), gain, cost_c + cost_b - cost_old);
            let better = match &best {
                None => true,
                Some((b, _)) => {
                    score.0 < b.0
                        || (score.0 == b.0 && (score.1 < b.1 || (score.1 == b.1 && score.2 < b.2)))
                }
            };
            if better {
                let fresh = (to >= FRESH).then(|| place.clone());
                let removed = removed.first().copied();
                best = Some((
                    score,
                    Relocation {
                        c,
                        b,
                        to,
                        fresh,
                        removed,
                    },
                ));
            }
        }
    }
    best.map(|b| b.1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stacking_respects_gaps_and_bounds() {
        let y = stack(&[10.0, 11.0, 12.0], &[5.0, 5.0], 0.0, 100.0);
        assert!((y[1] - y[0] - 5.0).abs() < 1e-9 && (y[2] - y[1] - 5.0).abs() < 1e-9);
        assert!((y[1] - 11.0).abs() < 1e-9); // centered on the desired mean
        let y = stack(&[0.0, 1.0], &[10.0], 5.0, 100.0);
        assert!(y[0] >= 5.0 - 1e-9);
        let y = stack(&[10.0, 50.0], &[5.0], 0.0, 100.0);
        assert_eq!(y, vec![10.0, 50.0]);
    }

    #[test]
    fn hungarian_min_cost() {
        let c = vec![
            vec![4.0, 1.0, 3.0],
            vec![2.0, 0.0, 5.0],
            vec![3.0, 2.0, 2.0],
        ];
        let a = hungarian(&c);
        let total: f64 = a.iter().enumerate().map(|(i, &j)| c[i][j]).sum();
        assert_eq!(total, 5.0);
    }
}
