//! Flattening of path segments and basic shapes into polylines in canvas pixels.
//! Mirrors `flatten.ts` (same formulas and operation order).
//!
//! * Quadratic/cubic Béziers are transformed by the CTM first (affine maps preserve
//!   Béziers) and split into `n` uniform parameter steps with Wang's formula
//!   `n = ceil(sqrt(k · M / tol))`, `M = max |P_i − 2P_{i+1} + P_{i+2}|`, `k = 1/4`
//!   (quadratic) or `3/4` (cubic); the flattened curve is within `tol` of the curve.
//! * Elliptical arcs, circles, ellipses and rounded-rect corners are sampled uniformly in
//!   their parameter; the number of segments for a sweep `Δ` follows the sagitta formula
//!   `n = ceil(|Δ| / (2·acos(1 − tol/r)))` with `r` = the largest singular value of
//!   `CTM · R(φ) · diag(rx, ry)`, at least `ceil(|Δ| / 90°)`. All sample points lie on the
//!   exact curve.

use std::f64::consts::{FRAC_PI_2, PI, TAU};

use crate::geom::Affine;
use crate::path::Seg;

/// Upper bound for the segments of one curve (guards absurd coordinates).
pub(crate) const MAX_CURVE_SEGMENTS: usize = 4096;

/// A flattened subpath in canvas pixels: ≥ 2 distinct points; closed subpaths do not
/// repeat their first point.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Subpath {
    pub pts: Vec<[f64; 2]>,
    pub closed: bool,
}

/// Segments of a sweep `sweep` (radians) on a circle of radius `r` (canvas px).
pub(crate) fn arc_segments(r: f64, sweep: f64, tol: f64) -> usize {
    let sw = sweep.abs();
    if r.is_nan() || r <= 0.0 || !sw.is_finite() || sw == 0.0 {
        return 1;
    }
    let x = 1.0 - tol / r;
    let step = if x <= -1.0 { TAU } else { 2.0 * x.acos() };
    let mut n = (sw / step).ceil();
    let min_n = (sw / FRAC_PI_2).ceil();
    if n.is_nan() || n < min_n {
        n = min_n;
    }
    if n < 1.0 {
        1
    } else if n > MAX_CURVE_SEGMENTS as f64 {
        MAX_CURVE_SEGMENTS
    } else {
        n as usize
    }
}

fn bezier_segments(m: f64, k: f64, tol: f64) -> usize {
    let n = (k * m / tol).sqrt().ceil();
    if n.is_nan() || n < 1.0 {
        1
    } else if n > MAX_CURVE_SEGMENTS as f64 {
        MAX_CURVE_SEGMENTS
    } else {
        n as usize
    }
}

#[inline]
fn hyp2(x: f64, y: f64) -> f64 {
    x * x + y * y
}

/// Builds subpaths from user-space drawing commands.
pub(crate) struct Flattener {
    tol: f64,
    ctm: Affine,
    out: Vec<Subpath>,
    cur: Vec<[f64; 2]>,
    start: (f64, f64),
    pos: (f64, f64),
    /// False if a non-finite coordinate was produced (the shape is then dropped).
    pub finite: bool,
}

impl Flattener {
    pub(crate) fn new(ctm: Affine, tol: f64) -> Flattener {
        Flattener {
            tol,
            ctm,
            out: Vec::new(),
            cur: Vec::new(),
            start: (0.0, 0.0),
            pos: (0.0, 0.0),
            finite: true,
        }
    }

    #[inline]
    fn push(&mut self, p: [f64; 2]) {
        if !(p[0].is_finite() && p[1].is_finite()) {
            self.finite = false;
            return;
        }
        if let Some(last) = self.cur.last() {
            if last[0] == p[0] && last[1] == p[1] {
                return;
            }
        }
        self.cur.push(p);
    }

    fn finish(&mut self, closed: bool) {
        let mut pts = std::mem::take(&mut self.cur);
        if closed && pts.len() > 1 {
            let (f, l) = (pts[0], pts[pts.len() - 1]);
            if f[0] == l[0] && f[1] == l[1] {
                pts.pop();
            }
        }
        if pts.len() >= 2 {
            self.out.push(Subpath { pts, closed });
        }
    }

    fn ensure_started(&mut self) {
        if self.cur.is_empty() {
            let p = self.ctm.apply(self.pos.0, self.pos.1);
            self.push(p);
        }
    }

    pub(crate) fn move_to(&mut self, x: f64, y: f64) {
        self.finish(false);
        self.start = (x, y);
        self.pos = (x, y);
        let p = self.ctm.apply(x, y);
        self.push(p);
    }

    pub(crate) fn line_to(&mut self, x: f64, y: f64) {
        self.ensure_started();
        let p = self.ctm.apply(x, y);
        self.push(p);
        self.pos = (x, y);
    }

    pub(crate) fn quad_to(&mut self, x1: f64, y1: f64, x: f64, y: f64) {
        self.ensure_started();
        let p0 = self.ctm.apply(self.pos.0, self.pos.1);
        let p1 = self.ctm.apply(x1, y1);
        let p2 = self.ctm.apply(x, y);
        let m = hyp2(p0[0] - 2.0 * p1[0] + p2[0], p0[1] - 2.0 * p1[1] + p2[1]).sqrt();
        let n = bezier_segments(m, 0.25, self.tol);
        for i in 1..n {
            let t = i as f64 / n as f64;
            let mt = 1.0 - t;
            let a = mt * mt;
            let b = 2.0 * mt * t;
            let c = t * t;
            self.push([
                a * p0[0] + b * p1[0] + c * p2[0],
                a * p0[1] + b * p1[1] + c * p2[1],
            ]);
        }
        self.push(p2);
        self.pos = (x, y);
    }

    pub(crate) fn cubic_to(&mut self, x1: f64, y1: f64, x2: f64, y2: f64, x: f64, y: f64) {
        self.ensure_started();
        let p0 = self.ctm.apply(self.pos.0, self.pos.1);
        let p1 = self.ctm.apply(x1, y1);
        let p2 = self.ctm.apply(x2, y2);
        let p3 = self.ctm.apply(x, y);
        let d1 = hyp2(p0[0] - 2.0 * p1[0] + p2[0], p0[1] - 2.0 * p1[1] + p2[1]);
        let d2 = hyp2(p1[0] - 2.0 * p2[0] + p3[0], p1[1] - 2.0 * p2[1] + p3[1]);
        let m = (if d1 > d2 { d1 } else { d2 }).sqrt();
        let n = bezier_segments(m, 0.75, self.tol);
        for i in 1..n {
            let t = i as f64 / n as f64;
            let mt = 1.0 - t;
            let a = mt * mt * mt;
            let b = 3.0 * mt * mt * t;
            let c = 3.0 * mt * t * t;
            let d = t * t * t;
            self.push([
                a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
                a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
            ]);
        }
        self.push(p3);
        self.pos = (x, y);
    }

    /// SVG elliptical arc (implementation notes F.6.5/F.6.6), sampled on the exact ellipse.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn arc_to(
        &mut self,
        rx: f64,
        ry: f64,
        rot: f64,
        large: bool,
        sweep: bool,
        x: f64,
        y: f64,
    ) {
        let (x0, y0) = self.pos;
        if x0 == x && y0 == y {
            return;
        }
        let mut rx = rx.abs();
        let mut ry = ry.abs();
        if rx == 0.0 || ry == 0.0 {
            self.line_to(x, y);
            return;
        }
        self.ensure_started();
        let phi = rot * PI / 180.0;
        let (sin_phi, cos_phi) = (phi.sin(), phi.cos());
        let dx2 = (x0 - x) / 2.0;
        let dy2 = (y0 - y) / 2.0;
        let x1p = cos_phi * dx2 + sin_phi * dy2;
        let y1p = -sin_phi * dx2 + cos_phi * dy2;
        let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
        let mut coef = 0.0;
        if lambda > 1.0 {
            // Radii scaled up: the ellipse just fits, its center is the chord midpoint
            // (computing it would cancel catastrophically).
            let s = lambda.sqrt();
            rx *= s;
            ry *= s;
        } else {
            let rx2 = rx * rx;
            let ry2 = ry * ry;
            let num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
            let den = rx2 * y1p * y1p + ry2 * x1p * x1p;
            if den > 0.0 && num > 0.0 {
                coef = (num / den).sqrt();
            }
        }
        if large == sweep {
            coef = -coef;
        }
        let cxp = coef * (rx * y1p / ry);
        let cyp = coef * (-(ry * x1p / rx));
        let cx = cos_phi * cxp - sin_phi * cyp + (x0 + x) / 2.0;
        let cy = sin_phi * cxp + cos_phi * cyp + (y0 + y) / 2.0;
        let ux = (x1p - cxp) / rx;
        let uy = (y1p - cyp) / ry;
        let vx = (-x1p - cxp) / rx;
        let vy = (-y1p - cyp) / ry;
        let theta1 = uy.atan2(ux);
        let mut dtheta = (ux * vy - uy * vx).atan2(ux * vx + uy * vy);
        if !sweep && dtheta > 0.0 {
            dtheta -= TAU;
        } else if sweep && dtheta < 0.0 {
            dtheta += TAU;
        }
        let r = self
            .ctm
            .max_scale(cos_phi * rx, -sin_phi * ry, sin_phi * rx, cos_phi * ry);
        let n = arc_segments(r, dtheta, self.tol);
        for k in 1..n {
            let t = theta1 + dtheta * (k as f64) / (n as f64);
            let (st, ct) = (t.sin(), t.cos());
            let px = cx + rx * ct * cos_phi - ry * st * sin_phi;
            let py = cy + rx * ct * sin_phi + ry * st * cos_phi;
            let p = self.ctm.apply(px, py);
            self.push(p);
        }
        let p = self.ctm.apply(x, y);
        self.push(p);
        self.pos = (x, y);
    }

    pub(crate) fn close(&mut self) {
        if !self.cur.is_empty() {
            self.finish(true);
        }
        self.pos = self.start;
    }

    pub(crate) fn run(&mut self, segs: &[Seg]) {
        for s in segs {
            match *s {
                Seg::Move(x, y) => self.move_to(x, y),
                Seg::Line(x, y) => self.line_to(x, y),
                Seg::Quad(x1, y1, x, y) => self.quad_to(x1, y1, x, y),
                Seg::Cubic(x1, y1, x2, y2, x, y) => self.cubic_to(x1, y1, x2, y2, x, y),
                Seg::Arc {
                    rx,
                    ry,
                    rot,
                    large,
                    sweep,
                    x,
                    y,
                } => self.arc_to(rx, ry, rot, large, sweep, x, y),
                Seg::Close => self.close(),
            }
        }
    }

    /// Appends `n` points of an axis-aligned elliptical arc (center `c`, radii `rx`, `ry`)
    /// from angle `t0` over `sweep` radians, excluding the start, ending exactly at `end`.
    fn corner(&mut self, cx: f64, cy: f64, rx: f64, ry: f64, t0: f64, end: (f64, f64)) {
        let r = self.ctm.max_scale(rx, 0.0, 0.0, ry);
        let n = arc_segments(r, FRAC_PI_2, self.tol);
        for k in 1..n {
            let t = t0 + FRAC_PI_2 * (k as f64) / (n as f64);
            let p = self.ctm.apply(cx + rx * t.cos(), cy + ry * t.sin());
            self.push(p);
        }
        let p = self.ctm.apply(end.0, end.1);
        self.push(p);
        self.pos = end;
    }

    pub(crate) fn finish_all(mut self) -> Option<Vec<Subpath>> {
        self.finish(false);
        if self.finite {
            Some(self.out)
        } else {
            None
        }
    }
}

/// Rectangle with optional rounded corners (rx, ry already clamped).
#[allow(clippy::too_many_arguments)]
pub(crate) fn rect(
    ctm: Affine,
    tol: f64,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    rx: f64,
    ry: f64,
) -> Option<Vec<Subpath>> {
    let mut f = Flattener::new(ctm, tol);
    if rx > 0.0 && ry > 0.0 {
        f.move_to(x + rx, y);
        f.line_to(x + w - rx, y);
        f.corner(x + w - rx, y + ry, rx, ry, -FRAC_PI_2, (x + w, y + ry));
        f.line_to(x + w, y + h - ry);
        f.corner(x + w - rx, y + h - ry, rx, ry, 0.0, (x + w - rx, y + h));
        f.line_to(x + rx, y + h);
        f.corner(x + rx, y + h - ry, rx, ry, FRAC_PI_2, (x, y + h - ry));
        f.line_to(x, y + ry);
        f.corner(x + rx, y + ry, rx, ry, PI, (x + rx, y));
    } else {
        f.move_to(x, y);
        f.line_to(x + w, y);
        f.line_to(x + w, y + h);
        f.line_to(x, y + h);
    }
    f.close();
    f.finish_all()
}

/// Full ellipse (circle when `rx == ry`) starting at angle 0, clockwise on screen.
pub(crate) fn ellipse(
    ctm: Affine,
    tol: f64,
    cx: f64,
    cy: f64,
    rx: f64,
    ry: f64,
) -> Option<Vec<Subpath>> {
    let r = ctm.max_scale(rx, 0.0, 0.0, ry);
    let n = arc_segments(r, TAU, tol);
    let mut f = Flattener::new(ctm, tol);
    f.move_to(cx + rx, cy);
    for k in 1..n {
        let t = TAU * (k as f64) / (n as f64);
        let p = ctm.apply(cx + rx * t.cos(), cy + ry * t.sin());
        f.push(p);
    }
    f.close();
    f.finish_all()
}

/// Polyline / polygon from a flat coordinate list (an odd trailing value is ignored).
pub(crate) fn poly(ctm: Affine, tol: f64, coords: &[f64], closed: bool) -> Option<Vec<Subpath>> {
    let mut f = Flattener::new(ctm, tol);
    let mut k = 0;
    while k + 1 < coords.len() {
        if k == 0 {
            f.move_to(coords[0], coords[1]);
        } else {
            f.line_to(coords[k], coords[k + 1]);
        }
        k += 2;
    }
    if closed {
        f.close();
    }
    f.finish_all()
}

/// Path data.
pub(crate) fn path(ctm: Affine, tol: f64, segs: &[Seg]) -> Option<Vec<Subpath>> {
    let mut f = Flattener::new(ctm, tol);
    f.run(segs);
    f.finish_all()
}
