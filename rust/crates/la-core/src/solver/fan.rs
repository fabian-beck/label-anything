//! Fan labels (spec §6.8): the labels of a crowd of items stacked in a column beside the
//! crowd, with fanning leaders.
//!
//! After the search, items (in priority order: with `placement.fan` = `auto` those left
//! without a label, with `always` every item) seed crowds: the items whose anchors lie
//! within one label height vertically and one em horizontally (between the marks) of a
//! crowd member, gathered breadth first, nearest first. For each side the seed's positions
//! allow (right, left), a column takes the crowd's members without a label (`always`: and
//! those labeled on that side): ordered by anchor height, stacked around it like boundary
//! labels, matched to the slots by total leader length when that is shorter than keeping
//! the order, at a distance from the crowd that keeps the leaders at most 45° steep (as far
//! as the canvas allows). A placed label in its way whose item stands in the crowd's strip
//! joins the column; a placed member that cannot move into it keeps its label; a member
//! without a label that fails leaves it (lowest priority first). The column is applied when
//! it places more labels (`always`: at least as many, in a column of two or more).
//!
//! Fan leaders are built like boundary leaders (straight, or per the `orthogonal`, `elbow`
//! style) and keep to `leaders.max_length`; the `angles` style, whose leaders run along the
//! allowed rays, has no fans.
//! Items that may not get leaders (neither their models nor the ladder have `distant` or
//! `boundary`), items kept with another, area anchors and grouped items stay out.

use super::repair::{hungarian, stack};
use super::{Reason, Solve};
use crate::boundary::{boundary_leader, slot_area};
use crate::candidates::{label_shape, Cand, Kind, Side};
use crate::cost::Evaluator;
use crate::geom::{Rect, P};
use crate::model::opts::{FanMode, LeaderStyle, Models, Omission, Pos, Step};

/// Largest crowd a seed gathers, and most labels a column takes in.
pub const MAX_CROWD: usize = 24;
pub const MAX_COLUMN: usize = 40;
/// Horizontal run of a leader per pixel of vertical rise (at most 45° steep), and the
/// least run in em.
pub const RUN_PER_RISE: f64 = 1.0;
pub const MIN_RUN_EM: f64 = 1.5;
/// Label evaluations of the pass: at least this many, or this many per item.
const WORK_MIN: usize = 20_000;
const WORK_PER_ITEM: usize = 20;

/// A column: its candidates and the members it gives a label.
struct Plan {
    cands: Vec<(usize, Cand)>,
    added: Vec<usize>,
    cost: f64,
}

/// The pass's mode, the items it leaves alone, and the label evaluations it has left.
struct Pass {
    always: bool,
    excluded: Vec<bool>,
    work: usize,
}

pub fn fan_pass(s: &mut Solve) {
    let mode = s.model.placement.fan;
    if mode == FanMode::Off
        || s.model.leaders.style == LeaderStyle::Angles
        || s.model.omission == Omission::Prefix
        || s.cancelled
        || s.time_guard_hit
    {
        return;
    }
    let Some(area) = slot_area(s.model, s.obs) else {
        return;
    };
    let model = s.model;
    let n = model.items.len();
    // fan labels have leaders: only items that may get leaders join a fan
    let ladder_leaders = model
        .ladder
        .iter()
        .any(|st| matches!(st, Step::Distant | Step::Boundary));
    let mut pass = Pass {
        always: mode == FanMode::Always,
        excluded: (0..n)
            .map(|i| {
                let it = &model.items[i];
                let leaders = ladder_leaders
                    || s.models[i].has(Models::DISTANT)
                    || s.models[i].has(Models::BOUNDARY);
                !leaders
                    || s.variants[i].is_empty()
                    || it.keep_with.is_some()
                    || it.area.is_some()
                    || model.group_of.get(i).is_some_and(|g| g.is_some())
            })
            .collect(),
        work: WORK_MIN.max(WORK_PER_ITEM * n),
    };
    // anchors by height, for the crowd queries
    let mut by_y: Vec<usize> = (0..n).collect();
    by_y.sort_by(|&a, &b| {
        crate::math::cmp_f64(model.items[a].anchor.y, model.items[b].anchor.y).then(a.cmp(&b))
    });
    let ys: Vec<f64> = by_y.iter().map(|&i| model.items[i].anchor.y).collect();
    let height: Vec<f64> = (0..n)
        .map(|i| s.variants[i].first().map_or(0.0, |v| v.h))
        .collect();
    let max_h = height.iter().copied().fold(0.0, f64::max);
    let mut seeded = vec![false; n];
    for seed in s.pri.order.clone() {
        if seeded[seed] || pass.excluded[seed] {
            continue;
        }
        if !pass.always
            && (s.state.placed[seed].is_some()
                || !matches!(
                    s.reasons[seed],
                    None | Some(Reason::OmittedByPriority) | Some(Reason::NoFeasibleCandidate)
                ))
        {
            continue;
        }
        if pass.work == 0 || s.poll_cancel() {
            return;
        }
        let crowd = crowd_of(s, seed, &by_y, &ys, &height, max_h, &pass.excluded);
        for &j in &crowd {
            seeded[j] = true;
        }
        if crowd.len() < 2 {
            continue;
        }
        let positions = &model.items[seed].positions;
        let allows = |ps: &[Pos]| ps.iter().any(|p| positions.contains(p));
        let mut sides: Vec<bool> = Vec::new();
        if allows(&[Pos::Right, Pos::TopRight, Pos::BottomRight]) {
            sides.push(true);
        }
        if allows(&[Pos::Left, Pos::TopLeft, Pos::BottomLeft]) {
            sides.push(false);
        }
        // the better side first, then the other one for the members it leaves
        while !sides.is_empty() {
            let mut best: Option<(bool, Plan)> = None;
            for &right in &sides {
                if let Some(p) = column(s, &mut pass, &area, &crowd, right) {
                    if best.as_ref().is_none_or(|(_, b)| better_plan(s, &p, b)) {
                        best = Some((right, p));
                    }
                }
            }
            let Some((right, plan)) = best else { break };
            apply(s, plan);
            sides.retain(|&x| x != right);
        }
    }
}

/// `a` gives labels to more important members than `b`, or to as important ones at a
/// lower cost.
fn better_plan(s: &Solve, a: &Plan, b: &Plan) -> bool {
    let keys = |p: &Plan| {
        let mut k: Vec<usize> = p.added.iter().map(|&i| s.pri.prio[i].key).collect();
        k.sort_unstable();
        k
    };
    let (ka, kb) = (keys(a), keys(b));
    for (x, y) in ka.iter().zip(&kb) {
        if x != y {
            return x < y;
        }
    }
    if ka.len() != kb.len() {
        return ka.len() > kb.len();
    }
    a.cost < b.cost
}

/// The crowd of `seed`: items within one label height vertically (half of each item's
/// height) and one em horizontally (between the marks' boxes) of a member, gathered
/// breadth first, nearest first, at most MAX_CROWD.
fn crowd_of(
    s: &Solve,
    seed: usize,
    by_y: &[usize],
    ys: &[f64],
    height: &[f64],
    max_h: f64,
    excluded: &[bool],
) -> Vec<usize> {
    let items = &s.model.items;
    let mut crowd = vec![seed];
    let mut k = 0;
    while k < crowd.len() && crowd.len() < MAX_CROWD {
        let a = crowd[k];
        k += 1;
        let pa = items[a].anchor;
        let ba = items[a].shape.bbox();
        let reach = (height[a] + max_h) * 0.5;
        let lo = ys.partition_point(|&y| y < pa.y - reach);
        let mut near: Vec<(f64, usize)> = Vec::new();
        for &j in &by_y[lo..] {
            let pj = items[j].anchor;
            if pj.y > pa.y + reach {
                break;
            }
            if excluded[j] || crowd.contains(&j) {
                continue;
            }
            let bj = items[j].shape.bbox();
            let dx = (bj.x0.max(ba.x0) - bj.x1.min(ba.x1)).max(0.0);
            if (pj.y - pa.y).abs() <= (height[a] + height[j]) * 0.5
                && dx <= items[a].em().max(items[j].em())
            {
                near.push((pa.dist(pj), j));
            }
        }
        near.sort_by(|x, y| crate::math::cmp_f64(x.0, y.0).then(x.1.cmp(&y.1)));
        for (_, j) in near {
            if crowd.len() == MAX_CROWD {
                break;
            }
            crowd.push(j);
        }
    }
    crowd
}

/// The column of `crowd` on one side, if it is worth applying.
fn column(
    s: &mut Solve,
    pass: &mut Pass,
    area: &Rect,
    crowd: &[usize],
    right: bool,
) -> Option<Plan> {
    let model = s.model;
    let items = &model.items;
    let on_side = |s: &Solve, j: usize| match s.state.placed[j] {
        None => true,
        Some(c) => {
            let c = &s.cands[c as usize];
            c.kind != Kind::Internal && (c.rect.center().x >= items[j].anchor.x) == right
        }
    };
    // a member without a label that cannot take even the slot level with its anchor, for
    // a reason of its own (no placed label in its way), cannot take any: it stays out
    let mut members: Vec<usize> = Vec::new();
    for &j in crowd {
        if s.state.placed[j].is_some() {
            if pass.always && on_side(s, j) {
                members.push(j);
            }
            continue;
        }
        pass.work = pass.work.saturating_sub(1);
        match layout(s, area, &[j], right) {
            Ok(_) => members.push(j),
            Err(fails) if fails[0].1.is_some() => members.push(j),
            Err(_) => {}
        }
    }
    // the crowd's strip: labels in the way join the column only for items standing in it
    let (mut sx0, mut sx1) = (f64::INFINITY, f64::NEG_INFINITY);
    for &j in crowd {
        let b = items[j].shape.bbox();
        sx0 = sx0.min(b.x0);
        sx1 = sx1.max(b.x1);
    }
    let em = items[crowd[0]].em();
    let mut fixed: Vec<usize> = Vec::new();
    loop {
        let unlabeled = members
            .iter()
            .filter(|&&j| s.state.placed[j].is_none())
            .count();
        let worth = unlabeled > 0 || (pass.always && members.len() >= 2);
        if !worth || members.len() > MAX_COLUMN || pass.work == 0 {
            return None;
        }
        pass.work = pass.work.saturating_sub(members.len());
        match layout(s, area, &members, right) {
            Err(fails) => {
                // a placed label in the way joins the column
                let joins = fails.iter().filter_map(|&(_, b)| b).find(|&k| {
                    !pass.excluded[k]
                        && !fixed.contains(&k)
                        && !members.contains(&k)
                        && s.state.placed[k].is_some()
                        && on_side(s, k)
                        && {
                            let b = items[k].shape.bbox();
                            b.x1 >= sx0 - em && b.x0 <= sx1 + em
                        }
                });
                if let Some(k) = joins {
                    members.push(k);
                    continue;
                }
                // a placed member that cannot move into the column keeps its label
                if let Some(&(k, _)) = fails.iter().find(|&&(j, _)| s.state.placed[j].is_some()) {
                    members.retain(|&j| j != k);
                    fixed.push(k);
                    continue;
                }
                // the lowest-priority member without a label among those that fail leaves
                let k = fails
                    .iter()
                    .map(|&(j, _)| j)
                    .max_by_key(|&j| s.pri.prio[j].rank)?;
                members.retain(|&j| j != k);
            }
            Ok(cands) => {
                let added: Vec<usize> = members
                    .iter()
                    .copied()
                    .filter(|&j| s.state.placed[j].is_none())
                    .collect();
                let cost = cands.iter().map(|(_, c)| c.cost).sum();
                return Some(Plan { cands, added, cost });
            }
        }
    }
}

/// Stack `members` in one column and test it against everything else placed. `Err`: the
/// members that fail, each with the placed item in its way (none: a reason of its own).
#[allow(clippy::type_complexity)]
fn layout(
    s: &mut Solve,
    area: &Rect,
    members: &[usize],
    right: bool,
) -> Result<Vec<(usize, Cand)>, Vec<(usize, Option<usize>)>> {
    let model = s.model;
    let items = &model.items;
    let mut order: Vec<usize> = members.to_vec();
    order.sort_by(|&a, &b| {
        crate::math::cmp_f64(items[a].anchor.y, items[b].anchor.y)
            .then(crate::math::cmp_f64(items[a].anchor.x, items[b].anchor.x))
            .then(a.cmp(&b))
    });
    // the variant of each member: its placed one, else its first
    let vis: Vec<usize> = order
        .iter()
        .map(|&j| s.state.placed[j].map_or(0, |c| s.cands[c as usize].variant as usize))
        .collect();
    let hs: Vec<f64> = order
        .iter()
        .zip(&vis)
        .map(|(&j, &v)| s.variants[j][v].h)
        .collect();
    let gap = items[order[0]].len.boundary_gap;
    let desired: Vec<f64> = order.iter().map(|&j| items[j].anchor.y).collect();
    let gaps: Vec<f64> = (1..order.len())
        .map(|k| (hs[k - 1] + hs[k]) * 0.5 + gap)
        .collect();
    let ys = stack(
        &desired,
        &gaps,
        area.y0 + hs[0] * 0.5,
        area.y1 - hs[hs.len() - 1] * 0.5,
    );
    // the column stands beyond the members' marks, as far as the steepest leader needs
    let mut edge = if right {
        f64::NEG_INFINITY
    } else {
        f64::INFINITY
    };
    let mut wmax: f64 = 0.0;
    for (k, &j) in order.iter().enumerate() {
        let b = items[j].shape.bbox();
        edge = if right {
            edge.max(b.x1)
        } else {
            edge.min(b.x0)
        };
        wmax = wmax.max(s.variants[j][vis[k]].w);
    }
    let rise = desired
        .iter()
        .zip(&ys)
        .fold(0.0, |m: f64, (d, y)| m.max((d - y).abs()));
    let room = if right {
        area.x1 - edge - wmax
    } else {
        edge - wmax - area.x0
    };
    let run = (RUN_PER_RISE * rise)
        .min(room)
        .max(MIN_RUN_EM * items[order[0]].em());
    let x = if right { edge + run } else { edge - run };
    // slots in the anchors' vertical order, unless a matching of shorter total leader
    // length exists (anchors spread horizontally)
    let mut slot_of: Vec<usize> = (0..order.len()).collect();
    if hs.iter().all(|&h| h == hs[0])
        && matches!(
            model.leaders.style,
            LeaderStyle::Straight | LeaderStyle::Angles
        )
    {
        let cost: Vec<Vec<f64>> = order
            .iter()
            .map(|&j| {
                ys.iter()
                    .map(|&y| items[j].anchor.dist(P::new(x, y)))
                    .collect()
            })
            .collect();
        let total = |a: &[usize]| a.iter().enumerate().map(|(k, &t)| cost[k][t]).sum::<f64>();
        let m = hungarian(&cost);
        let keep = total(&slot_of);
        if total(&m) < keep - 1e-6 * (1.0 + keep) {
            slot_of = m;
        }
    }
    let mut fresh: Vec<(usize, Cand)> = Vec::with_capacity(order.len());
    let mut ev = Evaluator::new(model, s.obs, s.env);
    for (k, &j) in order.iter().enumerate() {
        let v = &s.variants[j][vis[k]];
        let y = ys[slot_of[k]];
        let rect = if right {
            Rect::new(x, y - v.h * 0.5, x + v.w, y + v.h * 0.5)
        } else {
            Rect::new(x - v.w, y - v.h * 0.5, x, y + v.h * 0.5)
        };
        let mut c = Cand::new(
            j as u32,
            vis[k] as u16,
            v.level,
            Kind::Fan,
            Side::Fan,
            8.0,
            rect,
        );
        let l = boundary_leader(model, &items[j], if right { 1 } else { 0 }, P::new(x, y));
        let too_long = l.len > items[j].len.leader_max + 1e-9;
        if l.len > 0.0 {
            c.leaders.push(l);
        }
        c.lshape = label_shape(&c.rect, &v.shape);
        ev.eval(&mut c, v, None);
        // fan leaders keep to leaders.max_length like distant ones
        if too_long {
            c.feasible = false;
        }
        fresh.push((j, c));
    }
    // test against everything else placed, the members' own labels lifted meanwhile
    let saved: Vec<(usize, u32)> = order
        .iter()
        .filter_map(|&j| s.state.placed[j].map(|c| (j, c)))
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

fn apply(s: &mut Solve, plan: Plan) {
    for &(j, _) in &plan.cands {
        if s.state.placed[j].is_some() {
            s.state.unplace(j, &s.cands);
        }
    }
    for (j, c) in plan.cands {
        let id = s.cands.len() as u32;
        s.cands.push(c);
        s.by_item[j].push(id);
        s.state.place(j, id, &s.cands, false);
        s.reasons[j] = None;
    }
}
