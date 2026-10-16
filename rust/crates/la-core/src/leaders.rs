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
        c.leaders.push(l);
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
/// whose clearance is at least `hh`.
pub fn free_space_seeds(obs: &Obstacles, item: &Item, hh: f64) -> Vec<P> {
    let g = &obs.grid;
    let reach = item.len.max_distance + item.shape.bbox().w().max(item.shape.bbox().h()) * 0.5;
    let c = item.shape.reference();
    let area = Rect::from_center(c, reach, reach);
    let (c0, c1, r0, r1) = g.cell_range(&area);
    let mut seeds: Vec<(f64, usize, usize)> = Vec::new();
    for r in r0..r1 {
        for col in c0..c1 {
            let v = obs.dt[r * g.cols + col];
            if v < hh || v >= 1e9 {
                continue;
            }
            let mut is_max = true;
            'n: for dr in -1i64..=1 {
                for dc in -1i64..=1 {
                    if dr == 0 && dc == 0 {
                        continue;
                    }
                    let (rr, cc) = (r as i64 + dr, col as i64 + dc);
                    if rr < 0 || cc < 0 || rr >= g.rows as i64 || cc >= g.cols as i64 {
                        continue;
                    }
                    let w = obs.dt[rr as usize * g.cols + cc as usize];
                    if w > v || (w == v && (dr < 0 || (dr == 0 && dc < 0))) {
                        is_max = false;
                        break 'n;
                    }
                }
            }
            if is_max {
                let p = g.cell_center(col, r);
                let dd = p.dist(c);
                if dd <= reach && dd > hh {
                    seeds.push((v - 0.01 * dd, col, r));
                }
            }
        }
    }
    seeds.sort_by(|a, b| crate::math::cmp_f64(b.0, a.0).then(a.2.cmp(&b.2)).then(a.1.cmp(&b.1)));
    seeds.truncate(8);
    seeds.into_iter().map(|(_, col, r)| g.cell_center(col, r)).collect()
}

/// Leader length helper for tests.
pub fn polyline_len(pts: &[P]) -> f64 {
    let mut l = 0.0;
    for w in pts.windows(2) {
        l += w[0].dist(w[1]);
    }
    maxf(minf(l, f64::MAX), 0.0)
}
