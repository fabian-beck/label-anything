//! The region map (spec §4.8, ADR obstacles/regions): the region each grid cell lies in, the borders
//! between regions, and what a label box or a leader has of them.

use super::{GridSpec, Sat};
use crate::geom::{Rect, P};
use crate::math::{ceil_fast, floor_fast, maxf, minf};

/// A fill of the region map: `region` 0 is open space, `k` the `k`-th region.
#[derive(Clone, Debug)]
pub struct RegionFill {
    pub region: u32,
    pub rings: Vec<Vec<P>>,
    pub even_odd: bool,
}

/// The regions of the grid cells and the cells on borders.
#[derive(Clone, Debug)]
pub struct RegionMap {
    pub grid: GridSpec,
    /// The region of every cell, row-major (0 = open).
    pub ids: Vec<u32>,
    /// Cells with a 4-neighbour in another region (summed-area table of 0/1 flags).
    border: Sat,
}

/// The areas of a box in the regions it overlaps, in cells (see [`RegionMap::split`]).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Split {
    /// The box's area on the grid, `A = Σ a_r`.
    pub area: f64,
    /// `Σ a_r²`.
    pub squares: f64,
    /// The area in regions other than open space and the home region.
    pub foreign: f64,
}

impl Split {
    /// `4 · Σ_{r<s} a_r · a_s / A = 2 · (A² − Σ a_r²) / A`: the box's area for a box half
    /// in one region and half in another, nothing for a box in one region.
    pub fn straddle(&self) -> f64 {
        if self.area > 0.0 {
            maxf(
                2.0 * (self.area * self.area - self.squares) / self.area,
                0.0,
            )
        } else {
            0.0
        }
    }
}

impl RegionMap {
    /// The map of `fills`, painted in order onto open cells (a cell takes the region of the
    /// last fill covering its centre); `None` without fills.
    pub fn new(grid: GridSpec, fills: &[RegionFill]) -> Option<RegionMap> {
        if fills.is_empty() {
            return None;
        }
        let mut ids = vec![0u32; grid.cells()];
        for f in fills {
            paint(&grid, &mut ids, f);
        }
        let (cols, rows) = (grid.cols, grid.rows);
        let mut flags = vec![0u8; grid.cells()];
        for r in 0..rows {
            for c in 0..cols {
                let k = r * cols + c;
                if c + 1 < cols && ids[k] != ids[k + 1] {
                    flags[k] = 1;
                    flags[k + 1] = 1;
                }
                if r + 1 < rows && ids[k] != ids[k + cols] {
                    flags[k] = 1;
                    flags[k + cols] = 1;
                }
            }
        }
        Some(RegionMap {
            grid,
            ids,
            border: Sat::from_coverage(cols, rows, &flags),
        })
    }

    /// The region of the cell containing `p` (open outside the grid).
    pub fn at(&self, p: P) -> u32 {
        let (u, v) = self.grid.to_cell(p);
        if u >= 0.0 && v >= 0.0 && u < self.grid.cols as f64 && v < self.grid.rows as f64 {
            self.ids[v as usize * self.grid.cols + u as usize]
        } else {
            0
        }
    }

    /// The home region of an item (spec §4.8): the region of the cell containing its
    /// reference point `at`; when that is open, the region of most cells among those the
    /// mark's bounding box `bbox` grown by one cell touches (ties: the lower region), else
    /// open.
    pub fn home(&self, at: P, bbox: &Rect) -> u32 {
        let r = self.at(at);
        if r != 0 {
            return r;
        }
        let g = &self.grid;
        let (c0, c1, r0, r1) = g.cell_range(&bbox.inflate(g.cell));
        let mut counts: Vec<(u32, u32)> = Vec::new();
        for row in r0..r1 {
            for col in c0..c1 {
                let id = self.ids[row * g.cols + col];
                if id == 0 {
                    continue;
                }
                match counts.iter_mut().find(|e| e.0 == id) {
                    Some(e) => e.1 += 1,
                    None => counts.push((id, 1)),
                }
            }
        }
        let mut best = (0u32, 0u32);
        for &(id, n) in &counts {
            if n > best.1 || (n == best.1 && id < best.0) {
                best = (id, n);
            }
        }
        best.0
    }

    /// The areas of `rect` in the regions (in cells: the exact overlap of the box with each
    /// cell, summed by the cell's region, row by row), for an item at home in `home`.
    /// `scratch` holds the per-region sums.
    pub fn split(&self, rect: &Rect, home: u32, scratch: &mut Vec<(u32, f64)>) -> Split {
        let g = &self.grid;
        let (cols, rows) = (g.cols as f64, g.rows as f64);
        let (u0, v0) = g.to_cell(P::new(rect.x0, rect.y0));
        let (u1, v1) = g.to_cell(P::new(rect.x1, rect.y1));
        let (u0, u1) = (clamp(u0, cols), clamp(u1, cols));
        let (v0, v1) = (clamp(v0, rows), clamp(v1, rows));
        if u1 <= u0 || v1 <= v0 {
            return Split::default();
        }
        // cells with positive overlap: [c0, c1) × [r0, r1)
        let c0 = u0 as usize;
        let r0 = v0 as usize;
        let c1 = ceil_fast(u1) as usize;
        let r1 = ceil_fast(v1) as usize;
        if self.border.block(c0, c1, r0, r1) == 0 {
            // no border: one region
            let area = (u1 - u0) * (v1 - v0);
            let id = self.ids[r0 * g.cols + c0];
            return Split {
                area,
                squares: area * area,
                foreign: if id != 0 && id != home { area } else { 0.0 },
            };
        }
        scratch.clear();
        let mut area = 0.0;
        for row in r0..r1 {
            let wy = minf(v1, (row + 1) as f64) - maxf(v0, row as f64);
            for col in c0..c1 {
                let wx = minf(u1, (col + 1) as f64) - maxf(u0, col as f64);
                let w = wx * wy;
                area += w;
                let id = self.ids[row * g.cols + col];
                match scratch.iter_mut().find(|e| e.0 == id) {
                    Some(e) => e.1 += w,
                    None => scratch.push((id, w)),
                }
            }
        }
        let mut squares = 0.0;
        let mut foreign = 0.0;
        for &(id, a) in scratch.iter() {
            squares += a * a;
            if id != 0 && id != home {
                foreign += a;
            }
        }
        Split {
            area,
            squares,
            foreign,
        }
    }

    /// The region borders the polyline `pts` crosses: its vertices and the points dividing
    /// each segment into `max(1, ceil(length / cell))` equal steps, in order, and the number
    /// of consecutive ones in different regions.
    pub fn crossings(&self, pts: &[P]) -> u32 {
        let Some(&first) = pts.first() else {
            return 0;
        };
        let mut prev = self.at(first);
        let mut n = 0;
        for w in pts.windows(2) {
            let (a, b) = (w[0], w[1]);
            let steps = maxf(ceil_fast(a.dist(b) / self.grid.cell), 1.0);
            let k_max = if steps.is_finite() { steps as u32 } else { 1 };
            for k in 1..=k_max {
                let r = self.at(a.lerp(b, f64::from(k) / f64::from(k_max)));
                if r != prev {
                    n += 1;
                    prev = r;
                }
            }
        }
        n
    }
}

#[inline]
fn clamp(v: f64, n: f64) -> f64 {
    if v < 0.0 {
        0.0
    } else if v > n {
        n
    } else {
        v
    }
}

/// Paint `fill` onto the cells whose centres it covers (its fill rule; an active edge list
/// per cell row, as the coverage rasterizer does per sample row).
fn paint(g: &GridSpec, ids: &mut [u32], fill: &RegionFill) {
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
    for ring in &fill.rings {
        let n = ring.len();
        if n < 3 {
            continue;
        }
        for i in 0..n {
            let a = ring[i];
            let b = ring[(i + 1) % n];
            if a.y == b.y || !(a.is_finite() && b.is_finite()) {
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
    // rows whose centre lies in [ylo, yhi]
    let rows = g.rows as f64;
    let j0 = maxf(ceil_fast((ylo - g.oy) / g.cell - 0.5), 0.0);
    let j1 = minf(floor_fast((yhi - g.oy) / g.cell - 0.5), rows - 1.0);
    if j0 > j1 {
        return;
    }
    let (j0, j1) = (j0 as usize, j1 as usize);
    let mut next = 0usize;
    let mut active: Vec<usize> = Vec::new();
    let mut xs: Vec<(f64, i32)> = Vec::new();
    for j in j0..=j1 {
        let y = g.oy + (j as f64 + 0.5) * g.cell;
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
        if fill.even_odd {
            let mut k = 0;
            while k + 1 < xs.len() {
                span(g, ids, j, xs[k].0, xs[k + 1].0, fill.region);
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
                    span(g, ids, j, start, x, fill.region);
                }
            }
        }
    }
}

/// Set the cells of row `j` whose centre x lies in `[xa, xb)`.
fn span(g: &GridSpec, ids: &mut [u32], j: usize, xa: f64, xb: f64, region: u32) {
    if xb <= xa {
        return;
    }
    let cols = g.cols as f64;
    let k0 = maxf(ceil_fast((xa - g.ox) / g.cell - 0.5), 0.0);
    let k1 = minf(ceil_fast((xb - g.ox) / g.cell - 0.5), cols);
    if k1 <= k0 {
        return;
    }
    let row = &mut ids[j * g.cols..(j + 1) * g.cols];
    for id in &mut row[k0 as usize..k1 as usize] {
        *id = region;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(cols: usize, rows: usize) -> GridSpec {
        GridSpec {
            ox: 0.0,
            oy: 0.0,
            cell: 1.0,
            cols,
            rows,
        }
    }

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64, region: u32) -> RegionFill {
        RegionFill {
            region,
            rings: vec![vec![
                P::new(x0, y0),
                P::new(x1, y0),
                P::new(x1, y1),
                P::new(x0, y1),
            ]],
            even_odd: false,
        }
    }

    #[test]
    fn painting_and_borders() {
        // two regions side by side on open space, a third over part of the first, then an
        // open hole
        let m = RegionMap::new(
            grid(10, 4),
            &[
                rect(0.0, 0.0, 4.0, 4.0, 1),
                rect(4.0, 0.0, 8.0, 4.0, 2),
                rect(2.0, 0.0, 3.0, 2.0, 3),
                rect(6.0, 1.0, 7.0, 2.0, 0),
            ],
        )
        .unwrap();
        let row0: Vec<u32> = m.ids[0..10].to_vec();
        assert_eq!(row0, [1, 1, 3, 1, 2, 2, 2, 2, 0, 0]);
        let row1: Vec<u32> = m.ids[10..20].to_vec();
        assert_eq!(row1, [1, 1, 3, 1, 2, 2, 0, 2, 0, 0]);
        assert_eq!(m.at(P::new(2.5, 3.5)), 1);
        assert_eq!(m.at(P::new(-1.0, 1.0)), 0);
        // a box inside region 1 (no border cell): one region
        let mut s = Vec::new();
        let b = m.split(&Rect::new(0.0, 2.0, 2.0, 4.0), 1, &mut s);
        assert_eq!(b.area, 4.0);
        assert_eq!(b.straddle(), 0.0);
        assert_eq!(b.foreign, 0.0);
        // half in 1, half in 2: the straddle is the box's area, the foreign part half of it
        let b = m.split(&Rect::new(3.0, 2.0, 5.0, 4.0), 1, &mut s);
        assert_eq!(b.area, 4.0);
        assert!((b.straddle() - 4.0).abs() < 1e-12, "{b:?}");
        assert_eq!(b.foreign, 2.0);
        // half in 2, half open: nothing foreign for an item at home in 2
        let b = m.split(&Rect::new(7.0, 2.0, 9.0, 3.0), 2, &mut s);
        assert_eq!(b.foreign, 0.0);
        assert!((b.straddle() - 2.0).abs() < 1e-12);
        // fractional overlap: a quarter of a cell of region 2 under a box in region 1
        let b = m.split(&Rect::new(3.0, 2.0, 4.5, 2.5), 1, &mut s);
        assert!((b.area - 0.75).abs() < 1e-12);
        assert!((b.foreign - 0.25).abs() < 1e-12);
        let want = 4.0 * 0.5 * 0.25 / 0.75;
        assert!((b.straddle() - want).abs() < 1e-12);
        // leaders: 1 → 3 → 1 → 2 → open along row 0
        assert_eq!(m.crossings(&[P::new(0.5, 0.5), P::new(9.5, 0.5)]), 4);
        assert_eq!(m.crossings(&[P::new(0.5, 3.5), P::new(1.5, 3.5)]), 0);
        assert_eq!(m.crossings(&[P::new(0.5, 3.5)]), 0);
    }

    #[test]
    fn home_falls_back_to_the_regions_under_the_mark() {
        let m = RegionMap::new(
            grid(10, 10),
            &[rect(0.0, 0.0, 4.0, 10.0, 1), rect(6.0, 0.0, 10.0, 10.0, 2)],
        )
        .unwrap();
        assert_eq!(m.home(P::new(1.5, 5.0), &Rect::new(1.0, 4.5, 2.0, 5.5)), 1);
        // open at the point: the mark's box grown by a cell reaches 4 cells of region 1
        // (column 3) and none of region 2
        assert_eq!(m.home(P::new(4.5, 5.0), &Rect::new(4.2, 4.8, 4.8, 5.2)), 1);
        // in the middle: equal counts, the lower region
        assert_eq!(m.home(P::new(5.0, 5.0), &Rect::new(4.5, 4.5, 5.5, 5.5)), 1);
        // far from everything
        let m = RegionMap::new(grid(10, 10), &[rect(0.0, 0.0, 2.0, 2.0, 1)]).unwrap();
        assert_eq!(m.home(P::new(8.0, 8.0), &Rect::new(7.5, 7.5, 8.5, 8.5)), 0);
    }

    #[test]
    fn fill_rules() {
        let ring = |x0: f64, y0: f64, x1: f64, y1: f64| {
            vec![
                P::new(x0, y0),
                P::new(x1, y0),
                P::new(x1, y1),
                P::new(x0, y1),
            ]
        };
        // a hole wound like the outer ring: kept by non-zero, cut by even-odd
        let rings = vec![ring(0.0, 0.0, 6.0, 6.0), ring(2.0, 2.0, 4.0, 4.0)];
        let nz = RegionMap::new(
            grid(6, 6),
            &[RegionFill {
                region: 1,
                rings: rings.clone(),
                even_odd: false,
            }],
        )
        .unwrap();
        assert_eq!(nz.ids[2 * 6 + 2], 1);
        let eo = RegionMap::new(
            grid(6, 6),
            &[RegionFill {
                region: 1,
                rings,
                even_odd: true,
            }],
        )
        .unwrap();
        assert_eq!(eo.ids[2 * 6 + 2], 0);
        assert_eq!(eo.ids[0], 1);
    }

    #[test]
    fn no_fills_no_map() {
        assert!(RegionMap::new(grid(4, 4), &[]).is_none());
    }
}
