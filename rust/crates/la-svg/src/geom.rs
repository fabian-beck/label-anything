//! Affine matrices and bounding boxes. Mirrors `geom.ts` (same operation order, so the
//! two implementations produce the same floating-point results).

use std::f64::consts::PI;

/// `x' = a·x + c·y + e`, `y' = b·x + d·y + f` (SVG matrix order).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Affine {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

impl Affine {
    pub(crate) const IDENTITY: Affine = Affine {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    };

    pub(crate) const fn new(a: f64, b: f64, c: f64, d: f64, e: f64, f: f64) -> Affine {
        Affine { a, b, c, d, e, f }
    }

    pub(crate) const fn translate(tx: f64, ty: f64) -> Affine {
        Affine::new(1.0, 0.0, 0.0, 1.0, tx, ty)
    }

    pub(crate) const fn scale(sx: f64, sy: f64) -> Affine {
        Affine::new(sx, 0.0, 0.0, sy, 0.0, 0.0)
    }

    pub(crate) fn rotate(deg: f64) -> Affine {
        let r = deg * PI / 180.0;
        let (s, c) = (r.sin(), r.cos());
        Affine::new(c, s, -s, c, 0.0, 0.0)
    }

    pub(crate) fn skew_x(deg: f64) -> Affine {
        Affine::new(1.0, 0.0, (deg * PI / 180.0).tan(), 1.0, 0.0, 0.0)
    }

    pub(crate) fn skew_y(deg: f64) -> Affine {
        Affine::new(1.0, (deg * PI / 180.0).tan(), 0.0, 1.0, 0.0, 0.0)
    }

    /// `self · o` (apply `o` first). Multiplication by the identity is skipped (as in TS,
    /// where it is the shared IDENTITY object), which keeps signed zeros identical.
    pub(crate) fn mul(&self, o: &Affine) -> Affine {
        if *o == Affine::IDENTITY {
            return *self;
        }
        if *self == Affine::IDENTITY {
            return *o;
        }
        Affine {
            a: self.a * o.a + self.c * o.b,
            b: self.b * o.a + self.d * o.b,
            c: self.a * o.c + self.c * o.d,
            d: self.b * o.c + self.d * o.d,
            e: self.a * o.e + self.c * o.f + self.e,
            f: self.b * o.e + self.d * o.f + self.f,
        }
    }

    #[inline]
    pub(crate) fn apply(&self, x: f64, y: f64) -> [f64; 2] {
        [
            self.a * x + self.c * y + self.e,
            self.b * x + self.d * y + self.f,
        ]
    }

    /// `√|det|`: the mean scale used for stroke widths.
    pub(crate) fn mean_scale(&self) -> f64 {
        (self.a * self.d - self.b * self.c).abs().sqrt()
    }

    /// Largest singular value of `L · M`, where `L` is the linear part of `self` and
    /// `M = [[m00, m01], [m10, m11]]` (column vectors `(m00, m10)` and `(m01, m11)`).
    pub(crate) fn max_scale(&self, m00: f64, m01: f64, m10: f64, m11: f64) -> f64 {
        let p00 = self.a * m00 + self.c * m10;
        let p01 = self.a * m01 + self.c * m11;
        let p10 = self.b * m00 + self.d * m10;
        let p11 = self.b * m01 + self.d * m11;
        let s = p00 * p00 + p01 * p01 + p10 * p10 + p11 * p11;
        let det = p00 * p11 - p01 * p10;
        let disc = s * s - 4.0 * det * det;
        let root = if disc > 0.0 { disc.sqrt() } else { 0.0 };
        ((s + root) / 2.0).sqrt()
    }
}

/// Axis-aligned bounding box (`x0 ≤ x1`, `y0 ≤ y1`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct BBox {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

impl BBox {
    pub(crate) fn of_point(p: [f64; 2]) -> BBox {
        BBox {
            x0: p[0],
            y0: p[1],
            x1: p[0],
            y1: p[1],
        }
    }

    #[inline]
    pub(crate) fn add(&mut self, p: [f64; 2]) {
        if p[0] < self.x0 {
            self.x0 = p[0];
        }
        if p[0] > self.x1 {
            self.x1 = p[0];
        }
        if p[1] < self.y0 {
            self.y0 = p[1];
        }
        if p[1] > self.y1 {
            self.y1 = p[1];
        }
    }

    pub(crate) fn union(a: Option<BBox>, b: Option<BBox>) -> Option<BBox> {
        match (a, b) {
            (Some(a), Some(b)) => Some(BBox {
                x0: if b.x0 < a.x0 { b.x0 } else { a.x0 },
                y0: if b.y0 < a.y0 { b.y0 } else { a.y0 },
                x1: if b.x1 > a.x1 { b.x1 } else { a.x1 },
                y1: if b.y1 > a.y1 { b.y1 } else { a.y1 },
            }),
            (a, None) => a,
            (None, b) => b,
        }
    }

    pub(crate) fn of_points<'a>(pts: impl IntoIterator<Item = &'a [f64; 2]>) -> Option<BBox> {
        let mut it = pts.into_iter();
        let mut bb = BBox::of_point(*it.next()?);
        for p in it {
            bb.add(*p);
        }
        Some(bb)
    }

    pub(crate) fn width(&self) -> f64 {
        self.x1 - self.x0
    }

    pub(crate) fn height(&self) -> f64 {
        self.y1 - self.y0
    }
}
