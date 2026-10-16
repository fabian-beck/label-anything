//! Candidate generation (spec §6): adjacent, slider, internal (distant and boundary
//! candidates live in `leaders.rs` / `boundary.rs`).

use crate::geom::shape::{sign_dir, Shape};
use crate::geom::{dist_point_seg, polygon, Rect, P};
use crate::labels::Variant;
use crate::math::{maxf, sin_cos_deg};
use crate::model::opts::{InternalPolicy, LeaderStyle, Models, Pos};
use crate::model::Item;

/// Candidate model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Adjacent,
    Slider,
    Internal,
    Distant,
    Boundary,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Adjacent => "adjacent",
            Kind::Slider => "slider",
            Kind::Internal => "internal",
            Kind::Distant => "distant",
            Kind::Boundary => "boundary",
        }
    }
}

/// Reported anchor side.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Pos(Pos),
    Internal,
    Distant,
    Boundary,
}

impl Side {
    pub fn name(self) -> &'static str {
        match self {
            Side::Pos(p) => p.name(),
            Side::Internal => "internal",
            Side::Distant => "distant",
            Side::Boundary => "boundary",
        }
    }
}

/// Why a candidate is infeasible.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Block {
    Edge,
    Items,
    Labels,
    Leaders,
    /// A static obstacle class (index into `Obstacles::classes`).
    Class(u16),
}

/// A leader polyline from the item to the label's port.
#[derive(Clone, Debug, PartialEq)]
pub struct Leader {
    /// From the item (boundary + gap, or tip) to the port.
    pub pts: Vec<P>,
    pub port: P,
    pub style: LeaderStyle,
    pub bends: u8,
    pub len: f64,
    /// Underline below the first text line (port = baseline).
    pub underline: Option<(P, P)>,
    /// Quadratic Bézier control points for curved leaders: (start, control, end).
    pub curve: Option<[P; 3]>,
    /// For fan leaders: which member the leader points to.
    pub member: Option<u32>,
}

impl Leader {
    pub fn new(pts: Vec<P>, style: LeaderStyle) -> Leader {
        let mut len = 0.0;
        for w in pts.windows(2) {
            len += w[0].dist(w[1]);
        }
        let bends = pts.len().saturating_sub(2) as u8;
        let port = *pts.last().unwrap_or(&P::new(0.0, 0.0));
        Leader { pts, port, style, bends, len, underline: None, curve: None, member: None }
    }
    /// Segments including the underline.
    pub fn segments(&self) -> impl Iterator<Item = (P, P)> + '_ {
        self.pts.windows(2).map(|w| (w[0], w[1])).chain(self.underline.iter().copied())
    }
    pub fn bbox(&self) -> Rect {
        let mut r = crate::geom::bbox_of(&self.pts);
        if let Some((a, b)) = self.underline {
            r = r.add_point(a).add_point(b);
        }
        r
    }
}

/// A label candidate.
#[derive(Clone, Debug)]
pub struct Cand {
    pub item: u32,
    pub variant: u16,
    pub level: u8,
    pub kind: Kind,
    pub side: Side,
    /// Position rank (cost term `w_position · rank / 8`).
    pub rank: f64,
    pub rect: Rect,
    pub leaders: Vec<Leader>,
    /// Static cost (valid when `feasible` or `relaxed`).
    pub cost: f64,
    /// Statically feasible under the strict policy.
    pub feasible: bool,
    /// Feasible when the relaxable classes are relaxed (soft_overlap); `relax_cost` is
    /// the extra cost then.
    pub relaxed: bool,
    pub relax_cost: f64,
    /// The first hard constraint that rejected the candidate.
    pub blocked: Option<Block>,
}

impl Cand {
    pub fn new(item: u32, variant: u16, level: u8, kind: Kind, side: Side, rank: f64, rect: Rect) -> Cand {
        Cand {
            item,
            variant,
            level,
            kind,
            side,
            rank,
            rect,
            leaders: Vec::new(),
            cost: 0.0,
            feasible: true,
            relaxed: true,
            relax_cost: 0.0,
            blocked: None,
        }
    }
    /// Bounding box of label and leaders.
    pub fn bbox(&self) -> Rect {
        let mut r = self.rect;
        for l in &self.leaders {
            r = r.union(&l.bbox());
        }
        r
    }
}

/// Screen direction for an angle in degrees (counter-clockwise on screen, 0 = right).
#[inline]
pub fn dir_of(angle_deg: f64) -> P {
    let (s, c) = sin_cos_deg(angle_deg);
    P::new(c, -s)
}

/// Label center touching `S ⊕ o` in direction `d` (spec §6.1).
#[inline]
pub fn touch_center(shape: &Shape, o: f64, d: P, hw: f64, hh: f64) -> P {
    let s = shape.support_inflated(d, o);
    let (sx, sy) = sign_dir(d);
    P::new(s.x + sx * hw, s.y + sy * hh)
}

/// For concave polygons, labels placed against the convex hull are pushed toward the
/// true shape until they touch it (spec §4.5 rule 1: "a final push-out so the label clears
/// the inflated shape exactly").
fn push_in(shape: &Shape, o: f64, c: P, hw: f64, hh: f64) -> P {
    let Shape::Polygon(p) = shape else { return c };
    if p.rings.len() == 1 && p.rings[0].len() == p.hull.len() {
        return c; // convex
    }
    let gap = shape.dist_rect(&Rect::from_center(c, hw, hh)) - o;
    if gap <= 0.25 {
        return c;
    }
    let d = (c - shape.reference()).norm();
    if d.len2() == 0.0 {
        return c;
    }
    let (mut lo, mut hi) = (0.0, gap + hw.max(hh));
    for _ in 0..30 {
        let mid = (lo + hi) * 0.5;
        let r = Rect::from_center(c - d * mid, hw, hh);
        if shape.dist_rect(&r) >= o - 1e-9 && !shape.overlaps_rect(&r) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    c - d * lo
}

/// Adjacent and slider candidates of one variant.
pub fn adjacent(item: &Item, vi: usize, v: &Variant, slider_per_gap: usize, models: Models, out: &mut Vec<Cand>) {
    let hw = v.w * 0.5;
    let hh = v.h * 0.5;
    let o = item.len.offset;
    let shape = &item.shape;
    let ranks: Vec<(Pos, f64)> = item.positions.iter().enumerate().map(|(r, p)| (*p, r as f64)).collect();
    let rank_of = |p: Pos| ranks.iter().find(|(q, _)| *q == p).map(|x| x.1);
    let it = item.index as u32;
    if models.has(Models::ADJACENT) {
        for &(p, r) in &ranks {
            let c = push_in(shape, o, touch_center(shape, o, dir_of(p.angle()), hw, hh), hw, hh);
            out.push(Cand::new(it, vi as u16, v.level, Kind::Adjacent, Side::Pos(p), r, Rect::from_center(c, hw, hh)));
        }
    }
    if !models.has(Models::SLIDER) || slider_per_gap == 0 {
        return;
    }
    for k in 0..8 {
        let a = Pos::from_angular_index(k);
        let b = Pos::from_angular_index(k + 1);
        let (Some(ra), Some(rb)) = (rank_of(a), rank_of(b)) else { continue };
        let fa = a.angle();
        let fb = if k == 7 { 360.0 } else { b.angle() };
        let path = cspace_path(shape, o, hw, hh, fa, fb);
        for (j, c) in sample_path(&path, slider_per_gap, shape, o, hw, hh).into_iter().enumerate() {
            let t = (j + 1) as f64 / (slider_per_gap + 1) as f64;
            let rank = ra + (rb - ra) * t + 0.25;
            let side = if t < 0.5 { a } else { b };
            let c = push_in(shape, o, c, hw, hh);
            out.push(Cand::new(it, vi as u16, v.level, Kind::Slider, Side::Pos(side), rank, Rect::from_center(c, hw, hh)));
        }
    }
}

/// A vertex of the configuration-space boundary: position, angle, and whether the
/// segment to the next vertex is straight (exact) or curved (re-evaluate by angle).
#[derive(Clone, Copy, Debug)]
struct CVertex {
    p: P,
    phi: f64,
    straight_next: bool,
}

const SAMPLE_STEP_DEG: f64 = 3.0;
const EPS_DEG: f64 = 1e-4;

#[inline]
fn c_at(shape: &Shape, o: f64, hw: f64, hh: f64, phi: f64) -> P {
    touch_center(shape, o, dir_of(phi), hw, hh)
}

fn is_axis(phi: f64) -> bool {
    let r = phi.rem_euclid(90.0);
    r < 1e-9 || 90.0 - r < 1e-9
}

/// Boundary of `(S ⊕ o) ⊕ (−B)` between angles `fa` and `fb` (fa < fb, both fixed
/// positions).
fn cspace_path(shape: &Shape, o: f64, hw: f64, hh: f64, fa: f64, fb: f64) -> Vec<CVertex> {
    let mut phis: Vec<f64> = vec![fa];
    if is_axis(fa) {
        phis.push(fa + EPS_DEG);
    }
    let n = ((fb - fa) / SAMPLE_STEP_DEG).ceil().max(1.0) as usize;
    for k in 1..n {
        phis.push(fa + (fb - fa) * k as f64 / n as f64);
    }
    if is_axis(fb) {
        phis.push(fb - EPS_DEG);
    }
    phis.push(fb);
    let mut verts: Vec<CVertex> = Vec::with_capacity(phis.len());
    for &phi in &phis {
        let p = c_at(shape, o, hw, hh, phi);
        if let Some(last) = verts.last() {
            if last.p.dist(p) < 1e-12 {
                continue;
            }
        }
        verts.push(CVertex { p, phi, straight_next: true });
    }
    for i in 0..verts.len().saturating_sub(1) {
        let (a, b) = (verts[i], verts[i + 1]);
        let mid = c_at(shape, o, hw, hh, (a.phi + b.phi) * 0.5);
        verts[i].straight_next = dist_point_seg(mid, a.p, b.p) <= 1e-9;
    }
    verts
}

/// `k` samples at equal arc length, excluding the endpoints.
fn sample_path(path: &[CVertex], k: usize, shape: &Shape, o: f64, hw: f64, hh: f64) -> Vec<P> {
    if path.len() < 2 {
        return vec![];
    }
    let mut cum = vec![0.0; path.len()];
    for i in 1..path.len() {
        cum[i] = cum[i - 1] + path[i - 1].p.dist(path[i].p);
    }
    let total = cum[path.len() - 1];
    if total <= 1e-9 {
        return vec![];
    }
    let mut out = Vec::with_capacity(k);
    let mut seg = 0;
    for j in 1..=k {
        let target = total * j as f64 / (k + 1) as f64;
        while seg + 1 < path.len() - 1 && cum[seg + 1] < target {
            seg += 1;
        }
        let a = path[seg];
        let b = path[seg + 1];
        let len = cum[seg + 1] - cum[seg];
        let t = if len > 0.0 { (target - cum[seg]) / len } else { 0.0 };
        if a.straight_next {
            out.push(a.p.lerp(b.p, t));
        } else {
            out.push(c_at(shape, o, hw, hh, a.phi + (b.phi - a.phi) * t));
        }
    }
    out
}

/// Whether internal candidates apply to this item, and their rank.
pub fn internal_rank(item: &Item, v: &Variant, models: Models, circle_ratio: f64) -> Option<f64> {
    let prefer = Some(-1.0);
    let allow = Some(8.0);
    match item.internal {
        InternalPolicy::Never => None,
        InternalPolicy::Prefer => prefer,
        InternalPolicy::Allow => allow,
        InternalPolicy::Auto => {
            if item.area.is_some() {
                return prefer;
            }
            if item.tip {
                return None;
            }
            match &item.shape {
                Shape::Circle { r, .. } => {
                    if *r >= circle_ratio * v.h || models.has(Models::INTERNAL) {
                        allow
                    } else {
                        None
                    }
                }
                _ => prefer,
            }
        }
    }
}

/// Internal candidates of one variant (spec §6.3, §6.5).
pub fn internal(item: &Item, vi: usize, v: &Variant, rank: f64, out: &mut Vec<Cand>) {
    let hw = v.w * 0.5;
    let hh = v.h * 0.5;
    let pad = item.len.inner_padding;
    let it = item.index as u32;
    let push = |c: P, out: &mut Vec<Cand>| {
        let r = Rect::from_center(c, hw, hh);
        let dup = out.iter().any(|x| x.item == it && x.variant == vi as u16 && x.kind == Kind::Internal && x.rect == r);
        if !dup {
            out.push(Cand::new(it, vi as u16, v.level, Kind::Internal, Side::Internal, rank, r));
        }
    };
    if let Some(area) = &item.area {
        let shape = &area.shape;
        let mut pts: Vec<(f64, P)> = Vec::new();
        if shape.contains_rect(&Rect::from_center(area.pole, hw, hh), pad) {
            pts.push((area.pole_dist, area.pole));
        }
        // grid samples where the label fits, by clearance
        let bb = shape.bbox();
        let step = maxf(v.h, 4.0);
        let mut y = bb.y0 + hh;
        while y <= bb.y1 - hh + 1e-9 {
            let mut x = bb.x0 + hw;
            while x <= bb.x1 - hw + 1e-9 {
                let c = P::new(x, y);
                if shape.contains_rect(&Rect::from_center(c, hw, hh), pad) {
                    pts.push((-shape.signed_distance(c), c));
                }
                x += step;
            }
            y += step;
        }
        pts.sort_by(|a, b| crate::math::cmp_f64(b.0, a.0));
        for (_, c) in pts.into_iter().take(8) {
            push(c, out);
        }
        return;
    }
    let shape = &item.shape;
    let mut centers = vec![shape.reference()];
    match shape {
        Shape::Polygon(p) => {
            let (pole, _) = polygon::polylabel(&p.rings, p.even_odd, 0.5);
            centers.insert(0, pole);
        }
        _ => centers.insert(0, shape.bbox().center()),
    }
    for c in centers {
        if shape.contains_rect(&Rect::from_center(c, hw, hh), pad) {
            push(c, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::shape::Shape;

    fn gap_to(shape: &Shape, r: &Rect, o: f64) -> f64 {
        shape.dist_rect(r) - o
    }

    #[test]
    fn adjacent_touch_circle_tangent() {
        let s = Shape::circle(P::new(100.0, 100.0), 10.0);
        let o = 2.0;
        for k in 0..8 {
            let p = Pos::from_angular_index(k);
            let c = touch_center(&s, o, dir_of(p.angle()), 20.0, 8.0);
            let r = Rect::from_center(c, 20.0, 8.0);
            let g = gap_to(&s, &r, o);
            assert!(g.abs() < 1e-9, "{p:?}: gap {g}");
        }
    }

    #[test]
    fn adjacent_rect_matches_bbox_positions() {
        let s = Shape::rect(P::new(0.0, 0.0), 40.0, 20.0, 0.0, 0.0);
        let c = touch_center(&s, 0.0, dir_of(45.0), 10.0, 5.0);
        assert!((c.x - 30.0).abs() < 1e-12 && (c.y + 15.0).abs() < 1e-12, "{c:?}");
        let c = touch_center(&s, 0.0, dir_of(90.0), 10.0, 5.0);
        assert!(c.x.abs() < 1e-12 && (c.y + 15.0).abs() < 1e-12, "{c:?}");
    }

    #[test]
    fn slider_samples_touch_the_shape() {
        for shape in [
            Shape::circle(P::new(0.0, 0.0), 12.0),
            Shape::ellipse(P::new(0.0, 0.0), 20.0, 8.0, 25.0),
            Shape::rect(P::new(0.0, 0.0), 30.0, 12.0, 3.0, 17.0),
            Shape::polygon(
                vec![vec![P::new(-20.0, -10.0), P::new(20.0, -15.0), P::new(5.0, 0.0), P::new(25.0, 12.0), P::new(-15.0, 10.0)]],
                false,
                P::new(0.0, 0.0),
            ),
        ] {
            for k in 0..8 {
                let fa = 45.0 * k as f64;
                let path = cspace_path(&shape, 2.0, 15.0, 6.0, fa, fa + 45.0);
                for c in sample_path(&path, 6, &shape, 2.0, 15.0, 6.0) {
                    let c = push_in(&shape, 2.0, c, 15.0, 6.0);
                    let r = Rect::from_center(c, 15.0, 6.0);
                    let g = shape.dist_rect(&r) - 2.0;
                    // touches the inflated shape (hull for concave) within tolerance
                    assert!(g > -1e-6 && g < 0.5, "{shape:?} k={k}: gap {g}");
                }
            }
        }
    }
}
