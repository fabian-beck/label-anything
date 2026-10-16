//! Geometry primitives: points, rectangles, segments, affine maps.
//!
//! Conventions: canvas pixels, y down. Rectangles are stored as min/max corners.
//! "Overlap" always means overlap of interiors by more than [`EPS`]; touching is allowed.

pub mod path;
pub mod polygon;
pub mod shape;

use crate::math::{len2d, maxf, minf};
use std::ops::{Add, Mul, Neg, Sub};

/// Geometric tolerance in pixels. Touching within this distance is not an overlap.
pub const EPS: f64 = 1e-6;

/// A point or vector in canvas pixels.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct P {
    pub x: f64,
    pub y: f64,
}

impl P {
    #[inline]
    pub const fn new(x: f64, y: f64) -> P {
        P { x, y }
    }
    #[inline]
    pub fn dot(self, o: P) -> f64 {
        self.x * o.x + self.y * o.y
    }
    #[inline]
    pub fn cross(self, o: P) -> f64 {
        self.x * o.y - self.y * o.x
    }
    #[inline]
    pub fn len(self) -> f64 {
        len2d(self.x, self.y)
    }
    #[inline]
    pub fn len2(self) -> f64 {
        self.x * self.x + self.y * self.y
    }
    /// Unit vector (zero vector stays zero).
    #[inline]
    pub fn norm(self) -> P {
        let l = self.len();
        if l > 0.0 {
            P::new(self.x / l, self.y / l)
        } else {
            P::new(0.0, 0.0)
        }
    }
    /// Perpendicular (rotated +90° in math orientation; on screen with y down this is clockwise).
    #[inline]
    pub fn perp(self) -> P {
        P::new(-self.y, self.x)
    }
    #[inline]
    pub fn dist(self, o: P) -> f64 {
        len2d(self.x - o.x, self.y - o.y)
    }
    #[inline]
    pub fn lerp(self, o: P, t: f64) -> P {
        P::new(self.x + (o.x - self.x) * t, self.y + (o.y - self.y) * t)
    }
    /// Rotate by (cos, sin), clockwise on screen for positive angles (SVG convention).
    #[inline]
    pub fn rotate(self, cos: f64, sin: f64) -> P {
        P::new(self.x * cos - self.y * sin, self.x * sin + self.y * cos)
    }
    /// Inverse rotation of [`P::rotate`].
    #[inline]
    pub fn unrotate(self, cos: f64, sin: f64) -> P {
        P::new(self.x * cos + self.y * sin, -self.x * sin + self.y * cos)
    }
    #[inline]
    pub fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }
}

impl Add for P {
    type Output = P;
    #[inline]
    fn add(self, o: P) -> P {
        P::new(self.x + o.x, self.y + o.y)
    }
}
impl Sub for P {
    type Output = P;
    #[inline]
    fn sub(self, o: P) -> P {
        P::new(self.x - o.x, self.y - o.y)
    }
}
impl Mul<f64> for P {
    type Output = P;
    #[inline]
    fn mul(self, s: f64) -> P {
        P::new(self.x * s, self.y * s)
    }
}
impl Neg for P {
    type Output = P;
    #[inline]
    fn neg(self) -> P {
        P::new(-self.x, -self.y)
    }
}

/// Axis-aligned rectangle `[x0, x1] × [y0, y1]`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

impl Rect {
    #[inline]
    pub const fn new(x0: f64, y0: f64, x1: f64, y1: f64) -> Rect {
        Rect { x0, y0, x1, y1 }
    }
    #[inline]
    pub fn xywh(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect::new(x, y, x + w, y + h)
    }
    #[inline]
    pub fn from_center(c: P, hw: f64, hh: f64) -> Rect {
        Rect::new(c.x - hw, c.y - hh, c.x + hw, c.y + hh)
    }
    /// An "empty" rectangle for unions.
    pub const EMPTY: Rect = Rect {
        x0: f64::INFINITY,
        y0: f64::INFINITY,
        x1: f64::NEG_INFINITY,
        y1: f64::NEG_INFINITY,
    };
    #[inline]
    pub fn w(&self) -> f64 {
        self.x1 - self.x0
    }
    #[inline]
    pub fn h(&self) -> f64 {
        self.y1 - self.y0
    }
    #[inline]
    pub fn area(&self) -> f64 {
        maxf(self.w(), 0.0) * maxf(self.h(), 0.0)
    }
    #[inline]
    pub fn center(&self) -> P {
        P::new((self.x0 + self.x1) * 0.5, (self.y0 + self.y1) * 0.5)
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        !(self.x1 >= self.x0 && self.y1 >= self.y0)
    }
    #[inline]
    pub fn inflate(&self, d: f64) -> Rect {
        Rect::new(self.x0 - d, self.y0 - d, self.x1 + d, self.y1 + d)
    }
    #[inline]
    pub fn translate(&self, d: P) -> Rect {
        Rect::new(self.x0 + d.x, self.y0 + d.y, self.x1 + d.x, self.y1 + d.y)
    }
    #[inline]
    pub fn union(&self, o: &Rect) -> Rect {
        Rect::new(
            minf(self.x0, o.x0),
            minf(self.y0, o.y0),
            maxf(self.x1, o.x1),
            maxf(self.y1, o.y1),
        )
    }
    #[inline]
    pub fn add_point(&self, p: P) -> Rect {
        Rect::new(
            minf(self.x0, p.x),
            minf(self.y0, p.y),
            maxf(self.x1, p.x),
            maxf(self.y1, p.y),
        )
    }
    /// Interiors overlap by more than `EPS` in both axes.
    #[inline]
    pub fn overlaps(&self, o: &Rect) -> bool {
        self.x0 < o.x1 - EPS && o.x0 < self.x1 - EPS && self.y0 < o.y1 - EPS && o.y0 < self.y1 - EPS
    }
    /// Closed rectangles intersect (touching counts).
    #[inline]
    pub fn touches(&self, o: &Rect) -> bool {
        self.x0 <= o.x1 && o.x0 <= self.x1 && self.y0 <= o.y1 && o.y0 <= self.y1
    }
    #[inline]
    pub fn intersection(&self, o: &Rect) -> Rect {
        Rect::new(
            maxf(self.x0, o.x0),
            maxf(self.y0, o.y0),
            minf(self.x1, o.x1),
            minf(self.y1, o.y1),
        )
    }
    #[inline]
    pub fn overlap_area(&self, o: &Rect) -> f64 {
        let w = minf(self.x1, o.x1) - maxf(self.x0, o.x0);
        let h = minf(self.y1, o.y1) - maxf(self.y0, o.y0);
        if w > 0.0 && h > 0.0 {
            w * h
        } else {
            0.0
        }
    }
    #[inline]
    pub fn contains_point(&self, p: P) -> bool {
        p.x >= self.x0 && p.x <= self.x1 && p.y >= self.y0 && p.y <= self.y1
    }
    /// `o` lies inside `self` (with tolerance `EPS`).
    #[inline]
    pub fn contains_rect(&self, o: &Rect) -> bool {
        o.x0 >= self.x0 - EPS
            && o.x1 <= self.x1 + EPS
            && o.y0 >= self.y0 - EPS
            && o.y1 <= self.y1 + EPS
    }
    /// Distance from a point to the rectangle (0 inside).
    #[inline]
    pub fn dist_point(&self, p: P) -> f64 {
        let dx = maxf(maxf(self.x0 - p.x, 0.0), p.x - self.x1);
        let dy = maxf(maxf(self.y0 - p.y, 0.0), p.y - self.y1);
        len2d(dx, dy)
    }
    /// Closest point of the (closed) rectangle to `p`.
    #[inline]
    pub fn closest_point(&self, p: P) -> P {
        P::new(
            crate::math::clampf(p.x, self.x0, self.x1),
            crate::math::clampf(p.y, self.y0, self.y1),
        )
    }
    /// Gap between two rectangles (0 if they touch or overlap).
    #[inline]
    pub fn dist_rect(&self, o: &Rect) -> f64 {
        let dx = maxf(maxf(o.x0 - self.x1, self.x0 - o.x1), 0.0);
        let dy = maxf(maxf(o.y0 - self.y1, self.y0 - o.y1), 0.0);
        len2d(dx, dy)
    }
    /// Corners in order top-left, top-right, bottom-right, bottom-left.
    pub fn corners(&self) -> [P; 4] {
        [
            P::new(self.x0, self.y0),
            P::new(self.x1, self.y0),
            P::new(self.x1, self.y1),
            P::new(self.x0, self.y1),
        ]
    }
}

/// Affine map `[a, b, c, d, e, f]`: `x' = a·x + c·y + e`, `y' = b·x + d·y + f`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Affine(pub [f64; 6]);

impl Affine {
    pub const IDENTITY: Affine = Affine([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    #[inline]
    pub fn apply(&self, p: P) -> P {
        let m = &self.0;
        P::new(
            m[0] * p.x + m[2] * p.y + m[4],
            m[1] * p.x + m[3] * p.y + m[5],
        )
    }
    /// `self ∘ other` (apply `other` first).
    pub fn then(&self, after: &Affine) -> Affine {
        let a = &self.0;
        let b = &after.0;
        Affine([
            b[0] * a[0] + b[2] * a[1],
            b[1] * a[0] + b[3] * a[1],
            b[0] * a[2] + b[2] * a[3],
            b[1] * a[2] + b[3] * a[3],
            b[0] * a[4] + b[2] * a[5] + b[4],
            b[1] * a[4] + b[3] * a[5] + b[5],
        ])
    }
    pub fn is_identity(&self) -> bool {
        *self == Affine::IDENTITY
    }
}

// ---------------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------------

/// Orientation of the triangle (a, b, c): > 0 counter-clockwise in math orientation.
#[inline]
pub fn orient(a: P, b: P, c: P) -> f64 {
    (b - a).cross(c - a)
}

/// Distance from point `p` to segment `ab`.
pub fn dist_point_seg(p: P, a: P, b: P) -> f64 {
    let ab = b - a;
    let l2 = ab.len2();
    if l2 <= 0.0 {
        return p.dist(a);
    }
    let t = crate::math::clampf((p - a).dot(ab) / l2, 0.0, 1.0);
    p.dist(a + ab * t)
}

/// Closest point on segment `ab` to `p`.
pub fn closest_on_seg(p: P, a: P, b: P) -> P {
    let ab = b - a;
    let l2 = ab.len2();
    if l2 <= 0.0 {
        return a;
    }
    let t = crate::math::clampf((p - a).dot(ab) / l2, 0.0, 1.0);
    a + ab * t
}

/// Segments `ab` and `cd` intersect (including touching), with tolerance `EPS`.
pub fn seg_intersects(a: P, b: P, c: P, d: P) -> bool {
    seg_seg_dist(a, b, c, d) <= EPS
}

/// Segments cross properly: they intersect in a point that is interior to both.
pub fn seg_cross_proper(a: P, b: P, c: P, d: P) -> bool {
    let d1 = orient(c, d, a);
    let d2 = orient(c, d, b);
    let d3 = orient(a, b, c);
    let d4 = orient(a, b, d);
    ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0))
        && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0))
}

/// Minimum distance between segments `ab` and `cd` (0 if they intersect).
pub fn seg_seg_dist(a: P, b: P, c: P, d: P) -> f64 {
    if seg_cross_proper(a, b, c, d) {
        return 0.0;
    }
    let mut m = dist_point_seg(a, c, d);
    m = minf(m, dist_point_seg(b, c, d));
    m = minf(m, dist_point_seg(c, a, b));
    minf(m, dist_point_seg(d, a, b))
}

/// Length of the part of segment `ab` inside the closed rectangle `r` (Liang–Barsky).
pub fn seg_len_in_rect(a: P, b: P, r: &Rect) -> f64 {
    match clip_seg_rect(a, b, r) {
        Some((t0, t1)) => (t1 - t0) * a.dist(b),
        None => 0.0,
    }
}

/// Liang–Barsky clipping: the parameter interval of `ab` inside `r`.
pub fn clip_seg_rect(a: P, b: P, r: &Rect) -> Option<(f64, f64)> {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let mut t0 = 0.0f64;
    let mut t1 = 1.0f64;
    let checks = [
        (-dx, a.x - r.x0),
        (dx, r.x1 - a.x),
        (-dy, a.y - r.y0),
        (dy, r.y1 - a.y),
    ];
    for (p, q) in checks {
        if p == 0.0 {
            if q < 0.0 {
                return None;
            }
        } else {
            let t = q / p;
            if p < 0.0 {
                if t > t1 {
                    return None;
                }
                if t > t0 {
                    t0 = t;
                }
            } else {
                if t < t0 {
                    return None;
                }
                if t < t1 {
                    t1 = t;
                }
            }
        }
    }
    if t1 >= t0 {
        Some((t0, t1))
    } else {
        None
    }
}

/// Index range `k0..k1` (a superset, by two samples on each side) of the samples
/// `a + (b − a)·(k + 0.5)/n`, `k < n`, that can lie in the closed rectangle `r`; empty
/// when `ab` misses `r`. Lets sampling loops skip samples that cannot count, so their
/// work is bounded by the part of the segment inside `r`.
pub fn sample_range_in_rect(a: P, b: P, n: usize, r: &Rect) -> (usize, usize) {
    let Some((t0, t1)) = clip_seg_rect(a, b, r) else {
        return (0, 0);
    };
    let nf = n as f64;
    let k0 = (t0 * nf - 0.5).floor() - 2.0;
    let k1 = (t1 * nf - 0.5).ceil() + 3.0;
    let k0 = if k0 > 0.0 { (k0 as usize).min(n) } else { 0 };
    let k1 = if k1 > 0.0 { (k1 as usize).min(n) } else { 0 };
    (k0, k1.max(k0))
}

/// Segment `ab` passes through the interior of `r` (shrunk by `EPS`).
pub fn seg_overlaps_rect(a: P, b: P, r: &Rect) -> bool {
    let inner = r.inflate(-EPS);
    if inner.is_empty() {
        return false;
    }
    match clip_seg_rect(a, b, &inner) {
        Some((t0, t1)) => {
            (t1 - t0) * a.dist(b) > EPS || inner.contains_point(a.lerp(b, (t0 + t1) * 0.5))
        }
        None => false,
    }
}

/// Distance between segment `ab` and rectangle `r` (0 if they touch or intersect).
pub fn dist_seg_rect(a: P, b: P, r: &Rect) -> f64 {
    if clip_seg_rect(a, b, r).is_some() {
        return 0.0;
    }
    let c = r.corners();
    let mut m = f64::INFINITY;
    for i in 0..4 {
        m = minf(m, seg_seg_dist(a, b, c[i], c[(i + 1) % 4]));
    }
    m
}

/// Bounding box of a point list.
pub fn bbox_of(points: &[P]) -> Rect {
    let mut r = Rect::EMPTY;
    for &p in points {
        r = r.add_point(p);
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_overlap_touching_is_not_overlap() {
        let a = Rect::xywh(0.0, 0.0, 10.0, 10.0);
        let b = Rect::xywh(10.0, 0.0, 10.0, 10.0);
        assert!(!a.overlaps(&b));
        assert!(a.touches(&b));
        let c = Rect::xywh(9.0, 9.0, 10.0, 10.0);
        assert!(a.overlaps(&c));
        assert_eq!(a.overlap_area(&c), 1.0);
    }

    #[test]
    fn segment_distances() {
        let d = seg_seg_dist(
            P::new(0.0, 0.0),
            P::new(10.0, 0.0),
            P::new(0.0, 3.0),
            P::new(10.0, 3.0),
        );
        assert!((d - 3.0).abs() < 1e-12);
        assert!(seg_cross_proper(
            P::new(0.0, 0.0),
            P::new(10.0, 10.0),
            P::new(0.0, 10.0),
            P::new(10.0, 0.0)
        ));
        assert!(!seg_cross_proper(
            P::new(0.0, 0.0),
            P::new(5.0, 5.0),
            P::new(5.0, 5.0),
            P::new(10.0, 0.0)
        ));
    }

    #[test]
    fn clip_segment() {
        let r = Rect::xywh(0.0, 0.0, 10.0, 10.0);
        let l = seg_len_in_rect(P::new(-5.0, 5.0), P::new(15.0, 5.0), &r);
        assert!((l - 10.0).abs() < 1e-12);
        assert!(seg_overlaps_rect(P::new(-5.0, 5.0), P::new(15.0, 5.0), &r));
        assert!(!seg_overlaps_rect(
            P::new(-5.0, 10.0),
            P::new(15.0, 10.0),
            &r
        ));
        assert_eq!(
            dist_seg_rect(P::new(12.0, -5.0), P::new(12.0, 15.0), &r),
            2.0
        );
    }

    #[test]
    fn affine_compose() {
        let a = Affine([2.0, 0.0, 0.0, 2.0, 1.0, 1.0]);
        let b = Affine([1.0, 0.0, 0.0, -1.0, 0.0, 100.0]);
        let c = a.then(&b);
        let p = P::new(3.0, 4.0);
        assert_eq!(c.apply(p), b.apply(a.apply(p)));
    }
}
