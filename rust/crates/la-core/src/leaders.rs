//! Distant candidates with leaders (spec §6.4, §7).

use crate::candidates::{dir_of, Cand, Kind, Leader, Side};
use crate::geom::{Rect, P};
use crate::labels::Variant;
use crate::math::{maxf, minf};
use crate::model::opts::{Attach, LeaderStyle, Port};
use crate::model::{Item, Model};
use crate::obstacles::FreeSpace;

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

/// The box (width `w`, height `h`) of a label whose leader ends at `t` on its `baseline`
/// port: on the side edge facing the leader (the left edge when the label lies to the
/// right of the anchor, `d.x ≥ 0`), at the height `u` of the underline (from the box top).
fn attach_baseline(t: P, d: P, w: f64, h: f64, u: f64) -> Rect {
    let x0 = if d.x >= 0.0 { t.x } else { t.x - w };
    Rect::new(x0, t.y - u, x0 + w, t.y - u + h)
}

/// Height of the underline of the `baseline` port below the box top: below the first
/// line's baseline, halfway into its descent (at most 0.25 em).
pub fn underline_offset(t: &crate::labels::TextLayout, h: f64, em: f64) -> f64 {
    t.baselines[0] + minf(h - t.baselines[0], em * 0.25) * 0.5
}

/// cos 22.5° (half the angle between neighbouring fixed positions), less a tolerance so
/// that a ray on the boundary of two octants belongs to both.
const COS_HALF_OCTANT: f64 = 0.923_879_532_511_286_7 - 1e-9;

/// Whether a distant label in direction `v` from its item keeps to the item's positions:
/// an explicit `position_order` with fewer than the 8 fixed positions allows only the
/// directions within 22.5° of a listed position's direction (spec §6.4), so that labels
/// restricted to the right of line ends do not move left over the lines.
pub fn keeps_to_positions(item: &Item, v: P) -> bool {
    if item.positions.len() >= 8 {
        return true;
    }
    let n = v.len();
    n == 0.0
        || item.positions.iter().any(|p| {
            let u = p.dir();
            v.dot(u) >= COS_HALF_OCTANT * n * u.len()
        })
}

/// Leader directions of distant candidates with their unit vectors (computed once per
/// solve; the trigonometry is the expensive part of candidate generation).
pub fn distant_dirs(model: &Model) -> Vec<(f64, P)> {
    directions(model)
        .into_iter()
        .map(|t| (t, dir_of(t)))
        .collect()
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

/// Distant candidates of one variant. Label boxes for which `keep(vi, box)` is false are
/// skipped before their leaders are built.
#[allow(clippy::too_many_arguments)]
pub fn distant(
    model: &Model,
    seeds: &[NearSeed],
    item: &Item,
    vi: usize,
    v: &Variant,
    dirs: &[(f64, P)],
    keep: &impl Fn(usize, &Rect) -> bool,
    out: &mut Vec<Cand>,
) {
    let hw = v.w * 0.5;
    let hh = v.h * 0.5;
    let em = item.em();
    let len = &item.len;
    let rings = model.placement.distant_rings.max(1);
    let style = model.leaders.style;
    let port = model.leaders.port;
    let it = item.index as u32;
    // baseline port (straight, angles and elbow leaders, and free-space seeds): the
    // leader ends on the box's side edge at the height of an underline below the first
    // text line, which continues it to the far end of that line (spec §7)
    let under = match (port, &v.text) {
        (Port::Baseline, Some(t)) => Some(underline_offset(t, v.h, em)),
        _ => None,
    };
    let push = |rect: Rect, pts: Vec<P>, ring: usize, underline: bool, out: &mut Vec<Cand>| {
        let mut l = Leader::new(pts, style);
        if l.len < len.leader_min || l.len > len.leader_max + 1e-9 {
            return;
        }
        if let (true, Some(t)) = (underline, &v.text) {
            let p = l.port;
            let x0 = rect.x0 + t.x_offset;
            let far = if p.x <= rect.center().x {
                x0 + t.widths[0]
            } else {
                x0
            };
            l.underline = Some((p, P::new(far, p.y)));
        }
        let mut c = Cand::new(
            it,
            vi as u16,
            v.level,
            Kind::Distant,
            Side::Distant,
            8.0 + ring as f64 * 0.5,
            rect,
        );
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
    for &(_, d) in dirs {
        if !keeps_to_positions(item, d) {
            continue;
        }
        let start = leader_start(model, item, item.shape.reference() + d);
        for k in 0..rings {
            let r = if rings == 1 {
                len.min_distance
            } else {
                len.min_distance
                    + (len.max_distance - len.min_distance) * k as f64 / (rings - 1) as f64
            };
            if r <= 0.0 {
                continue;
            }
            match style {
                LeaderStyle::Elbow => {
                    let e = start + d * r;
                    let run = 0.75 * em;
                    let sx = if d.x >= 0.0 { 1.0 } else { -1.0 };
                    let p = P::new(e.x + sx * run, e.y);
                    let rect = match under {
                        Some(u) => attach_baseline(p, d, v.w, v.h, u),
                        None => Rect::from_center(P::new(p.x + sx * hw, p.y), hw, hh),
                    };
                    if keep(vi, &rect) {
                        push(rect, vec![start, e, p], k, under.is_some(), out);
                    }
                }
                LeaderStyle::Orthogonal => {
                    let t = start + d * r;
                    let (rect, port_pt) = attach_label(t, d, hw, hh, Port::SideCenter);
                    if !keep(vi, &rect) {
                        continue;
                    }
                    if d.x.abs() < 1e-9 || d.y.abs() < 1e-9 {
                        push(rect, vec![start, port_pt], k, false, out);
                    } else {
                        // po: vertical then horizontal into the side-center port
                        let bend = P::new(start.x, port_pt.y);
                        push(rect, vec![start, bend, port_pt], k, false, out);
                    }
                }
                LeaderStyle::Curved => {
                    let t = start + d * r;
                    let (rect, _) = attach_label(t, d, hw, hh, port);
                    if !keep(vi, &rect) {
                        continue;
                    }
                    let port_pt = rect.closest_point(start);
                    let s0 = leader_start(model, item, port_pt);
                    let port_pt = rect.closest_point(s0);
                    // straight and two bows; the flattened curve is the collision geometry
                    for bow in [0.0, 0.3, -0.3] {
                        let pts = curve_points(s0, port_pt, bow);
                        let ctrl = curve_control(s0, port_pt, bow);
                        let mut c = out.len();
                        push(rect, pts, k, false, out);
                        if out.len() > c {
                            c = out.len() - 1;
                            if let Some(l) = out[c].leaders.first_mut() {
                                l.curve = Some([s0, ctrl, port_pt]);
                                l.bends = 0;
                            }
                        }
                    }
                }
                _ => {
                    let t = start + d * r;
                    let (rect, mut port_pt) = match under {
                        Some(u) => (attach_baseline(t, d, v.w, v.h, u), t),
                        None => attach_label(t, d, hw, hh, port),
                    };
                    if !keep(vi, &rect) {
                        continue;
                    }
                    let mut s0 = start;
                    if style == LeaderStyle::Straight && port == Port::Nearest {
                        port_pt = rect.closest_point(start);
                        s0 = leader_start(model, item, port_pt);
                        port_pt = rect.closest_point(s0);
                    }
                    push(rect, vec![s0, port_pt], k, under.is_some(), out);
                }
            }
        }
    }
    // free-space seeds: local maxima of the distance transform near the item
    if model.placement.free_space_seeds {
        for seed in free_space_seeds(seeds, hh) {
            let rect = Rect::from_center(seed, hw, hh);
            if !keeps_to_positions(item, seed - item.shape.reference()) || !keep(vi, &rect) {
                continue;
            }
            let start = leader_start(model, item, seed);
            let baseline = under.filter(|_| style != LeaderStyle::Orthogonal);
            let port_pt = match baseline {
                // the side edge facing the item, at the underline's height
                Some(u) => P::new(
                    if start.x <= seed.x { rect.x0 } else { rect.x1 },
                    rect.y0 + u,
                ),
                None => rect.closest_point(start),
            };
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
            push(rect, pts, rings, baseline.is_some(), out);
        }
    }
}

/// A local maximum of the distance transform near an item (see [`item_seeds`]).
#[derive(Clone, Copy, Debug)]
pub struct NearSeed {
    /// Ranking key: clearance − 0.01 × distance (higher first).
    key: f64,
    col: usize,
    row: usize,
    p: P,
    /// Clearance (px).
    v: f64,
    /// Distance from the item's reference point.
    dd: f64,
}

/// The local maxima of the distance transform within reach of the item (`max_distance`
/// plus half its mark), best first: the input of [`free_space_seeds`], the same for
/// all variants of the item.
pub fn item_seeds(fs: &FreeSpace, item: &Item) -> Vec<NearSeed> {
    if fs.dt.is_empty() {
        return Vec::new();
    }
    let bb = item.shape.bbox();
    let reach = item.len.max_distance + bb.w().max(bb.h()) * 0.5;
    let c = item.shape.reference();
    let mut ids = Vec::new();
    fs.seed_index
        .query(&Rect::from_center(c, reach, reach), &mut ids);
    let mut seeds: Vec<NearSeed> = Vec::new();
    for id in ids {
        let (p, v, col, row) = fs.seeds[id as usize];
        let dd = p.dist(c);
        if dd <= reach {
            seeds.push(NearSeed {
                key: v - 0.01 * dd,
                col,
                row,
                p,
                v,
                dd,
            });
        }
    }
    crate::sort::sort_by(&mut seeds, |a, b| {
        crate::math::cmp_f64(b.key, a.key)
            .then(a.row.cmp(&b.row))
            .then(a.col.cmp(&b.col))
    });
    seeds
}

/// Up to 8 local maxima of the distance transform within `max_distance` of the item
/// whose clearance is at least `hh` (and farther than `hh` from the item), best first;
/// `seeds` are the item's seeds ([`item_seeds`]).
pub fn free_space_seeds(seeds: &[NearSeed], hh: f64) -> impl Iterator<Item = P> + '_ {
    seeds
        .iter()
        .filter(move |s| s.v >= hh && s.dd > hh)
        .take(8)
        .map(|s| s.p)
}

/// Control point of a quadratic leader bowed by `bow × length` to the left of `a → b`.
pub fn curve_control(a: P, b: P, bow: f64) -> P {
    let m = a.lerp(b, 0.5);
    let d = b - a;
    m + P::new(-d.y, d.x) * bow
}

/// Flattened quadratic Bézier (8 segments; straight when `bow` is 0).
pub fn curve_points(a: P, b: P, bow: f64) -> Vec<P> {
    if bow == 0.0 {
        return vec![a, b];
    }
    let c = curve_control(a, b, bow);
    (0..=8)
        .map(|k| {
            let t = k as f64 / 8.0;
            let u = 1.0 - t;
            P::new(
                u * u * a.x + 2.0 * u * t * c.x + t * t * b.x,
                u * u * a.y + 2.0 * u * t * c.y + t * t * b.y,
            )
        })
        .collect()
}

/// Leader length helper for tests.
pub fn polyline_len(pts: &[P]) -> f64 {
    let mut l = 0.0;
    for w in pts.windows(2) {
        l += w[0].dist(w[1]);
    }
    maxf(minf(l, f64::MAX), 0.0)
}

/// Spacing rules between the leaders of two items (spec §7).
#[derive(Clone, Copy, Debug)]
pub struct Spacing {
    /// `leaders.clearance` (the larger of the two items').
    pub clr: f64,
    /// Distant leaders starting closer than this (the larger font size) must diverge.
    pub near: f64,
    /// Cosine of `leaders.min_angle_between`; 1 turns the angle rule off.
    pub cos_min: f64,
    /// The space two labels keep: the larger of the two items' `defaults.margin`.
    pub gap: f64,
}

/// Whether two leaders of different labels conflict when `avoid.leader.leaders` is hard
/// (spec §7): a segment of one intersects a segment of the other, or the leaders come
/// closer than `clr` anywhere except where both start (leaders of neighbouring marks
/// start close together).
pub fn leaders_conflict(a: &Leader, b: &Leader, clr: f64) -> bool {
    for (p, q) in a.segments() {
        if b.segments()
            .any(|(r, t)| crate::geom::seg_intersects(p, q, r, t))
        {
            return true;
        }
    }
    clr > 0.0 && (vertex_near(a, b, clr) || vertex_near(b, a, clr))
}

/// Whether two leaders start closer than `near` and leave in directions less than
/// `leaders.min_angle_between` apart (`cos_min` its cosine).
pub fn leaders_parallel(a: &Leader, b: &Leader, near: f64, cos_min: f64) -> bool {
    if a.pts.len() < 2 || b.pts.len() < 2 || cos_min >= 1.0 {
        return false;
    }
    let (a0, b0) = (a.pts[0], b.pts[0]);
    if a0.dist(b0) >= near {
        return false;
    }
    let (u, v) = (a.pts[1] - a0, b.pts[1] - b0);
    let (lu, lv) = (u.len(), v.len());
    lu > crate::geom::EPS && lv > crate::geom::EPS && u.dot(v) > cos_min * lu * lv
}

/// Hard leader conflict between two candidates of different items: their leaders
/// intersect or come too close, or (both distant) start close together in nearly the
/// same direction.
pub fn cand_leaders_conflict(a: &Cand, b: &Cand, sp: Spacing) -> bool {
    let angle = a.kind == Kind::Distant && b.kind == Kind::Distant;
    a.leaders.iter().any(|la| {
        b.leaders.iter().any(|lb| {
            leaders_conflict(la, lb, sp.clr)
                || (angle && leaders_parallel(la, lb, sp.near, sp.cos_min))
        })
    })
}

/// A vertex of `a` closer than `clr` to `b`, except `a`'s start when `b` starts within
/// `clr` of it (leaders of neighbouring marks start close together; if they stay close,
/// their other vertices come close too). Leaders that do not intersect are closest at a
/// vertex of one of them.
fn vertex_near(a: &Leader, b: &Leader, clr: f64) -> bool {
    let Some(&b0) = b.pts.first() else {
        return false;
    };
    let under = a.underline.iter().flat_map(|&(u, v)| [u, v]);
    for (k, p) in a.pts.iter().copied().chain(under).enumerate() {
        let mut d = f64::INFINITY;
        for (r, t) in b.segments() {
            d = minf(d, crate::geom::dist_point_seg(p, r, t));
        }
        if d < clr - crate::geom::EPS && !(k == 0 && p.dist(b0) <= clr) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leader(pts: &[(f64, f64)]) -> Leader {
        Leader::new(
            pts.iter().map(|&(x, y)| P::new(x, y)).collect(),
            LeaderStyle::Straight,
        )
    }

    #[test]
    fn crossing_and_near_leaders_conflict() {
        let a = leader(&[(0.0, 0.0), (100.0, 0.0)]);
        // crossing
        assert!(leaders_conflict(
            &a,
            &leader(&[(50.0, -20.0), (50.0, 20.0)]),
            0.0
        ));
        // a port 2 px from the other leader reads as a crossing (T-junction)
        let t = leader(&[(50.0, 40.0), (50.0, 2.0)]);
        assert!(leaders_conflict(&a, &t, 4.8));
        assert!(leaders_conflict(&t, &a, 4.8));
        assert!(!leaders_conflict(&a, &t, 1.5));
        // a bend near the other leader counts too
        let bend = leader(&[(30.0, 40.0), (30.0, 3.0), (-20.0, 3.0)]);
        assert!(leaders_conflict(&a, &bend, 4.8));
    }

    #[test]
    fn neighbouring_starts_may_be_close() {
        // starts 3 px apart, leaving in different directions: no conflict
        let a = leader(&[(0.0, 0.0), (0.0, -50.0)]);
        let b = leader(&[(3.0, 0.0), (40.0, -40.0)]);
        assert!(!leaders_conflict(&a, &b, 4.8));
        // parallel at 3 px: the far ends are close as well
        let c = leader(&[(3.0, 0.0), (3.0, -50.0)]);
        assert!(leaders_conflict(&a, &c, 4.8));
        // a leader passing another leader's start is no start-start approach
        let d = leader(&[(-20.0, 2.0), (20.0, 2.0)]);
        assert!(leaders_conflict(&a, &d, 4.8));
    }

    #[test]
    fn underline_ends_count_as_vertices() {
        let a = leader(&[(0.0, 0.0), (100.0, 0.0)]);
        let mut u = leader(&[(60.0, 40.0), (60.0, 10.0)]);
        u.underline = Some((P::new(60.0, 10.0), P::new(80.0, 3.0)));
        assert!(leaders_conflict(&a, &u, 4.8));
        assert!(!leaders_conflict(&a, &u, 2.5));
    }

    #[test]
    fn diverging_leaders() {
        let cos10 = la_expr::det_math::cos_deg(10.0);
        let a = leader(&[(0.0, 0.0), (100.0, 0.0)]);
        let nearly = leader(&[(0.0, 7.0), (98.0, 10.0)]);
        let apart = leader(&[(0.0, 7.0), (78.0, 60.0)]);
        assert!(leaders_parallel(&a, &nearly, 12.0, cos10));
        assert!(!leaders_parallel(&a, &apart, 12.0, cos10));
        // starts farther apart than `near`, or the rule off
        assert!(!leaders_parallel(&a, &nearly, 6.0, cos10));
        assert!(!leaders_parallel(&a, &nearly, 12.0, 1.0));
    }
}
