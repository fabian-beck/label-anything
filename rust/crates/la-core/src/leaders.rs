//! Distant candidates with leaders (spec §6.4, §7).

use crate::candidates::{dir_of, Cand, Kind, Leader, Side};
use crate::geom::{Rect, P};
use crate::labels::Variant;
use crate::math::{maxf, minf};
use crate::model::opts::{Attach, LeaderStyle, Port};
use crate::model::{Item, Model};
use crate::obstacles::Obstacles;

/// Leader start on the item for direction `d` (boundary + gap, center or tip).
pub fn leader_start(model: &Model, item: &Item, toward: P) -> P {
    let attach = match model.leaders.attach {
        Attach::Auto => {
            if item.tip {
                Attach::Tip
            } else {
                Attach::Boundary
            }
        }
        a => a,
    };
    let refp = item.shape.reference();
    match attach {
        Attach::Tip | Attach::Center => refp,
        _ => {
            let d = (toward - refp).norm();
            if d.len2() == 0.0 {
                return refp;
            }
            item.shape.boundary_point(d) + d * item.len.anchor_gap
        }
    }
}

/// Place a label of half size (hw, hh) so that its port side faces direction `d` at `t`.
fn attach_label(t: P, d: P, hw: f64, hh: f64, port: Port) -> (Rect, P) {
    let sx = crate::math::sign_eps(d.x, 1e-9);
    let sy = crate::math::sign_eps(d.y, 1e-9);
    match port {
        Port::SideCenter | Port::Baseline => {
            if d.x.abs() >= d.y.abs() * 0.999 {
                let c = P::new(t.x + sx * hw, t.y);
                (Rect::from_center(c, hw, hh), t)
            } else {
                let c = P::new(t.x, t.y + sy * hh);
                (Rect::from_center(c, hw, hh), t)
            }
        }
        Port::Nearest => {
            let c = P::new(t.x + sx * hw, t.y + sy * hh);
            (Rect::from_center(c, hw, hh), t)
        }
    }
}

fn directions(model: &Model) -> Vec<f64> {
    match model.leaders.style {
        LeaderStyle::Angles | LeaderStyle::Elbow => {
            if model.leaders.angles.is_empty() {
                (0..8).map(|k| 45.0 * k as f64).collect()
            } else {
                model.leaders.angles.clone()
            }
        }
        LeaderStyle::Orthogonal => (0..8).map(|k| 45.0 * k as f64).collect(),
        _ => {
            let n = model.placement.distant_directions.max(4);
            (0..n).map(|k| 360.0 * k as f64 / n as f64).collect()
        }
    }
}

/// Distant candidates of one variant.
pub fn distant(model: &Model, obs: &Obstacles, item: &Item, vi: usize, v: &Variant, out: &mut Vec<Cand>) {
    let hw = v.w * 0.5;
    let hh = v.h * 0.5;
    let em = item.em();
    let len = &item.len;
    let rings = model.placement.distant_rings.max(1);
    let style = model.leaders.style;
    let port = model.leaders.port;
    let it = item.index as u32;
    let push = |rect: Rect, pts: Vec<P>, ring: usize, out: &mut Vec<Cand>| {
        let mut l = Leader::new(pts, style);
        if l.len < len.leader_min || l.len > len.leader_max + 1e-9 {
            return;
        }
        if port == Port::Baseline {
            if let Some(t) = &v.text {
                let y = rect.y0 + t.baselines[0] + (rect.h() - t.baselines[0]).min(em * 0.25) * 0.5;
                let x0 = rect.x0 + t.x_offset;
                let x1 = x0 + t.widths[0];
                let end = *l.pts.last().unwrap();
                let (near, far) = if (end.x - x0).abs() <= (end.x - x1).abs() { (x0, x1) } else { (x1, x0) };
                let last = l.pts.len() - 1;
                l.pts[last] = P::new(near, y);
                l = Leader::new(l.pts, style);
                l.underline = Some((P::new(near, y), P::new(far, y)));
            }
        }
        let mut c = Cand::new(it, vi as u16, v.level, Kind::Distant, Side::Distant, 8.0 + ring as f64 * 0.5, rect);
        let members = model.group_members(item.index);
        if members.len() >= 2 {
            // fan leaders: one per member, all ending at the label's port
            let port_pt = l.port;
            for &mi in members {
                let mem = &model.items[mi];
                let s0 = leader_start(model, mem, port_pt);
                let mut fl = Leader::new(vec![s0, rect.closest_point(s0)], style);
                fl.member = Some(mi as u32);
                c.leaders.push(fl);
            }
        } else {
            c.leaders.push(l);
        }
        out.push(c);
    };
    for &theta in &directions(model) {
        let d = dir_of(theta);
        let start = leader_start(model, item, item.shape.reference() + d);
        for k in 0..rings {
            let r = if rings == 1 { len.min_distance } else { len.min_distance + (len.max_distance - len.min_distance) * k as f64 / (rings - 1) as f64 };
            if r <= 0.0 {
                continue;
            }
            match style {
                LeaderStyle::Elbow => {
                    let e = start + d * r;
                    let run = 0.75 * em;
                    let sx = if d.x >= 0.0 { 1.0 } else { -1.0 };
                    let p = P::new(e.x + sx * run, e.y);
                    let rect = Rect::from_center(P::new(p.x + sx * hw, p.y), hw, hh);
                    push(rect, vec![start, e, p], k, out);
                }
                LeaderStyle::Orthogonal => {
                    let t = start + d * r;
                    let (rect, port_pt) = attach_label(t, d, hw, hh, Port::SideCenter);
                    if d.x.abs() < 1e-9 || d.y.abs() < 1e-9 {
                        push(rect, vec![start, port_pt], k, out);
                    } else {
                        // po: vertical then horizontal into the side-center port
                        let bend = P::new(start.x, port_pt.y);
                        push(rect, vec![start, bend, port_pt], k, out);
                    }
                }
                _ => {
                    let t = start + d * r;
                    let (rect, mut port_pt) = attach_label(t, d, hw, hh, port);
                    let mut s0 = start;
                    if style == LeaderStyle::Straight && port == Port::Nearest {
                        port_pt = rect.closest_point(start);
                        s0 = leader_start(model, item, port_pt);
                        port_pt = rect.closest_point(s0);
                    }
                    push(rect, vec![s0, port_pt], k, out);
                }
            }
        }
    }
    // free-space seeds: local maxima of the distance transform near the item
    if model.placement.free_space_seeds && !obs.dt.is_empty() {
        for seed in free_space_seeds(obs, item, hh) {
            let rect = Rect::from_center(seed, hw, hh);
            let start = leader_start(model, item, seed);
            let port_pt = rect.closest_point(start);
            let start = leader_start(model, item, port_pt);
            let pts = match style {
                LeaderStyle::Orthogonal => {
                    let bend = P::new(start.x, port_pt.y);
                    if (bend.x - port_pt.x).abs() < 1e-9 || (bend.y - start.y).abs() < 1e-9 {
                        vec![start, port_pt]
                    } else {
                        vec![start, bend, port_pt]
                    }
                }
                _ => vec![start, port_pt],
            };
            if matches!(style, LeaderStyle::Angles | LeaderStyle::Elbow) {
                continue; // angle-restricted styles only use their rays
            }
            push(rect, pts, rings, out);
        }
    }
}

/// Up to 8 local maxima of the distance transform within `max_distance` of the item
/// whose clearance is at least `hh` (precomputed in `Obstacles::seeds`).
pub fn free_space_seeds(obs: &Obstacles, item: &Item, hh: f64) -> Vec<P> {
    let bb = item.shape.bbox();
    let reach = item.len.max_distance + bb.w().max(bb.h()) * 0.5;
    let c = item.shape.reference();
    let mut ids = Vec::new();
    obs.seed_index.query(&Rect::from_center(c, reach, reach), &mut ids);
    let mut seeds: Vec<(f64, usize, usize, P)> = Vec::new();
    for id in ids {
        let (p, v, col, row) = obs.seeds[id as usize];
        let dd = p.dist(c);
        if v >= hh && dd <= reach && dd > hh {
            seeds.push((v - 0.01 * dd, col, row, p));
        }
    }
    seeds.sort_by(|a, b| crate::math::cmp_f64(b.0, a.0).then(a.2.cmp(&b.2)).then(a.1.cmp(&b.1)));
    seeds.truncate(8);
    seeds.into_iter().map(|s| s.3).collect()
}

/// Leader length helper for tests.
pub fn polyline_len(pts: &[P]) -> f64 {
    let mut l = 0.0;
    for w in pts.windows(2) {
        l += w[0].dist(w[1]);
    }
    maxf(minf(l, f64::MAX), 0.0)
}
