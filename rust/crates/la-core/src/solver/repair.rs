//! Post-search repairs: joint boundary slot assignment (spec §6.6) and leader uncrossing
//! (spec §10.3).

use super::Solve;
use crate::boundary::{slot_area, slot_candidate};
use crate::candidates::{Cand, Kind};
use crate::cost::Evaluator;
use crate::geom::seg_intersects;
use crate::model::opts::LeaderStyle;

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
            t += cand.cost + s.state.dynamic_cost(cand, &s.cands, s.obs, it.len.buffer, it.len.clearance, s.model.leaders.width, i);
        }
    }
    t
}

/// Re-stack the boundary labels of each side jointly; keep the result when every label
/// stays feasible and the total cost drops.
pub fn boundary_pass(s: &mut Solve) {
    let Some(area) = slot_area(s.model, s.obs) else { return };
    let n = s.model.items.len();
    for side in 0u8..4 {
        let members: Vec<usize> = (0..n)
            .filter(|&i| s.state.placed[i].map(|c| s.cands[c as usize].kind == Kind::Boundary && s.cands[c as usize].bside == side).unwrap_or(false))
            .collect();
        if members.len() < 2 {
            continue;
        }
        let horizontal_side = side <= 1;
        let key = |i: usize| if horizontal_side { s.model.items[i].anchor.y } else { s.model.items[i].anchor.x };
        let mut order = members.clone();
        order.sort_by(|&a, &b| crate::math::cmp_f64(key(a), key(b)).then(a.cmp(&b)));
        let sizes: Vec<f64> = order
            .iter()
            .map(|&i| {
                let c = &s.cands[s.state.placed[i].unwrap() as usize];
                if horizontal_side {
                    c.rect.h()
                } else {
                    c.rect.w()
                }
            })
            .collect();
        let gap = s.model.items[order[0]].len.boundary_gap;
        let (lo, hi) = if horizontal_side { (area.y0, area.y1) } else { (area.x0, area.x1) };
        let positions: Vec<f64> = if s.model.placement.boundary.spread {
            let k = order.len() as f64;
            (0..order.len()).map(|j| lo + (hi - lo) * (j as f64 + 0.5) / k).collect()
        } else {
            let desired: Vec<f64> = order.iter().map(|&i| key(i)).collect();
            let gaps: Vec<f64> = (1..order.len()).map(|j| (sizes[j - 1] + sizes[j]) * 0.5 + gap).collect();
            stack(&desired, &gaps, lo + sizes[0] * 0.5, hi - sizes[sizes.len() - 1] * 0.5)
        };
        // assignment: straight leaders → min total length; otherwise keep the order
        let assign: Vec<usize> = if s.model.leaders.style == LeaderStyle::Straight || s.model.leaders.style == LeaderStyle::Angles {
            let m = order.len();
            let cost: Vec<Vec<f64>> = order
                .iter()
                .map(|&i| {
                    let a = s.model.items[i].anchor;
                    (0..m)
                        .map(|j| {
                            let p = if horizontal_side {
                                crate::geom::P::new(if side == 0 { area.x0 } else { area.x1 }, positions[j])
                            } else {
                                crate::geom::P::new(positions[j], if side == 2 { area.y0 } else { area.y1 })
                            };
                            a.dist(p)
                        })
                        .collect()
                })
                .collect();
            hungarian(&cost)
        } else {
            (0..order.len()).collect()
        };
        // build the new candidates
        let old: Vec<(usize, u32)> = order.iter().map(|&i| (i, s.state.placed[i].unwrap())).collect();
        let before = total_cost(s, &order);
        let mut fresh: Vec<(usize, Cand)> = Vec::new();
        for (k, &i) in order.iter().enumerate() {
            let oc = &s.cands[s.state.placed[i].unwrap() as usize];
            let vi = oc.variant as usize;
            let v = &s.variants[i][vi];
            let mut c = slot_candidate(s.model, &area, &s.model.items[i], vi, v, side, positions[assign[k]], oc.rank);
            c.level = oc.level;
            c.lshape = crate::candidates::label_shape(&c.rect, &v.shape);
            let mut ev = Evaluator::new(s.model, s.obs, s.env);
            ev.eval(&mut c, v, None);
            fresh.push((i, c));
        }
        if fresh.iter().any(|(_, c)| !c.feasible) {
            continue;
        }
        for &i in &order {
            s.state.unplace(i, &s.cands);
        }
        let mut ok = true;
        let mut placed_now: Vec<usize> = Vec::new();
        for (i, c) in fresh {
            let id = s.cands.len() as u32;
            s.cands.push(c);
            s.by_item[i].push(id);
            let cand = s.cands[id as usize].clone();
            let mut scratch = Vec::new();
            if !s.state.is_free(&cand, &s.cands, s.obs, i, &mut scratch) {
                ok = false;
                break;
            }
            s.state.place(i, id, &s.cands, false);
            placed_now.push(i);
        }
        if ok {
            let after = total_cost(s, &order);
            if after < before - 1e-9 {
                continue;
            }
        }
        for &i in &placed_now {
            s.state.unplace(i, &s.cands);
        }
        for (i, c) in old {
            let relaxed = !s.cands[c as usize].feasible;
            s.state.place(i, c, &s.cands, relaxed);
        }
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
            let Some(ci) = s.state.placed[i] else { continue };
            if s.cands[ci as usize].leaders.is_empty() {
                continue;
            }
            for j in (i + 1)..n {
                let Some(cj) = s.state.placed[j] else { continue };
                let (a, b) = (&s.cands[ci as usize], &s.cands[cj as usize]);
                if b.leaders.is_empty() || !a.bbox().touches(&b.bbox()) {
                    continue;
                }
                let cross = a.leaders.iter().any(|la| la.segments().any(|(p, q)| b.leaders.iter().any(|lb| lb.segments().any(|(r, t)| seg_intersects(p, q, r, t)))));
                if !cross {
                    continue;
                }
                // try: i at j's box center, j at i's box center (same variants)
                let len_before = a.leaders[0].len + b.leaders[0].len;
                let ni = moved_to(s, i, ci, b.rect.center());
                let nj = moved_to(s, j, cj, a.rect.center());
                let (Some(ni), Some(nj)) = (ni, nj) else { continue };
                if ni.leaders.is_empty() || nj.leaders.is_empty() || ni.leaders[0].len + nj.leaders[0].len >= len_before - 1e-9 || !ni.feasible || !nj.feasible {
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
                let ci2 = s.cands[id_i as usize].clone();
                let ok_i = s.state.is_free(&ci2, &s.cands, s.obs, i, &mut scratch);
                if ok_i {
                    s.state.place(i, id_i, &s.cands, false);
                    let cj2 = s.cands[id_j as usize].clone();
                    if s.state.is_free(&cj2, &s.cands, s.obs, j, &mut scratch) {
                        s.state.place(j, id_j, &s.cands, false);
                        improved = true;
                        break 'pairs;
                    }
                    s.state.unplace(i, &s.cands);
                }
                s.state.place(i, ci, &s.cands, !s.cands[ci as usize].feasible);
                s.state.place(j, cj, &s.cands, !s.cands[cj as usize].feasible);
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
    c.leaders.push(crate::candidates::Leader::new(vec![start, rect.closest_point(start)], f.leaders.first().map(|l| l.style).unwrap_or(LeaderStyle::Straight)));
    let mut ev = Evaluator::new(s.model, s.obs, s.env);
    ev.eval(&mut c, v, None);
    Some(c)
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
        let c = vec![vec![4.0, 1.0, 3.0], vec![2.0, 0.0, 5.0], vec![3.0, 2.0, 2.0]];
        let a = hungarian(&c);
        let total: f64 = a.iter().enumerate().map(|(i, &j)| c[i][j]).sum();
        assert_eq!(total, 5.0);
    }
}
