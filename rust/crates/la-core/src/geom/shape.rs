//! The shape kernel (spec §3.3): item marks and positioned obstacle shapes.
//!
//! Every shape has a reference point, a bounding box, an exact support function (used for
//! shape-aware adjacent and slider candidates, ADR placement/positions), containment, signed
//! distance, exact rectangle and segment tests, and an outline polygon (exact for polygons and
//! sharp rectangles, a circumscribed approximation for curved shapes) used for rasterization and
//! distances.

use super::polygon;
use super::{bbox_of, dist_point_seg, Rect, EPS, P};
use crate::math::{clampf, len2d, maxf, minf, sin_cos_deg};

/// Number of outline vertices for curved shapes (per full turn).
const CURVE_SEGMENTS: usize = 64;

#[derive(Clone, Debug)]
pub enum Shape {
    /// Disc. `r = 0` is a bare point.
    Circle { c: P, r: f64 },
    /// Ellipse with semi-axes `rx`, `ry`, rotated by (cos, sin) clockwise on screen.
    Ellipse {
        c: P,
        rx: f64,
        ry: f64,
        cos: f64,
        sin: f64,
    },
    /// Rectangle with half sizes and corner radius, rotated about its center.
    RoundRect {
        c: P,
        hw: f64,
        hh: f64,
        r: f64,
        cos: f64,
        sin: f64,
    },
    /// Polygon (possibly concave, with holes) with an explicit reference point.
    Polygon(Box<PolyShape>),
}

#[derive(Clone, Debug)]
pub struct PolyShape {
    pub rings: Vec<Vec<P>>,
    pub even_odd: bool,
    /// Convex hull, counter-clockwise in math orientation.
    pub hull: Vec<P>,
    pub bbox: Rect,
    pub reference: P,
}

impl PolyShape {
    pub fn new(rings: Vec<Vec<P>>, even_odd: bool, reference: P) -> PolyShape {
        let all: Vec<P> = rings.iter().flatten().copied().collect();
        let hull = polygon::convex_hull(&all);
        let bbox = bbox_of(&all);
        PolyShape {
            rings,
            even_odd,
            hull,
            bbox,
            reference,
        }
    }
}

/// Unit-ish direction helpers for the 8 fixed positions (screen coordinates, y down).
pub fn sign_dir(d: P) -> (f64, f64) {
    (
        crate::math::sign_eps(d.x, 1e-12),
        crate::math::sign_eps(d.y, 1e-12),
    )
}

impl Shape {
    /// Circle helper.
    pub fn circle(c: P, r: f64) -> Shape {
        Shape::Circle { c, r: maxf(r, 0.0) }
    }

    /// Ellipse with rotation in degrees (clockwise on screen).
    pub fn ellipse(c: P, rx: f64, ry: f64, rotation_deg: f64) -> Shape {
        let (sin, cos) = sin_cos_deg(rotation_deg);
        if (rx - ry).abs() <= 0.0 {
            return Shape::Circle { c, r: rx };
        }
        Shape::Ellipse {
            c,
            rx: maxf(rx, 0.0),
            ry: maxf(ry, 0.0),
            cos,
            sin,
        }
    }

    /// Rectangle centered at `c` with optional corner radius and rotation (degrees).
    pub fn rect(c: P, w: f64, h: f64, corner_radius: f64, rotation_deg: f64) -> Shape {
        let hw = maxf(w, 0.0) * 0.5;
        let hh = maxf(h, 0.0) * 0.5;
        let r = clampf(corner_radius, 0.0, minf(hw, hh));
        let (sin, cos) = sin_cos_deg(rotation_deg);
        Shape::RoundRect {
            c,
            hw,
            hh,
            r,
            cos,
            sin,
        }
    }

    pub fn polygon(rings: Vec<Vec<P>>, even_odd: bool, reference: P) -> Shape {
        Shape::Polygon(Box::new(PolyShape::new(rings, even_odd, reference)))
    }

    /// The reference point (anchor).
    pub fn reference(&self) -> P {
        match self {
            Shape::Circle { c, .. } | Shape::Ellipse { c, .. } | Shape::RoundRect { c, .. } => *c,
            Shape::Polygon(p) => p.reference,
        }
    }

    /// Axis-aligned bounding box.
    pub fn bbox(&self) -> Rect {
        match self {
            Shape::Circle { c, r } => Rect::from_center(*c, *r, *r),
            Shape::Ellipse {
                c,
                rx,
                ry,
                cos,
                sin,
            } => {
                // half extents of a rotated ellipse
                let hx = len2d(rx * cos, ry * sin);
                let hy = len2d(rx * sin, ry * cos);
                Rect::from_center(*c, hx, hy)
            }
            Shape::RoundRect {
                c,
                hw,
                hh,
                cos,
                sin,
                ..
            } => {
                let hx = (hw * cos).abs() + (hh * sin).abs();
                let hy = (hw * sin).abs() + (hh * cos).abs();
                Rect::from_center(*c, hx, hy)
            }
            Shape::Polygon(p) => p.bbox,
        }
    }

    /// A rectangle containing every point that `contains` accepts: the bounding box,
    /// except for degenerate ellipses, which `signed_distance` treats as discs.
    pub fn contains_bound(&self) -> Rect {
        match self {
            Shape::Ellipse { c, rx, ry, .. } if *rx <= 0.0 || *ry <= 0.0 => {
                let m = maxf(*rx, *ry);
                Rect::from_center(*c, m, m)
            }
            _ => self.bbox(),
        }
    }

    /// Area of the shape.
    pub fn area(&self) -> f64 {
        match self {
            Shape::Circle { r, .. } => std::f64::consts::PI * r * r,
            Shape::Ellipse { rx, ry, .. } => std::f64::consts::PI * rx * ry,
            Shape::RoundRect { hw, hh, r, .. } => {
                4.0 * hw * hh - (4.0 - std::f64::consts::PI) * r * r
            }
            Shape::Polygon(p) => polygon::area(&p.rings, p.even_odd),
        }
    }

    /// Whether the shape is a (possibly degenerate) disc.
    pub fn is_circle(&self) -> bool {
        matches!(self, Shape::Circle { .. })
    }

    /// Support point: the point of the shape that is extreme in direction `d`.
    /// For flat sides perpendicular to `d` the point closest to the projection of the
    /// reference point is returned (so labels center on flat sides).
    pub fn support(&self, d: P) -> P {
        let dn = d.norm();
        match self {
            Shape::Circle { c, r } => *c + dn * *r,
            Shape::Ellipse {
                c,
                rx,
                ry,
                cos,
                sin,
            } => {
                let l = dn.unrotate(*cos, *sin);
                let ax = rx * rx * l.x;
                let ay = ry * ry * l.y;
                let den = len2d(rx * l.x, ry * l.y);
                if den <= 0.0 {
                    return *c;
                }
                *c + P::new(ax / den, ay / den).rotate(*cos, *sin)
            }
            Shape::RoundRect {
                c,
                hw,
                hh,
                r,
                cos,
                sin,
            } => {
                let l = dn.unrotate(*cos, *sin);
                let iw = hw - r;
                let ih = hh - r;
                let (sx, sy) = (
                    crate::math::sign_eps(l.x, 1e-9),
                    crate::math::sign_eps(l.y, 1e-9),
                );
                let q = P::new(sx * iw, sy * ih) + l * *r;
                *c + q.rotate(*cos, *sin)
            }
            Shape::Polygon(p) => support_hull(&p.hull, p.reference, dn),
        }
    }

    /// Support point of the shape inflated by `o` (Minkowski sum with a disc).
    #[inline]
    pub fn support_inflated(&self, d: P, o: f64) -> P {
        self.support(d) + d.norm() * o
    }

    /// Point containment (closed shape).
    pub fn contains(&self, p: P) -> bool {
        self.signed_distance(p) <= 0.0
    }

    /// Signed distance from `p` to the boundary (negative inside).
    pub fn signed_distance(&self, p: P) -> f64 {
        match self {
            Shape::Circle { c, r } => p.dist(*c) - r,
            Shape::Ellipse {
                c,
                rx,
                ry,
                cos,
                sin,
            } => {
                let l = (p - *c).unrotate(*cos, *sin);
                ellipse_signed_distance(l, *rx, *ry)
            }
            Shape::RoundRect {
                c,
                hw,
                hh,
                r,
                cos,
                sin,
            } => {
                let l = (p - *c).unrotate(*cos, *sin);
                let qx = l.x.abs() - (hw - r);
                let qy = l.y.abs() - (hh - r);
                let outside = len2d(maxf(qx, 0.0), maxf(qy, 0.0));
                outside + minf(maxf(qx, qy), 0.0) - r
            }
            Shape::Polygon(ps) => {
                let d = polygon::dist_boundary(&ps.rings, p);
                if polygon::contains(&ps.rings, ps.even_odd, p) {
                    -d
                } else {
                    d
                }
            }
        }
    }

    /// The open rectangle `r` overlaps the shape's interior by more than `EPS`.
    pub fn overlaps_rect(&self, r: &Rect) -> bool {
        match self {
            Shape::Circle { c, r: rad } => {
                if *rad <= EPS {
                    // a bare point overlaps only if strictly inside
                    return r.inflate(-EPS).contains_point(*c);
                }
                r.dist_point(*c) < rad - EPS
            }
            Shape::Ellipse {
                c,
                rx,
                ry,
                cos,
                sin,
            } => {
                if !self.bbox().overlaps(r) {
                    return false;
                }
                // map to the unit circle: the rectangle becomes a parallelogram
                let corners = r.corners();
                let mut quad = [P::new(0.0, 0.0); 4];
                for (i, k) in corners.iter().enumerate() {
                    let l = (*k - *c).unrotate(*cos, *sin);
                    quad[i] = P::new(l.x / rx, l.y / ry);
                }
                convex_quad_overlaps_unit_disc(&quad, EPS / maxf(minf(*rx, *ry), EPS))
            }
            Shape::RoundRect {
                c,
                hw,
                hh,
                r: rad,
                cos,
                sin,
            } => {
                if !self.bbox().overlaps(r) {
                    return false;
                }
                // distance between the inner (sharp) rect and `r` < rad
                let inner = rotated_rect_corners(*c, hw - rad, hh - rad, *cos, *sin);
                if *rad <= 0.0 {
                    return convex_polygons_overlap(&inner, &r.corners(), EPS);
                }
                convex_poly_rect_distance(&inner, r) < rad - EPS
            }
            Shape::Polygon(p) => polygon::overlaps_rect(&p.rings, p.even_odd, &p.bbox, r),
        }
    }

    /// Distance between the shape and rectangle `r` (0 when they touch or overlap).
    pub fn dist_rect(&self, r: &Rect) -> f64 {
        match self {
            Shape::Circle { c, r: rad } => maxf(r.dist_point(*c) - rad, 0.0),
            Shape::Polygon(p) => polygon::dist_rect(&p.rings, p.even_odd, &p.bbox, r),
            Shape::RoundRect {
                c,
                hw,
                hh,
                r: rad,
                cos,
                sin,
            } => {
                let inner = rotated_rect_corners(*c, hw - rad, hh - rad, *cos, *sin);
                maxf(convex_poly_rect_distance(&inner, r) - rad, 0.0)
            }
            Shape::Ellipse { .. } => {
                if self.overlaps_rect(r) {
                    return 0.0;
                }
                // The signed distance to a convex set is convex along a segment, so a
                // ternary search per rectangle edge finds the exact minimum.
                let k = r.corners();
                let mut m = f64::INFINITY;
                for i in 0..4 {
                    m = minf(m, min_dist_on_segment(self, k[i], k[(i + 1) % 4]));
                }
                maxf(m, 0.0)
            }
        }
    }

    /// Segment `ab` passes within `clearance` of the shape (interior when 0).
    pub fn near_segment(&self, a: P, b: P, clearance: f64) -> bool {
        self.dist_segment(a, b) < clearance - EPS
            || (clearance <= 0.0 && self.dist_segment(a, b) < -EPS)
    }

    /// Signed-ish distance between segment `ab` and the shape: 0 if they intersect,
    /// otherwise the gap.
    pub fn dist_segment(&self, a: P, b: P) -> f64 {
        match self {
            Shape::Circle { c, r } => maxf(dist_point_seg(*c, a, b) - r, 0.0),
            _ => {
                if self.contains(a) || self.contains(b) {
                    return 0.0;
                }
                let outline = self.outline_rings();
                let mut m = f64::INFINITY;
                for ring in &outline {
                    let n = ring.len();
                    for i in 0..n {
                        m = minf(m, super::seg_seg_dist(a, b, ring[i], ring[(i + 1) % n]));
                    }
                }
                m
            }
        }
    }

    /// Length of the part of segment `ab` inside the shape (approximate for curved shapes:
    /// sampled at `step` px).
    pub fn covered_len(&self, a: P, b: P, step: f64) -> f64 {
        let len = a.dist(b);
        if len <= 0.0 {
            return 0.0;
        }
        let n = maxf((len / maxf(step, 0.25)).ceil(), 1.0) as usize;
        let mut inside = 0usize;
        // only the samples that can fall inside the shape (the margin absorbs rounding)
        let bound = self.contains_bound().inflate(1.0);
        let (k0, k1) = super::sample_range_in_rect(a, b, n, &bound);
        for k in k0..k1 {
            let t = (k as f64 + 0.5) / n as f64;
            if self.contains(a.lerp(b, t)) {
                inside += 1;
            }
        }
        len * inside as f64 / n as f64
    }

    /// First boundary point along the ray from the reference point in direction `dir`.
    pub fn boundary_point(&self, dir: P) -> P {
        let d = dir.norm();
        let o = self.reference();
        match self {
            Shape::Circle { c, r } => *c + d * *r,
            Shape::Ellipse {
                c,
                rx,
                ry,
                cos,
                sin,
            } => {
                let l = d.unrotate(*cos, *sin);
                let den = (l.x * l.x) / (rx * rx) + (l.y * l.y) / (ry * ry);
                if den <= 0.0 {
                    return *c;
                }
                *c + d * (1.0 / den.sqrt())
            }
            _ => {
                // bisection on the signed distance along the ray (the reference point may
                // be outside concave shapes; then the first exit is searched from there)
                let bb = self.bbox();
                let far = len2d(bb.w(), bb.h()) + o.dist(bb.center()) + 1.0;
                let mut lo = 0.0;
                let mut hi = far;
                if !self.contains(o) {
                    return o;
                }
                for _ in 0..48 {
                    let mid = (lo + hi) * 0.5;
                    if self.contains(o + d * mid) {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }
                o + d * lo
            }
        }
    }

    /// Outline as rings: exact for polygons and sharp rectangles; curved shapes are
    /// approximated by a circumscribed polygon (so the outline contains the shape).
    pub fn outline_rings(&self) -> Vec<Vec<P>> {
        match self {
            Shape::Polygon(p) => p.rings.clone(),
            _ => vec![self.outline()],
        }
    }

    /// Outline of convex shapes (for polygons: the convex hull).
    pub fn outline(&self) -> Vec<P> {
        match self {
            Shape::Circle { c, r } => {
                if *r <= 0.0 {
                    return vec![*c];
                }
                let k = 1.0 / cos_half_step(CURVE_SEGMENTS);
                (0..CURVE_SEGMENTS)
                    .map(|i| {
                        let (s, co) = sin_cos_deg(360.0 * i as f64 / CURVE_SEGMENTS as f64);
                        *c + P::new(co * r * k, s * r * k)
                    })
                    .collect()
            }
            Shape::Ellipse {
                c,
                rx,
                ry,
                cos,
                sin,
            } => {
                let k = 1.0 / cos_half_step(CURVE_SEGMENTS);
                (0..CURVE_SEGMENTS)
                    .map(|i| {
                        let (s, co) = sin_cos_deg(360.0 * i as f64 / CURVE_SEGMENTS as f64);
                        *c + P::new(co * rx * k, s * ry * k).rotate(*cos, *sin)
                    })
                    .collect()
            }
            Shape::RoundRect {
                c,
                hw,
                hh,
                r,
                cos,
                sin,
            } => {
                if *r <= 0.0 {
                    return rotated_rect_corners(*c, *hw, *hh, *cos, *sin).to_vec();
                }
                let per = CURVE_SEGMENTS / 4;
                let k = 1.0 / cos_half_step(CURVE_SEGMENTS);
                let iw = hw - r;
                let ih = hh - r;
                let mut pts = Vec::with_capacity(4 * (per + 1));
                // corners: (+,+) 0..90, (-,+) 90..180, (-,-) 180..270, (+,-) 270..360
                let centers = [
                    P::new(iw, ih),
                    P::new(-iw, ih),
                    P::new(-iw, -ih),
                    P::new(iw, -ih),
                ];
                for (q, cc) in centers.iter().enumerate() {
                    for j in 0..=per {
                        let a = 90.0 * q as f64 + 90.0 * j as f64 / per as f64;
                        let (s, co) = sin_cos_deg(a);
                        let p = *cc + P::new(co * r * k, s * r * k);
                        pts.push(*c + p.rotate(*cos, *sin));
                    }
                }
                pts
            }
            Shape::Polygon(p) => p.hull.clone(),
        }
    }

    /// Translate the shape.
    pub fn translated(&self, d: P) -> Shape {
        match self {
            Shape::Circle { c, r } => Shape::Circle { c: *c + d, r: *r },
            Shape::Ellipse {
                c,
                rx,
                ry,
                cos,
                sin,
            } => Shape::Ellipse {
                c: *c + d,
                rx: *rx,
                ry: *ry,
                cos: *cos,
                sin: *sin,
            },
            Shape::RoundRect {
                c,
                hw,
                hh,
                r,
                cos,
                sin,
            } => Shape::RoundRect {
                c: *c + d,
                hw: *hw,
                hh: *hh,
                r: *r,
                cos: *cos,
                sin: *sin,
            },
            Shape::Polygon(p) => Shape::polygon(
                p.rings
                    .iter()
                    .map(|r| r.iter().map(|q| *q + d).collect())
                    .collect(),
                p.even_odd,
                p.reference + d,
            ),
        }
    }

    /// The rectangle (with padding `pad`) fits inside the shape.
    pub fn contains_rect(&self, r: &Rect, pad: f64) -> bool {
        match self {
            Shape::Polygon(p) => polygon::contains_rect(&p.rings, p.even_odd, r, pad),
            _ => {
                let rr = r.inflate(pad);
                // convex shapes: all corners inside suffices
                rr.corners().iter().all(|c| self.signed_distance(*c) <= EPS)
            }
        }
    }
}

/// Interiors of two shapes overlap (touching is allowed).
pub fn shapes_overlap(a: &Shape, b: &Shape) -> bool {
    if !a.bbox().overlaps(&b.bbox()) {
        return false;
    }
    match (a, b) {
        (Shape::Circle { c, r }, other) | (other, Shape::Circle { c, r }) => {
            other.signed_distance(*c) < r - EPS
        }
        _ => {
            let ra = a.outline_rings();
            let rb = b.outline_rings();
            for x in &ra {
                for y in &rb {
                    let (n, m) = (x.len(), y.len());
                    for i in 0..n {
                        for j in 0..m {
                            if super::seg_cross_proper(x[i], x[(i + 1) % n], y[j], y[(j + 1) % m]) {
                                return true;
                            }
                        }
                    }
                }
            }
            // no crossing edges: one may contain the other
            let inside = |s: &Shape, rings: &[Vec<P>]| {
                rings.iter().flatten().any(|p| s.signed_distance(*p) < -EPS)
            };
            inside(a, &rb)
                || inside(b, &ra)
                || (a.signed_distance(b.reference()) < -EPS && b.contains(b.reference()))
        }
    }
}

/// Minimum signed distance from the points of segment `ab` to a convex shape.
fn min_dist_on_segment(s: &Shape, a: P, b: P) -> f64 {
    let (mut lo, mut hi) = (0.0f64, 1.0f64);
    for _ in 0..60 {
        let m1 = lo + (hi - lo) / 3.0;
        let m2 = hi - (hi - lo) / 3.0;
        if s.signed_distance(a.lerp(b, m1)) <= s.signed_distance(a.lerp(b, m2)) {
            hi = m2;
        } else {
            lo = m1;
        }
    }
    let t = (lo + hi) * 0.5;
    minf(
        s.signed_distance(a.lerp(b, t)),
        minf(s.signed_distance(a), s.signed_distance(b)),
    )
}

/// 1 / cos(π / n): factor for a circumscribed regular n-gon.
fn cos_half_step(n: usize) -> f64 {
    let (_, c) = sin_cos_deg(180.0 / n as f64);
    c
}

fn rotated_rect_corners(c: P, hw: f64, hh: f64, cos: f64, sin: f64) -> [P; 4] {
    [
        c + P::new(-hw, -hh).rotate(cos, sin),
        c + P::new(hw, -hh).rotate(cos, sin),
        c + P::new(hw, hh).rotate(cos, sin),
        c + P::new(-hw, hh).rotate(cos, sin),
    ]
}

/// Support of a convex hull with flat-side tie-breaking toward the reference point.
fn support_hull(hull: &[P], reference: P, d: P) -> P {
    if hull.is_empty() {
        return reference;
    }
    let mut best = f64::NEG_INFINITY;
    for v in hull {
        let s = v.dot(d);
        if s > best {
            best = s;
        }
    }
    let tol = 1e-9 * maxf(1.0, best.abs());
    // collect the support set (one vertex or an edge)
    let n = hull.len();
    let mut idx: Vec<usize> = (0..n).filter(|&i| hull[i].dot(d) >= best - tol).collect();
    if idx.len() == 1 {
        return hull[idx[0]];
    }
    // flat side: choose the point of the support segment closest to the projection of
    // the reference point
    idx.sort_unstable();
    let mut lo = hull[idx[0]];
    let mut hi = hull[idx[idx.len() - 1]];
    // order the two extreme points along the edge direction perpendicular to d
    let t = d.perp();
    for &i in &idx {
        if hull[i].dot(t) < lo.dot(t) {
            lo = hull[i];
        }
        if hull[i].dot(t) > hi.dot(t) {
            hi = hull[i];
        }
    }
    let rt = clampf(reference.dot(t), lo.dot(t), hi.dot(t));
    let span = hi.dot(t) - lo.dot(t);
    if span <= 0.0 {
        return lo;
    }
    lo.lerp(hi, (rt - lo.dot(t)) / span)
}

/// Signed distance to an axis-aligned ellipse centered at the origin (local frame),
/// using a fixed number of bisection steps on the parametric angle (deterministic).
fn ellipse_signed_distance(p: P, a: f64, b: f64) -> f64 {
    if a <= 0.0 || b <= 0.0 {
        return p.len() - maxf(a, b);
    }
    // Symmetry: work in the first quadrant.
    let px = p.x.abs();
    let py = p.y.abs();
    let inside = (px * px) / (a * a) + (py * py) / (b * b) <= 1.0;
    // Closest point via Eberly's robust bisection on t for (x0, y0) outside or inside.
    let d = ellipse_dist_first_quadrant(a, b, px, py);
    if inside {
        -d
    } else {
        d
    }
}

fn ellipse_dist_first_quadrant(a: f64, b: f64, x: f64, y: f64) -> f64 {
    // Ensure a >= b by swapping axes.
    let (e0, e1, y0, y1) = if a >= b { (a, b, x, y) } else { (b, a, y, x) };
    if y1 > 0.0 {
        if y0 > 0.0 {
            let z0 = y0 / e0;
            let z1 = y1 / e1;
            let g = z0 * z0 + z1 * z1 - 1.0;
            if g != 0.0 {
                let r0 = (e0 / e1) * (e0 / e1);
                let sbar = bisect_root(r0, z0, z1, g);
                let x0 = r0 * y0 / (sbar + r0);
                let x1 = y1 / (sbar + 1.0);
                return len2d(x0 - y0, x1 - y1);
            }
            return 0.0;
        }
        return (y1 - e1).abs();
    }
    let numer0 = e0 * y0;
    let denom0 = e0 * e0 - e1 * e1;
    if numer0 < denom0 {
        let xde0 = numer0 / denom0;
        let x0 = e0 * xde0;
        let x1 = e1 * maxf(1.0 - xde0 * xde0, 0.0).sqrt();
        return len2d(x0 - y0, x1);
    }
    (y0 - e0).abs()
}

fn bisect_root(r0: f64, z0: f64, z1: f64, g: f64) -> f64 {
    let n0 = r0 * z0;
    let mut s0 = z1 - 1.0;
    let mut s1 = if g < 0.0 { 0.0 } else { len2d(n0, z1) - 1.0 };
    let mut s = 0.0;
    for _ in 0..64 {
        s = (s0 + s1) * 0.5;
        if s == s0 || s == s1 {
            break;
        }
        let ratio0 = n0 / (s + r0);
        let ratio1 = z1 / (s + 1.0);
        let gg = ratio0 * ratio0 + ratio1 * ratio1 - 1.0;
        if gg > 0.0 {
            s0 = s;
        } else if gg < 0.0 {
            s1 = s;
        } else {
            break;
        }
    }
    s
}

/// A convex quadrilateral (in unit-disc space) overlaps the open unit disc.
fn convex_quad_overlaps_unit_disc(q: &[P; 4], eps: f64) -> bool {
    // distance from origin to the convex quad < 1 - eps
    let origin = P::new(0.0, 0.0);
    if point_in_convex(q, origin) {
        return true;
    }
    let mut m = f64::INFINITY;
    for i in 0..4 {
        m = minf(m, dist_point_seg(origin, q[i], q[(i + 1) % 4]));
    }
    m < 1.0 - eps
}

fn point_in_convex(poly: &[P], p: P) -> bool {
    let n = poly.len();
    let mut pos = false;
    let mut neg = false;
    for i in 0..n {
        let o = super::orient(poly[i], poly[(i + 1) % n], p);
        if o > 0.0 {
            pos = true;
        } else if o < 0.0 {
            neg = true;
        }
        if pos && neg {
            return false;
        }
    }
    true
}

/// Separating-axis overlap test for two convex polygons (interiors overlap by > eps).
fn convex_polygons_overlap(a: &[P], b: &[P], eps: f64) -> bool {
    for poly in [a, b] {
        let n = poly.len();
        for i in 0..n {
            let e = poly[(i + 1) % n] - poly[i];
            let axis = e.perp().norm();
            if axis.len2() == 0.0 {
                continue;
            }
            let (mut amin, mut amax) = (f64::INFINITY, f64::NEG_INFINITY);
            for p in a {
                let s = p.dot(axis);
                amin = minf(amin, s);
                amax = maxf(amax, s);
            }
            let (mut bmin, mut bmax) = (f64::INFINITY, f64::NEG_INFINITY);
            for p in b {
                let s = p.dot(axis);
                bmin = minf(bmin, s);
                bmax = maxf(bmax, s);
            }
            if amax <= bmin + eps || bmax <= amin + eps {
                return false;
            }
        }
    }
    true
}

/// Distance between a convex polygon and a rectangle (0 if overlapping/touching).
fn convex_poly_rect_distance(poly: &[P], r: &Rect) -> f64 {
    let rc = r.corners();
    if poly.len() >= 3 && convex_polygons_overlap(poly, &rc, 0.0) {
        return 0.0;
    }
    let mut m = f64::INFINITY;
    let n = poly.len();
    if n == 1 {
        return r.dist_point(poly[0]);
    }
    for i in 0..n {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        m = minf(m, super::dist_seg_rect(a, b, r));
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn circle_support_is_tangent() {
        let s = Shape::circle(P::new(10.0, 10.0), 5.0);
        let p = s.support(P::new(1.0, -1.0));
        let h = 5.0 / 2f64.sqrt();
        assert!((p.x - (10.0 + h)).abs() < 1e-12 && (p.y - (10.0 - h)).abs() < 1e-12);
    }

    #[test]
    fn rect_support_corners_and_sides() {
        let s = Shape::rect(P::new(0.0, 0.0), 40.0, 10.0, 0.0, 0.0);
        assert_eq!(s.support(P::new(1.0, -1.0)), P::new(20.0, -5.0));
        assert_eq!(s.support(P::new(0.0, -1.0)), P::new(0.0, -5.0));
        assert_eq!(s.support(P::new(1.0, 0.0)), P::new(20.0, 0.0));
    }

    #[test]
    fn polygon_support_flat_side_centers_on_reference() {
        let sq = vec![
            P::new(0.0, 0.0),
            P::new(10.0, 0.0),
            P::new(10.0, 10.0),
            P::new(0.0, 10.0),
        ];
        let s = Shape::polygon(vec![sq], false, P::new(3.0, 5.0));
        let p = s.support(P::new(0.0, -1.0));
        assert!((p.x - 3.0).abs() < 1e-12 && p.y.abs() < 1e-12);
    }

    #[test]
    fn ellipse_distance_and_containment() {
        let e = Shape::ellipse(P::new(0.0, 0.0), 10.0, 5.0, 0.0);
        assert!((e.signed_distance(P::new(12.0, 0.0)) - 2.0).abs() < 1e-9);
        assert!((e.signed_distance(P::new(0.0, 8.0)) - 3.0).abs() < 1e-9);
        assert!(e.contains(P::new(9.0, 0.0)));
        let r = Shape::ellipse(P::new(0.0, 0.0), 10.0, 5.0, 90.0);
        assert!(r.contains(P::new(0.0, 9.0)));
        assert!(!r.contains(P::new(9.0, 0.0)));
    }

    #[test]
    fn rect_overlap_exact() {
        let c = Shape::circle(P::new(0.0, 0.0), 10.0);
        // touching from the right is not an overlap
        assert!(!c.overlaps_rect(&Rect::xywh(10.0, -5.0, 10.0, 10.0)));
        assert!(c.overlaps_rect(&Rect::xywh(9.0, -5.0, 10.0, 10.0)));
        // near the 45° diagonal, the corner of a rect placed on the tangent point touches
        let t = c.support(P::new(1.0, -1.0));
        let r = Rect::new(t.x, t.y - 10.0, t.x + 30.0, t.y);
        assert!(!c.overlaps_rect(&r));
        let e = Shape::ellipse(P::new(0.0, 0.0), 10.0, 5.0, 30.0);
        let t = e.support(P::new(1.0, -1.0));
        let r = Rect::new(t.x, t.y - 10.0, t.x + 30.0, t.y);
        assert!(!e.overlaps_rect(&r));
        assert!(e.overlaps_rect(&r.translate(P::new(-0.5, 0.5))));
        let rr = Shape::rect(P::new(0.0, 0.0), 20.0, 10.0, 3.0, 20.0);
        let t = rr.support(P::new(-1.0, 1.0));
        let r = Rect::new(t.x - 30.0, t.y, t.x, t.y + 10.0);
        assert!(!rr.overlaps_rect(&r));
        assert!(rr.overlaps_rect(&r.translate(P::new(0.3, -0.3))));
    }

    #[test]
    fn shape_shape_overlap() {
        let a = Shape::circle(P::new(0.0, 0.0), 5.0);
        let b = Shape::circle(P::new(10.0, 0.0), 5.0);
        assert!(!shapes_overlap(&a, &b));
        let c = Shape::circle(P::new(9.0, 0.0), 5.0);
        assert!(shapes_overlap(&a, &c));
        let r = Shape::rect(P::new(0.0, 12.0), 20.0, 4.0, 0.0, 0.0);
        assert!(!shapes_overlap(&a, &r));
        let big = Shape::rect(P::new(0.0, 0.0), 100.0, 100.0, 5.0, 0.0);
        let small = Shape::rect(P::new(1.0, 1.0), 2.0, 2.0, 0.0, 30.0);
        assert!(shapes_overlap(&big, &small));
        let tri = Shape::polygon(
            vec![vec![
                P::new(20.0, 20.0),
                P::new(30.0, 20.0),
                P::new(25.0, 28.0),
            ]],
            false,
            P::new(25.0, 22.0),
        );
        assert!(!shapes_overlap(&small, &tri));
    }

    #[test]
    fn boundary_points() {
        let s = Shape::rect(P::new(0.0, 0.0), 20.0, 10.0, 0.0, 0.0);
        let b = s.boundary_point(P::new(1.0, 0.0));
        assert!((b.x - 10.0).abs() < 1e-9 && b.y.abs() < 1e-9);
        let e = Shape::ellipse(P::new(0.0, 0.0), 10.0, 5.0, 0.0);
        let b = e.boundary_point(P::new(0.0, 1.0));
        assert!((b.y - 5.0).abs() < 1e-12);
    }

    #[test]
    fn outline_contains_shape() {
        let c = Shape::circle(P::new(0.0, 0.0), 10.0);
        let o = c.outline();
        for p in &o {
            assert!(p.len() >= 10.0 - 1e-9);
        }
    }
}
