//! Occupancy grids for quick, exact rejection of label boxes (placed labels, item marks).

use crate::geom::shape::Shape;
use crate::geom::{Rect, EPS};
use crate::math::maxf;

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
    /// For grids that no longer change (`freeze`): summed-area table of the occupied
    /// cells, `(cols + 1) × (rows + 1)`, so that a window query is O(1).
    sat: Option<Vec<u32>>,
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
            sat: None,
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
        // t0 < k < t1: k from floor(t0) + 1 to ceil(t1) (exclusive), clamped to 0..n.
        // Integer arithmetic on values clamped to ±4.5e15 (< 2^52, where floor and ceil
        // are exact; anything beyond lies off the grid either way). A NaN converts to 0,
        // as `floor_fast` does.
        let t0 = t0.clamp(-4.5e15, 4.5e15);
        let t1 = t1.clamp(-4.5e15, 4.5e15);
        let i0 = t0 as i64;
        let f = (i0 - ((i0 as f64) > t0) as i64 + 1).max(0);
        let i1 = t1 as i64;
        let l = (i1 + ((i1 as f64) < t1) as i64).min(n as i64);
        if l <= f {
            return (0, 0);
        }
        (f as usize, l as usize)
    }

    /// Builds the summed-area table of a grid that will not change any more (marking
    /// again drops it).
    pub fn freeze(&mut self) {
        let w = self.cols + 1;
        let mut sat = vec![0u32; w * (self.rows + 1)];
        for r in 0..self.rows {
            let mut run = 0u32;
            for c in 0..self.cols {
                run += u32::from(self.count[r * self.cols + c] > 0);
                sat[(r + 1) * w + c + 1] = sat[r * w + c + 1] + run;
            }
        }
        self.sat = Some(sat);
    }

    /// Add (or remove) a rectangle: cells whose centers lie strictly inside it.
    pub fn mark(&mut self, r: &Rect, add: bool) {
        self.sat = None;
        let (c0, c1) = self.span(self.ox, self.cols, r.x0, r.x1);
        let (r0, r1) = self.span(self.oy, self.rows, r.y0, r.y1);
        if c0 >= c1 {
            return;
        }
        // the bits of the span, word by word: (word, mask)
        let (w0, w1) = (c0 / 64, (c1 - 1) / 64);
        let mask = |w: usize| {
            let lo = if w == w0 { c0 % 64 } else { 0 };
            let hi = if w == w1 { (c1 - 1) % 64 + 1 } else { 64 };
            (u64::MAX >> (64 - (hi - lo))) << lo
        };
        for row in r0..r1 {
            let base = row * self.cols;
            let cells = &mut self.count[base + c0..base + c1];
            let bits = &mut self.bits[row * self.words..(row + 1) * self.words];
            if add {
                for v in cells.iter_mut() {
                    *v = v.saturating_add(1);
                }
                for (w, b) in bits.iter_mut().enumerate().take(w1 + 1).skip(w0) {
                    *b |= mask(w);
                }
                continue;
            }
            let mut left = 0u16;
            for v in cells.iter_mut() {
                *v = v.saturating_sub(1);
                left |= *v;
            }
            for (w, b) in bits.iter_mut().enumerate().take(w1 + 1).skip(w0) {
                let m = mask(w);
                if left == 0 {
                    *b &= !m;
                    continue;
                }
                // another label still covers some cells of this word
                let mut free = 0u64;
                for c in (w * 64).max(c0)..((w + 1) * 64).min(c1) {
                    free |= u64::from(self.count[base + c] == 0) << (c % 64);
                }
                *b &= !(m & free);
            }
        }
    }

    /// Whether any occupied cell center lies strictly inside `r`.
    pub fn blocked(&self, r: &Rect) -> bool {
        self.window(r).is_some_and(|w| self.blocked_in(&w))
    }

    /// The cells whose centers lie strictly inside `r` (`None` if there are none). Grids
    /// with the same cells (`same_cells`) can share a window.
    #[inline]
    pub fn window(&self, r: &Rect) -> Option<Window> {
        let (c0, c1) = self.span(self.ox, self.cols, r.x0, r.x1);
        if c0 >= c1 {
            return None;
        }
        let (r0, r1) = self.span(self.oy, self.rows, r.y0, r.y1);
        if r0 >= r1 {
            return None;
        }
        Some(Window { c0, c1, r0, r1 })
    }

    /// Whether the two grids have the same cells.
    pub fn same_cells(&self, o: &Occupancy) -> bool {
        self.ox == o.ox
            && self.oy == o.oy
            && self.cell == o.cell
            && self.cols == o.cols
            && self.rows == o.rows
    }

    /// Whether any cell of the window is occupied.
    #[inline]
    pub fn blocked_in(&self, w: &Window) -> bool {
        if let Some(sat) = &self.sat {
            let s = self.cols + 1;
            let n = sat[w.r1 * s + w.c1].wrapping_sub(sat[w.r0 * s + w.c1])
                - sat[w.r1 * s + w.c0].wrapping_sub(sat[w.r0 * s + w.c0]);
            return n != 0;
        }
        let stride = self.words;
        let rows = &self.bits[w.r0 * stride..w.r1 * stride];
        let (w0, w1) = (w.c0 / 64, (w.c1 - 1) / 64);
        let first = !0u64 << (w.c0 % 64);
        let last = !0u64 >> (63 - (w.c1 - 1) % 64);
        if w0 == w1 {
            // the common case: the window lies in one word of every row
            let m = first & last;
            return rows[w0..].iter().step_by(stride).any(|&b| b & m != 0);
        }
        rows.chunks_exact(stride).any(|row| {
            row[w0] & first != 0 || row[w1] & last != 0 || row[w0 + 1..w1].iter().any(|&b| b != 0)
        })
    }
}

/// Cell index ranges `c0..c1` × `r0..r1` of a query rectangle.
#[derive(Clone, Copy, Debug)]
pub struct Window {
    c0: usize,
    c1: usize,
    r0: usize,
    r1: usize,
}

impl Occupancy {
    /// Add a shape: cells whose centers lie strictly inside it (by more than the margin).
    pub fn mark_shape(&mut self, s: &Shape) {
        self.sat = None;
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

#[cfg(test)]
mod tests {
    use super::*;
    use la_expr::det_math::Pcg32;

    /// Marking word by word keeps the bits equal to "count > 0", with overlapping boxes
    /// added and removed in any order, across word boundaries and at the grid's edges.
    #[test]
    fn bits_mirror_the_counts() {
        let mut occ = Occupancy::new(&Rect::new(0.0, 0.0, 300.0, 40.0));
        let mut rng = Pcg32::new(7);
        let mut placed: Vec<Rect> = Vec::new();
        for _ in 0..2000 {
            if placed.is_empty() || rng.next_f64() < 0.55 {
                let x = rng.next_f64() * 340.0 - 20.0;
                let y = rng.next_f64() * 50.0 - 5.0;
                let r = Rect::new(x, y, x + rng.next_f64() * 160.0, y + rng.next_f64() * 12.0);
                occ.mark(&r, true);
                placed.push(r);
            } else {
                let k = rng.next_below(placed.len() as u32) as usize;
                occ.mark(&placed.swap_remove(k), false);
            }
            for row in 0..occ.rows {
                for c in 0..occ.cols {
                    let bit = occ.bits[row * occ.words + c / 64] >> (c % 64) & 1;
                    assert_eq!(bit == 1, occ.count[row * occ.cols + c] > 0);
                }
            }
        }
        for r in placed.drain(..) {
            occ.mark(&r, false);
        }
        assert!(occ.is_empty() && occ.count.iter().all(|&v| v == 0));
    }
}
