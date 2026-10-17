//! Own vector rasterizer (spec §4.2): 4 × 4 supersampling per cell into sample bit masks,
//! union by OR, plus conservative "touch" marking along boundaries.
//!
//! Sample `(sx, sy)` of cell `(col, row)` sits at
//! `(ox + (4·col + sx + 0.5)·c/4, oy + (4·row + sy + 0.5)·c/4)` and maps to bit `4·sy + sx`.
//! Bit 16 marks a cell touched by geometry.

use super::{quantize, GridSpec};
use crate::geom::{shape::Shape, P};
use crate::math::{maxf, minf};

const TOUCH: u32 = 1 << 16;

/// [`MaskRaster::touch_segment`] clips segments to the grid grown by this many cells.
pub const TOUCH_MARGIN: f64 = 2.0;

/// Clip the segment `(c0, o0)–(c1, o1)` to the slab `lo <= c <= hi` of its first
/// coordinate; false when it lies outside. A clipped endpoint gets `c` exactly on the
/// bound and `o` interpolated from the unclipped endpoints, so precision is not lost for
/// endpoints far away (unlike clipping by a line parameter). Endpoints inside the slab
/// are left unchanged.
fn clip_slab(c0: &mut f64, o0: &mut f64, c1: &mut f64, o1: &mut f64, lo: f64, hi: f64) -> bool {
    let (a0, b0, a1, b1) = (*c0, *o0, *c1, *o1);
    if (a0 < lo && a1 < lo) || (a0 > hi && a1 > hi) {
        return false;
    }
    if a0 < lo {
        *o0 = b0 + (b1 - b0) * ((lo - a0) / (a1 - a0));
        *c0 = lo;
    } else if a0 > hi {
        *o0 = b0 + (b1 - b0) * ((hi - a0) / (a1 - a0));
        *c0 = hi;
    }
    if a1 < lo {
        *o1 = b1 + (b0 - b1) * ((lo - a1) / (a0 - a1));
        *c1 = lo;
    } else if a1 > hi {
        *o1 = b1 + (b0 - b1) * ((hi - a1) / (a0 - a1));
        *c1 = hi;
    }
    true
}

/// Accumulates the union of primitives of one class.
pub struct MaskRaster {
    pub spec: GridSpec,
    mask: Vec<u32>,
    /// Sample spacing in px.
    step: f64,
}

impl MaskRaster {
    pub fn new(spec: GridSpec) -> MaskRaster {
        MaskRaster {
            spec,
            mask: vec![0; spec.cells()],
            step: spec.cell / 4.0,
        }
    }

    #[inline]
    fn sample_rows(&self) -> usize {
        self.spec.rows * 4
    }
    #[inline]
    fn sample_cols(&self) -> usize {
        self.spec.cols * 4
    }

    /// y of sample row `j`.
    #[inline]
    fn sample_y(&self, j: usize) -> f64 {
        self.spec.oy + (j as f64 + 0.5) * self.step
    }

    /// Range of sample rows whose y lies in `[y0, y1]`.
    fn sample_row_range(&self, y0: f64, y1: f64) -> (usize, usize) {
        let a = crate::math::ceil_fast((y0 - self.spec.oy) / self.step - 0.5);
        let b = crate::math::floor_fast((y1 - self.spec.oy) / self.step - 0.5);
        let n = self.sample_rows() as f64;
        let a = if a < 0.0 { 0.0 } else { a };
        let b = if b > n - 1.0 { n - 1.0 } else { b };
        if b < a {
            (1, 0)
        } else {
            (a as usize, b as usize)
        }
    }

    /// Set the samples of row `j` with x in `[xa, xb)`.
    #[inline]
    fn span(&mut self, j: usize, xa: f64, xb: f64) {
        if xb <= xa {
            return;
        }
        let sc = self.sample_cols() as f64;
        let mut k0 = crate::math::ceil_fast((xa - self.spec.ox) / self.step - 0.5);
        let mut k1 = crate::math::ceil_fast((xb - self.spec.ox) / self.step - 0.5); // exclusive
        if k0 < 0.0 {
            k0 = 0.0;
        }
        if k1 > sc {
            k1 = sc;
        }
        if k1 <= k0 {
            return;
        }
        let row = j / 4;
        let sy = (j % 4) as u32;
        let base = row * self.spec.cols;
        let (k0, k1) = (k0 as usize, k1 as usize);
        let mut k = k0;
        while k < k1 {
            let col = k / 4;
            let sx0 = k % 4;
            let end = minf(((col + 1) * 4) as f64, k1 as f64) as usize;
            let sx1 = end - col * 4;
            // bits sx0..sx1 in row sy
            let bits = ((1u32 << (sx1 - sx0)) - 1) << (sx0 as u32 + 4 * sy);
            self.mask[base + col] |= bits;
            k = end;
        }
    }

    /// Mark the cell containing `p` as touched.
    #[inline]
    fn touch_point(&mut self, p: P) {
        let (u, v) = self.spec.to_cell(p);
        if u >= 0.0 && v >= 0.0 && u < self.spec.cols as f64 && v < self.spec.rows as f64 {
            let i = v as usize * self.spec.cols + u as usize;
            self.mask[i] |= TOUCH;
        }
    }

    /// Mark all cells crossed by segment `ab` (supercover DDA).
    ///
    /// The walk visits every cell between the endpoints, so the parts of the segment more
    /// than [`TOUCH_MARGIN`] cells outside the grid are clipped off first (otherwise
    /// geometry far outside the grid would take unbounded time and overflow the cell
    /// coordinates). Segments with a non-finite endpoint touch nothing.
    pub fn touch_segment(&mut self, a: P, b: P) {
        let (mut u0, mut v0) = self.spec.to_cell(a);
        let (mut u1, mut v1) = self.spec.to_cell(b);
        if !(u0.is_finite() && v0.is_finite() && u1.is_finite() && v1.is_finite()) {
            return;
        }
        let lo = -TOUCH_MARGIN;
        let hx = self.spec.cols as f64 + TOUCH_MARGIN;
        let hy = self.spec.rows as f64 + TOUCH_MARGIN;
        if !clip_slab(&mut u0, &mut v0, &mut u1, &mut v1, lo, hx)
            || !clip_slab(&mut v0, &mut u0, &mut v1, &mut u1, lo, hy)
        {
            return;
        }
        let cols = self.spec.cols as i64;
        let rows = self.spec.rows as i64;
        let mut cx = crate::math::floor_fast(u0) as i64;
        let mut cy = crate::math::floor_fast(v0) as i64;
        let ex = crate::math::floor_fast(u1) as i64;
        let ey = crate::math::floor_fast(v1) as i64;
        let dx = u1 - u0;
        let dy = v1 - v0;
        let stepx: i64 = if dx > 0.0 {
            1
        } else if dx < 0.0 {
            -1
        } else {
            0
        };
        let stepy: i64 = if dy > 0.0 {
            1
        } else if dy < 0.0 {
            -1
        } else {
            0
        };
        let tdx = if dx != 0.0 {
            (1.0 / dx).abs()
        } else {
            f64::INFINITY
        };
        let tdy = if dy != 0.0 {
            (1.0 / dy).abs()
        } else {
            f64::INFINITY
        };
        let mut tmx = if dx > 0.0 {
            ((cx + 1) as f64 - u0) / dx
        } else if dx < 0.0 {
            (u0 - cx as f64) / -dx
        } else {
            f64::INFINITY
        };
        let mut tmy = if dy > 0.0 {
            ((cy + 1) as f64 - v0) / dy
        } else if dy < 0.0 {
            (v0 - cy as f64) / -dy
        } else {
            f64::INFINITY
        };
        let max_steps = (ex - cx).abs() + (ey - cy).abs() + 2;
        for _ in 0..=max_steps {
            if cx >= 0 && cy >= 0 && cx < cols && cy < rows {
                let i = cy as usize * self.spec.cols + cx as usize;
                self.mask[i] |= TOUCH;
            }
            if cx == ex && cy == ey {
                break;
            }
            if tmx < tmy {
                tmx += tdx;
                cx += stepx;
            } else {
                tmy += tdy;
                cy += stepy;
            }
        }
    }

    /// Disc of radius `r` centered at `c`.
    pub fn disc(&mut self, c: P, r: f64) {
        self.touch_point(c);
        if r <= 0.0 {
            return;
        }
        let (j0, j1) = self.sample_row_range(c.y - r, c.y + r);
        let r2 = r * r;
        let mut j = j0;
        while j <= j1 {
            let dy = self.sample_y(j) - c.y;
            let h2 = r2 - dy * dy;
            if h2 >= 0.0 {
                let h = h2.sqrt();
                self.span(j, c.x - h, c.x + h);
            }
            j += 1;
        }
    }

    /// Axis-aligned rectangle.
    pub fn rect(&mut self, x0: f64, y0: f64, x1: f64, y1: f64) {
        self.touch_point(P::new((x0 + x1) * 0.5, (y0 + y1) * 0.5));
        self.touch_segment(P::new(x0, y0), P::new(x1, y0));
        self.touch_segment(P::new(x1, y0), P::new(x1, y1));
        self.touch_segment(P::new(x1, y1), P::new(x0, y1));
        self.touch_segment(P::new(x0, y1), P::new(x0, y0));
        let (j0, j1) = self.sample_row_range(y0, y1);
        let mut j = j0;
        while j <= j1 {
            let y = self.sample_y(j);
            if y >= y0 && y < y1 {
                self.span(j, x0, x1);
            }
            j += 1;
        }
    }

    /// Capsule: all points within `hw` of segment `ab` (a stroked line segment).
    pub fn capsule(&mut self, a: P, b: P, hw: f64) {
        self.touch_segment(a, b);
        if hw <= 0.0 {
            return;
        }
        let y0 = minf(a.y, b.y) - hw;
        let y1 = maxf(a.y, b.y) + hw;
        let (j0, j1) = self.sample_row_range(y0, y1);
        let d = b - a;
        let l = d.len();
        let h2 = hw * hw;
        let mut j = j0;
        while j <= j1 {
            let y = self.sample_y(j);
            let mut lo = f64::INFINITY;
            let mut hi = f64::NEG_INFINITY;
            // end discs
            for e in [a, b] {
                let dy = y - e.y;
                let q = h2 - dy * dy;
                if q >= 0.0 {
                    let s = q.sqrt();
                    lo = minf(lo, e.x - s);
                    hi = maxf(hi, e.x + s);
                }
            }
            // the band |cross(p - a, u)| <= hw, 0 <= dot(p - a, u) <= l
            if l > 0.0 {
                let ux = d.x / l;
                let uy = d.y / l;
                // p = (x, y): cross = (x-ax)*uy - (y-ay)*ux ; dot = (x-ax)*ux + (y-ay)*uy
                let ry = y - a.y;
                let mut xlo = f64::NEG_INFINITY;
                let mut xhi = f64::INFINITY;
                // |t*uy - ry*ux| <= hw with t = x - ax
                if uy != 0.0 {
                    let t1 = (-hw + ry * ux) / uy;
                    let t2 = (hw + ry * ux) / uy;
                    xlo = maxf(xlo, minf(t1, t2));
                    xhi = minf(xhi, maxf(t1, t2));
                } else if (ry * ux).abs() > hw {
                    xlo = 1.0;
                    xhi = 0.0;
                }
                // 0 <= t*ux + ry*uy <= l
                if ux != 0.0 {
                    let t1 = (0.0 - ry * uy) / ux;
                    let t2 = (l - ry * uy) / ux;
                    xlo = maxf(xlo, minf(t1, t2));
                    xhi = minf(xhi, maxf(t1, t2));
                } else {
                    let s = ry * uy;
                    if s < 0.0 || s > l {
                        xlo = 1.0;
                        xhi = 0.0;
                    }
                }
                if xhi >= xlo {
                    lo = minf(lo, xlo + a.x);
                    hi = maxf(hi, xhi + a.x);
                }
            }
            if hi > lo {
                self.span(j, lo, hi);
            }
            j += 1;
        }
    }

    /// Polygon fill (multi-ring, non-zero or even-odd) with an active edge list.
    pub fn polygon(&mut self, rings: &[Vec<P>], even_odd: bool) {
        struct Edge {
            ymin: f64,
            ymax: f64,
            x_at_ymin: f64,
            slope: f64,
            dir: i32,
        }
        let mut edges: Vec<Edge> = Vec::new();
        let mut ylo = f64::INFINITY;
        let mut yhi = f64::NEG_INFINITY;
        for ring in rings {
            let n = ring.len();
            if n < 2 {
                if let Some(&p) = ring.first() {
                    self.touch_point(p);
                }
                continue;
            }
            for i in 0..n {
                let a = ring[i];
                let b = ring[(i + 1) % n];
                self.touch_segment(a, b);
                if a.y == b.y {
                    continue;
                }
                let (top, bot, dir) = if a.y < b.y { (a, b, 1) } else { (b, a, -1) };
                ylo = minf(ylo, top.y);
                yhi = maxf(yhi, bot.y);
                edges.push(Edge {
                    ymin: top.y,
                    ymax: bot.y,
                    x_at_ymin: top.x,
                    slope: (bot.x - top.x) / (bot.y - top.y),
                    dir,
                });
            }
        }
        if edges.is_empty() {
            return;
        }
        crate::sort::sort_by(&mut edges, |p, q| crate::math::cmp_f64(p.ymin, q.ymin));
        let (j0, j1) = self.sample_row_range(ylo, yhi);
        let mut next = 0usize;
        let mut active: Vec<usize> = Vec::new();
        let mut xs: Vec<(f64, i32)> = Vec::new();
        let mut j = j0;
        while j <= j1 {
            let y = self.sample_y(j);
            while next < edges.len() && edges[next].ymin <= y {
                active.push(next);
                next += 1;
            }
            active.retain(|&e| edges[e].ymax > y);
            xs.clear();
            for &e in &active {
                let ed = &edges[e];
                if ed.ymin <= y && y < ed.ymax {
                    xs.push((ed.x_at_ymin + (y - ed.ymin) * ed.slope, ed.dir));
                }
            }
            crate::sort::sort_by(&mut xs, |p, q| {
                crate::math::cmp_f64(p.0, q.0).then(p.1.cmp(&q.1))
            });
            if even_odd {
                let mut k = 0;
                while k + 1 < xs.len() {
                    self.span(j, xs[k].0, xs[k + 1].0);
                    k += 2;
                }
            } else {
                let mut w = 0;
                let mut start = 0.0;
                for &(x, d) in &xs {
                    let before = w;
                    w += d;
                    if before == 0 && w != 0 {
                        start = x;
                    } else if before != 0 && w == 0 {
                        self.span(j, start, x);
                    }
                }
            }
            j += 1;
        }
    }

    /// Rasterize a mark shape (its true geometry; curved shapes via their outline).
    pub fn shape(&mut self, s: &Shape) {
        match s {
            Shape::Circle { c, r } => self.disc(*c, *r),
            Shape::Polygon(p) => self.polygon(&p.rings, p.even_odd),
            _ => {
                let o = s.outline();
                self.polygon(&[o], false);
            }
        }
    }

    /// Final `u8` coverage (0..255; touched cells without samples get 1).
    /// Adds everything rasterized into `o` (a raster of the same grid).
    pub fn or_from(&mut self, o: &MaskRaster) {
        debug_assert_eq!(self.mask.len(), o.mask.len());
        for (a, b) in self.mask.iter_mut().zip(&o.mask) {
            *a |= b;
        }
    }

    pub fn into_coverage(self) -> Vec<u8> {
        self.mask
            .iter()
            .map(|&m| {
                let s = (m & 0xFFFF).count_ones();
                if s > 0 {
                    quantize(s as f64 / 16.0)
                } else if m & TOUCH != 0 {
                    1
                } else {
                    0
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(cols: usize, rows: usize, cell: f64) -> GridSpec {
        GridSpec {
            ox: 0.0,
            oy: 0.0,
            cell,
            cols,
            rows,
        }
    }

    fn total(cov: &[u8]) -> f64 {
        cov.iter().map(|&v| v as f64 / 255.0).sum()
    }

    #[test]
    fn rect_coverage_exact_on_cells() {
        let mut m = MaskRaster::new(g(10, 10, 2.0));
        m.rect(2.0, 2.0, 6.0, 4.0);
        let cov = m.into_coverage();
        assert_eq!(cov[11], 255);
        assert_eq!(cov[12], 255);
        assert_eq!(cov[10], 0);
        // area 8 px² = 2 cells
        assert!((total(&cov) - 2.0).abs() < 0.05, "{}", total(&cov));
    }

    #[test]
    fn disc_area_close() {
        let mut m = MaskRaster::new(g(40, 40, 1.0));
        m.disc(P::new(20.0, 20.0), 10.0);
        let cov = m.into_coverage();
        let a = total(&cov);
        let exact = std::f64::consts::PI * 100.0;
        assert!((a - exact).abs() / exact < 0.03, "{a} vs {exact}");
    }

    #[test]
    fn thin_line_is_touched() {
        let mut m = MaskRaster::new(g(10, 10, 4.0));
        m.capsule(P::new(0.5, 13.0), P::new(39.0, 13.3), 0.01);
        let cov = m.into_coverage();
        for c in 0..10 {
            assert!(cov[3 * 10 + c] >= 1, "col {c}");
        }
    }

    #[test]
    fn capsule_area() {
        let mut m = MaskRaster::new(g(60, 60, 1.0));
        m.capsule(P::new(10.0, 10.0), P::new(50.0, 40.0), 3.0);
        let a = total(&m.into_coverage());
        let exact = 50.0 * 6.0 + std::f64::consts::PI * 9.0;
        assert!((a - exact).abs() / exact < 0.05, "{a} vs {exact}");
    }

    #[test]
    fn polygon_rules() {
        let outer = vec![
            P::new(0.0, 0.0),
            P::new(20.0, 0.0),
            P::new(20.0, 20.0),
            P::new(0.0, 20.0),
        ];
        let hole = vec![
            P::new(5.0, 5.0),
            P::new(15.0, 5.0),
            P::new(15.0, 15.0),
            P::new(5.0, 15.0),
        ];
        let mut m = MaskRaster::new(g(20, 20, 1.0));
        m.polygon(&[outer.clone(), hole.clone()], true);
        let a = total(&m.into_coverage());
        assert!((a - 300.0).abs() < 25.0, "{a}");
        let mut rev = hole;
        rev.reverse();
        let mut m = MaskRaster::new(g(20, 20, 1.0));
        m.polygon(&[outer, rev], false);
        let a = total(&m.into_coverage());
        assert!((a - 300.0).abs() < 25.0, "{a}");
    }

    #[test]
    fn far_outside_segments_are_clipped() {
        // Segments reaching far outside the grid used to walk every cell up to their
        // endpoints (unbounded time, i64 overflow); now they are clipped first and touch
        // the same cells as their part near the grid.
        let touched = |segs: &[(P, P)]| {
            let mut m = MaskRaster::new(g(10, 10, 1.0));
            for &(a, b) in segs {
                m.touch_segment(a, b);
            }
            m.into_coverage()
        };
        let far = touched(&[
            (P::new(-1e15, 5.5), P::new(1e15, 5.5)),
            (P::new(3.5, -1e300), P::new(3.5, 1e300)),
            (P::new(-1e12, -1e12 + 0.5), P::new(1e12, 1e12 + 0.5)),
        ]);
        let near = touched(&[
            (P::new(-1.5, 5.5), P::new(11.5, 5.5)),
            (P::new(3.5, -1.5), P::new(3.5, 11.5)),
            (P::new(-1.75, -1.25), P::new(11.75, 12.25)),
        ]);
        assert_eq!(far, near);
        for c in 0..10 {
            assert_eq!(far[5 * 10 + c], 1, "col {c}");
            assert_eq!(far[c * 10 + 3], 1, "row {c}");
        }
        // entirely outside, or with a non-finite endpoint: nothing
        let none = touched(&[
            (P::new(-1e9, -5.0), P::new(1e9, -5.0)),
            (P::new(f64::NEG_INFINITY, 5.0), P::new(5.0, 5.0)),
            (P::new(f64::NAN, 5.0), P::new(5.0, 5.0)),
        ]);
        assert!(none.iter().all(|&v| v == 0));
    }

    #[test]
    fn union_is_or() {
        let mut m = MaskRaster::new(g(4, 4, 4.0));
        m.rect(0.0, 0.0, 2.0, 4.0);
        m.rect(2.0, 0.0, 4.0, 4.0);
        m.rect(0.0, 0.0, 4.0, 4.0);
        let cov = m.into_coverage();
        assert_eq!(cov[0], 255);
    }
}
