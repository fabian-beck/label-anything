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
            if !keep(vi, &rect) {
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
    seeds.sort_by(|a, b| {
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
