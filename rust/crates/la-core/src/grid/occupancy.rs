//! Occupancy grids for quick, exact rejection of label boxes (placed labels, item marks).

use crate::geom::shape::Shape;
use crate::geom::{Rect, EPS};
use crate::math::{ceil_fast, floor_fast, maxf, minf};

/// Margin of the quick rejection test (2 × `EPS`, so that a hit implies an overlap in
/// the sense of `Rect::overlaps`).
pub const OCC_MARGIN: f64 = 2.0 * EPS;

/// Fine grid counting, per cell, the placed rectangular labels whose interior contains
/// the cell center, mirrored in a per-row bitset of non-zero cells. A candidate box whose
/// interior contains an occupied cell center (with margin) overlaps a placed label: an
/// exact rejection test (placed labels in `State::quick_blocked`, item marks in
/// `Obstacles::item_occ`) that misses only overlaps thinner than a cell.
pub struct Occupancy {
    ox: f64,
    oy: f64,
    cell: f64,
    inv_cell: f64,
    cols: usize,
    rows: usize,
    count: Vec<u16>,
    /// `words` u64 per row; bit `c` of row `r` = `count[r * cols + c] > 0`.
    bits: Vec<u64>,
    words: usize,
}

impl Occupancy {
    pub fn new(extent: &Rect) -> Occupancy {
        // about 1M cells at most, and never finer than 2 px
        let area = maxf(extent.w() * extent.h(), 1.0);
        let cell = maxf(2.0, (area / 1.0e6).sqrt());
        let cols = ((extent.w() / cell).ceil() as usize).clamp(1, 4096);
        let rows = ((extent.h() / cell).ceil() as usize).clamp(1, 4096);
        let words = cols.div_ceil(64);
        Occupancy {
            ox: extent.x0,
            oy: extent.y0,
            cell,
            inv_cell: 1.0 / cell,
            cols,
            rows,
            count: vec![0; cols * rows],
            bits: vec![0; words * rows],
            words,
        }
    }

    /// Cells `k` (along one axis) whose centers `o + (k + 0.5)·cell` lie inside `(a, b)`
    /// shrunk by the margin, as a half-open index range. Mark and query use the same
    /// computation; its rounding error (~1e-13 px) is far below the margin, so a cell
    /// center counted inside both a placed label and a candidate implies an overlap.
    #[inline]
    fn span(&self, o: f64, n: usize, a: f64, b: f64) -> (usize, usize) {
        let t0 = (a + OCC_MARGIN - o) * self.inv_cell - 0.5;
        let t1 = (b - OCC_MARGIN - o) * self.inv_cell - 0.5;
        // t0 < k < t1
        let f = maxf(floor_fast(t0) + 1.0, 0.0);
        let l = minf(ceil_fast(t1), n as f64);
        if l <= f || l.is_nan() || f.is_nan() {
            return (0, 0);
        }
        (f as usize, l as usize)
    }

    /// Add (or remove) a rectangle: cells whose centers lie strictly inside it.
    pub fn mark(&mut self, r: &Rect, add: bool) {
        let (c0, c1) = self.span(self.ox, self.cols, r.x0, r.x1);
        let (r0, r1) = self.span(self.oy, self.rows, r.y0, r.y1);
        for row in r0..r1 {
            let base = row * self.cols;
            let wbase = row * self.words;
            for c in c0..c1 {
                let v = &mut self.count[base + c];
                *v = if add {
                    v.saturating_add(1)
                } else {
                    v.saturating_sub(1)
                };
                let bit = 1u64 << (c % 64);
                if *v > 0 {
                    self.bits[wbase + c / 64] |= bit;
                } else {
                    self.bits[wbase + c / 64] &= !bit;
                }
            }
        }
    }

    /// Whether any occupied cell center lies strictly inside `r`.
    pub fn blocked(&self, r: &Rect) -> bool {
        let (c0, c1) = self.span(self.ox, self.cols, r.x0, r.x1);
        if c0 >= c1 {
            return false;
        }
        let (r0, r1) = self.span(self.oy, self.rows, r.y0, r.y1);
        let (w0, w1) = (c0 / 64, (c1 - 1) / 64);
        let first_mask = !0u64 << (c0 % 64);
        let last_mask = !0u64 >> (63 - (c1 - 1) % 64);
        for row in r0..r1 {
            let words = &self.bits[row * self.words..(row + 1) * self.words];
            if w0 == w1 {
                if words[w0] & first_mask & last_mask != 0 {
                    return true;
                }
                continue;
            }
            if words[w0] & first_mask != 0 || words[w1] & last_mask != 0 {
                return true;
            }
            if words[w0 + 1..w1].iter().any(|&w| w != 0) {
                return true;
            }
        }
        false
    }
}

impl Occupancy {
    /// Add a shape: cells whose centers lie strictly inside it (by more than the margin).
    pub fn mark_shape(&mut self, s: &Shape) {
        let bb = s.bbox();
        let (c0, c1) = self.span(self.ox, self.cols, bb.x0, bb.x1);
        let (r0, r1) = self.span(self.oy, self.rows, bb.y0, bb.y1);
        let cell = self.cell;
        for row in r0..r1 {
            let y = self.oy + (row as f64 + 0.5) * cell;
            for c in c0..c1 {
                let x = self.ox + (c as f64 + 0.5) * cell;
                if s.signed_distance(crate::geom::P::new(x, y)) < -OCC_MARGIN {
                    let v = &mut self.count[row * self.cols + c];
                    *v = v.saturating_add(1);
                    self.bits[row * self.words + c / 64] |= 1u64 << (c % 64);
                }
            }
        }
    }

    /// Whether nothing is marked.
    pub fn is_empty(&self) -> bool {
        self.bits.iter().all(|&w| w == 0)
    }
}
