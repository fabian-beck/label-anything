//! Per-class coverage grids with summed-area tables (spec §4.1, ADR 0005).

pub mod dt;
pub mod occupancy;
pub mod raster;

use crate::geom::{Rect, P};

/// Grid geometry in canvas pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GridSpec {
    pub ox: f64,
    pub oy: f64,
    pub cell: f64,
    pub cols: usize,
    pub rows: usize,
}

impl GridSpec {
    /// Grid covering `extent` with the given cell size.
    pub fn covering(extent: &Rect, cell: f64) -> GridSpec {
        let cols = ((extent.w() / cell).ceil() as usize).max(1);
        let rows = ((extent.h() / cell).ceil() as usize).max(1);
        GridSpec {
            ox: extent.x0,
            oy: extent.y0,
            cell,
            cols,
            rows,
        }
    }
    #[inline]
    pub fn cells(&self) -> usize {
        self.cols * self.rows
    }
    /// Continuous cell coordinates of a canvas point.
    #[inline]
    pub fn to_cell(&self, p: P) -> (f64, f64) {
        ((p.x - self.ox) / self.cell, (p.y - self.oy) / self.cell)
    }
    /// Canvas rectangle of cell (col, row).
    #[inline]
    pub fn cell_rect(&self, col: usize, row: usize) -> Rect {
        let x = self.ox + col as f64 * self.cell;
        let y = self.oy + row as f64 * self.cell;
        Rect::new(x, y, x + self.cell, y + self.cell)
    }
    /// Canvas center of cell (col, row).
    #[inline]
    pub fn cell_center(&self, col: usize, row: usize) -> P {
        P::new(
            self.ox + (col as f64 + 0.5) * self.cell,
            self.oy + (row as f64 + 0.5) * self.cell,
        )
    }
    /// The extent covered by the grid.
    pub fn extent(&self) -> Rect {
        Rect::new(
            self.ox,
            self.oy,
            self.ox + self.cols as f64 * self.cell,
            self.oy + self.rows as f64 * self.cell,
        )
    }
    /// Integer cell range `[c0, c1) × [r0, r1)` of cells touched by `r`, clamped.
    pub fn cell_range(&self, r: &Rect) -> (usize, usize, usize, usize) {
        let (u0, v0) = self.to_cell(P::new(r.x0, r.y0));
        let (u1, v1) = self.to_cell(P::new(r.x1, r.y1));
        let c0 = clamp_floor(u0, self.cols);
        let r0 = clamp_floor(v0, self.rows);
        let c1 = clamp_ceil(u1, self.cols);
        let r1 = clamp_ceil(v1, self.rows);
        (c0, c1.max(c0), r0, r1.max(r0))
    }
}

#[inline]
fn clamp_floor(v: f64, n: usize) -> usize {
    if v <= 0.0 {
        0
    } else if v >= n as f64 {
        n
    } else {
        v as usize // truncation == floor for v > 0
    }
}

#[inline]
fn clamp_ceil(v: f64, n: usize) -> usize {
    if v <= 0.0 {
        0
    } else if v >= n as f64 {
        n
    } else {
        crate::math::ceil_fast(v) as usize
    }
}

/// Summed-area table of a `u8` coverage grid (wrapping `u32`).
#[derive(Clone, Debug)]
pub struct Sat {
    pub cols: usize,
    pub rows: usize,
    /// `(rows + 1) × (cols + 1)` prefix sums, row-major.
    data: Vec<u32>,
    /// Whether any cell is non-zero.
    pub nonempty: bool,
}

impl Sat {
    pub fn from_coverage(cols: usize, rows: usize, cov: &[u8]) -> Sat {
        debug_assert_eq!(cov.len(), cols * rows);
        let w = cols + 1;
        let mut data = vec![0u32; w * (rows + 1)];
        let mut nonempty = false;
        for r in 0..rows {
            let mut row_sum = 0u32;
            let src = &cov[r * cols..(r + 1) * cols];
            let (prev, cur) = data.split_at_mut((r + 1) * w);
            let prev = &prev[r * w..(r + 1) * w];
            let cur = &mut cur[..w];
            for c in 0..cols {
                let v = src[c] as u32;
                if v != 0 {
                    nonempty = true;
                }
                row_sum = row_sum.wrapping_add(v);
                cur[c + 1] = prev[c + 1].wrapping_add(row_sum);
            }
        }
        Sat {
            cols,
            rows,
            data,
            nonempty,
        }
    }

    #[inline]
    fn at(&self, c: usize, r: usize) -> u32 {
        self.data[r * (self.cols + 1) + c]
    }

    /// Sum of cells `[c0, c1) × [r0, r1)` (bounds must be within the grid).
    #[inline]
    pub fn block(&self, c0: usize, c1: usize, r0: usize, r1: usize) -> u32 {
        if c1 <= c0 || r1 <= r0 {
            return 0;
        }
        self.at(c1, r1)
            .wrapping_sub(self.at(c0, r1))
            .wrapping_sub(self.at(c1, r0))
            .wrapping_add(self.at(c0, r0))
    }

    /// Value of one cell.
    #[inline]
    pub fn cell(&self, c: usize, r: usize) -> u8 {
        self.block(c, c + 1, r, r + 1) as u8
    }

    /// Exact integral of the piecewise-constant coverage over `rect` (spec §4.1), in
    /// units of "coverage-cells" (0..255 per fully covered cell).
    pub fn integral(&self, g: &GridSpec, rect: &Rect) -> f64 {
        if !self.nonempty {
            return 0.0;
        }
        let (u0, v0) = g.to_cell(P::new(rect.x0, rect.y0));
        let (u1, v1) = g.to_cell(P::new(rect.x1, rect.y1));
        let cols = self.cols as f64;
        let rows = self.rows as f64;
        let u0 = clamp01(u0, cols);
        let u1 = clamp01(u1, cols);
        let v0 = clamp01(v0, rows);
        let v1 = clamp01(v1, rows);
        if u1 <= u0 || v1 <= v0 {
            return 0.0;
        }
        let xs = axis_parts(u0, u1, self.cols);
        let ys = axis_parts(v0, v1, self.rows);
        let mut total = 0.0;
        for &(ya, yb, wy) in ys.iter() {
            if wy == 0.0 {
                continue;
            }
            for &(xa, xb, wx) in xs.iter() {
                if wx == 0.0 {
                    continue;
                }
                let s = self.block(xa, xb, ya, yb);
                if s != 0 {
                    total += wx * wy * s as f64;
                }
            }
        }
        total
    }

    /// Covered area of `rect` in px² (coverage-weighted).
    #[inline]
    pub fn covered_area(&self, g: &GridSpec, rect: &Rect) -> f64 {
        self.integral(g, rect) * (g.cell * g.cell / 255.0)
    }

    /// Whether `rect` overlaps any non-zero cell (with positive overlap area).
    pub fn any(&self, g: &GridSpec, rect: &Rect) -> bool {
        if !self.nonempty {
            return false;
        }
        let (c0, c1, r0, r1) = g.cell_range(rect);
        if c1 <= c0 || r1 <= r0 {
            return false;
        }
        // cells touched with positive area: the closed range from cell_range is exact
        // because rect edges exactly on cell boundaries round inward via floor/ceil.
        self.block(c0, c1, r0, r1) != 0
    }
}

#[inline]
fn clamp01(v: f64, n: f64) -> f64 {
    if v < 0.0 {
        0.0
    } else if v > n {
        n
    } else {
        v
    }
}

/// Split the interval `[a, b]` (cell units, `0 <= a < b <= n`) into up to three parts:
/// the partial first cell, the full interior cells and the partial last cell. Each part is
/// `(start_cell, end_cell_exclusive, weight)`; unused parts have weight 0.
#[inline]
fn axis_parts(a: f64, b: f64, n: usize) -> [(usize, usize, f64); 3] {
    let none = (0usize, 0usize, 0.0f64);
    let i0 = a as usize; // a >= 0: truncation == floor
    if i0 >= n {
        return [none; 3];
    }
    let bf = crate::math::floor_fast(b);
    let i1 = bf as usize; // cell containing b, or n when b == n
    if i1 == i0 {
        return [(i0, i0 + 1, b - a), none, none];
    }
    let first = (i0, i0 + 1, (i0 + 1) as f64 - a);
    let mid = (i0 + 1, i1, 1.0);
    let last = if i1 < n && b > bf {
        (i1, i1 + 1, b - bf)
    } else {
        none
    };
    [first, mid, last]
}

/// Quantize a coverage fraction to 0..=255 (a positive fraction never maps to 0).
#[inline]
pub fn quantize(f: f64) -> u8 {
    if f <= 0.0 {
        return 0;
    }
    let q = crate::math::floor_fast(f * 255.0 + 0.5);
    if q < 1.0 {
        1
    } else if q > 255.0 {
        255
    } else {
        q as u8
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(cols: usize, rows: usize, cell: f64) -> GridSpec {
        GridSpec {
            ox: 0.0,
            oy: 0.0,
            cell,
            cols,
            rows,
        }
    }

    #[test]
    fn sat_blocks_and_integral() {
        let g = spec(4, 3, 2.0);
        let mut cov = vec![0u8; 12];
        cov[5] = 255; // col 1, row 1 -> canvas [2,4]x[2,4]
        cov[6] = 100; // col 2, row 1
        let sat = Sat::from_coverage(4, 3, &cov);
        assert_eq!(sat.block(0, 4, 0, 3), 355);
        assert_eq!(sat.cell(1, 1), 255);
        // full cell
        let a = sat.covered_area(&g, &Rect::new(2.0, 2.0, 4.0, 4.0));
        assert!((a - 4.0).abs() < 1e-12);
        // half of cell (1,1)
        let a = sat.covered_area(&g, &Rect::new(3.0, 2.0, 4.0, 4.0));
        assert!((a - 2.0).abs() < 1e-12);
        // quarter of (1,1) and quarter of (2,1) with 100/255
        let a = sat.covered_area(&g, &Rect::new(3.0, 3.0, 5.0, 4.0));
        assert!((a - (1.0 + 100.0 / 255.0)).abs() < 1e-12, "{a}");
        // rect spanning many cells
        let a = sat.covered_area(&g, &Rect::new(-10.0, -10.0, 100.0, 100.0));
        assert!((a - (4.0 + 4.0 * 100.0 / 255.0)).abs() < 1e-9);
        assert!(sat.any(&g, &Rect::new(3.9, 3.9, 4.0, 4.0)));
        assert!(!sat.any(&g, &Rect::new(0.0, 0.0, 2.0, 2.0)));
        // touching the covered cell only on its edge is not "any"
        assert!(!sat.any(&g, &Rect::new(0.0, 2.0, 2.0, 4.0)));
    }

    #[test]
    fn integral_matches_brute_force() {
        let g = spec(7, 5, 1.5);
        let mut cov = vec![0u8; 35];
        for (i, c) in cov.iter_mut().enumerate() {
            *c = ((i * 37) % 256) as u8;
        }
        let sat = Sat::from_coverage(7, 5, &cov);
        let rects = [
            Rect::new(0.3, 0.2, 9.1, 6.9),
            Rect::new(1.5, 1.5, 3.0, 3.0),
            Rect::new(2.2, 0.0, 2.9, 7.5),
            Rect::new(-3.0, 4.0, 4.0, 4.4),
        ];
        for r in rects {
            let mut brute = 0.0;
            for row in 0..5 {
                for col in 0..7 {
                    let cr = g.cell_rect(col, row);
                    brute += cr.overlap_area(&r) / (1.5 * 1.5) * cov[row * 7 + col] as f64;
                }
            }
            let v = sat.integral(&g, &r);
            assert!((v - brute).abs() < 1e-9, "{r:?}: {v} vs {brute}");
        }
    }

    #[test]
    fn quantize_never_zero_for_positive() {
        assert_eq!(quantize(0.0), 0);
        assert_eq!(quantize(1e-9), 1);
        assert_eq!(quantize(1.0), 255);
        assert_eq!(quantize(0.5), 128);
    }
}
