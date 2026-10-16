//! Exact Euclidean distance transform (Felzenszwalb & Huttenlocher 2012) on the grid.

use super::GridSpec;
use crate::geom::P;

const INF: f64 = 1e20;

/// 1-D squared distance transform of `f` (lower envelope of parabolas).
fn dt1d(f: &[f64], d: &mut [f64], v: &mut [usize], z: &mut [f64]) {
    let n = f.len();
    if n == 0 {
        return;
    }
    let mut k = 0usize;
    v[0] = 0;
    z[0] = f64::NEG_INFINITY;
    z[1] = f64::INFINITY;
    for q in 1..n {
        let fq = f[q] + (q * q) as f64;
        let inter = |p: usize| (fq - (f[p] + (p * p) as f64)) / (2.0 * q as f64 - 2.0 * p as f64);
        let mut s = inter(v[k]);
        while s <= z[k] {
            k -= 1;
            s = inter(v[k]);
        }
        k += 1;
        v[k] = q;
        z[k] = s;
        z[k + 1] = f64::INFINITY;
    }
    k = 0;
    for (q, dq_out) in d.iter_mut().enumerate().take(n) {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let p = v[k];
        let dq = q as f64 - p as f64;
        *dq_out = dq * dq + f[p];
    }
}

/// Distance (in px) from every cell center to the nearest occupied cell center.
/// `occupied(i)` tells whether cell `i` (row-major) is an obstacle. Cells far from any
/// obstacle get a large value (≥ 1e9) when nothing is occupied.
pub fn distance_transform(g: &GridSpec, occupied: impl Fn(usize) -> bool) -> Vec<f64> {
    let (cols, rows) = (g.cols, g.rows);
    let mut grid = vec![INF; cols * rows];
    for (i, cell) in grid.iter_mut().enumerate() {
        if occupied(i) {
            *cell = 0.0;
        }
    }
    let n = cols.max(rows);
    let mut f = vec![0.0; n];
    let mut d = vec![0.0; n];
    let mut v = vec![0usize; n];
    let mut z = vec![0.0; n + 1];
    // columns: the squared distance to the nearest occupied cell of the column, by a
    // downward and an upward sweep over the rows (the 1-D transform of this binary
    // input: the same exact integers; columns without an occupied cell stay INF, which
    // the row pass treats like the envelope's ≥ 1e20 values)
    const NONE: usize = usize::MAX;
    let mut near = vec![NONE; cols];
    for r in 0..rows {
        let row = &mut grid[r * cols..(r + 1) * cols];
        for (c, cell) in row.iter_mut().enumerate() {
            if *cell == 0.0 {
                near[c] = r;
            } else if near[c] != NONE {
                let dr = (r - near[c]) as f64;
                *cell = dr * dr;
            }
        }
    }
    near.fill(NONE);
    for r in (0..rows).rev() {
        let row = &mut grid[r * cols..(r + 1) * cols];
        for (c, cell) in row.iter_mut().enumerate() {
            if *cell == 0.0 {
                near[c] = r;
            } else if near[c] != NONE {
                let dr = (near[c] - r) as f64;
                if dr * dr < *cell {
                    *cell = dr * dr;
                }
            }
        }
    }
    // rows
    for r in 0..rows {
        f[..cols].copy_from_slice(&grid[r * cols..(r + 1) * cols]);
        dt1d(&f[..cols], &mut d[..cols], &mut v, &mut z);
        for c in 0..cols {
            let sq = d[c];
            grid[r * cols + c] = if sq >= INF * 0.5 {
                1e9
            } else {
                sq.sqrt() * g.cell
            };
        }
    }
    grid
}

/// Local maxima of a distance transform (the free-space seeds of spec §4.7): cells with
/// clearance `min_v <= v < 1e9` that no 8-neighbour exceeds; on plateaus an equal
/// neighbour earlier in row-major order suppresses the cell. Returns
/// `(cell center, clearance, col, row)` in row-major order.
pub fn dt_maxima(g: &GridSpec, dt: &[f64], min_v: f64) -> Vec<(P, f64, usize, usize)> {
    let mut out = Vec::new();
    for r in 0..g.rows {
        for c in 0..g.cols {
            let v = dt[r * g.cols + c];
            if v < min_v || v >= 1e9 {
                continue;
            }
            let mut is_max = true;
            'n: for dr in -1i64..=1 {
                for dc in -1i64..=1 {
                    if dr == 0 && dc == 0 {
                        continue;
                    }
                    let (rr, cc) = (r as i64 + dr, c as i64 + dc);
                    if rr < 0 || cc < 0 || rr >= g.rows as i64 || cc >= g.cols as i64 {
                        continue;
                    }
                    let w = dt[rr as usize * g.cols + cc as usize];
                    if w > v || (w == v && (dr < 0 || (dr == 0 && dc < 0))) {
                        is_max = false;
                        break 'n;
                    }
                }
            }
            if is_max {
                out.push((g.cell_center(c, r), v, c, r));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maxima_of_two_obstacles() {
        // a row with obstacles at both ends: clearances 0 1 2 3 3 2 1 0; of the plateau
        // only the first cell is a seed
        let row = GridSpec {
            ox: 0.0,
            oy: 0.0,
            cell: 1.0,
            cols: 8,
            rows: 1,
        };
        let dt = distance_transform(&row, |i| i == 0 || i == 7);
        let m = dt_maxima(&row, &dt, 0.0);
        assert_eq!(m, vec![(P::new(3.5, 0.5), 3.0, 3, 0)]);
        // obstacles in opposite corners of a 9×5 grid: the clearance peaks along the
        // perpendicular bisector (5 cells at (5, 0) and (3, 4), √20 at (4, 2))
        let g = GridSpec {
            ox: 10.0,
            oy: 20.0,
            cell: 2.0,
            cols: 9,
            rows: 5,
        };
        let dt = distance_transform(&g, |i| i == 0 || i == 44);
        let m = dt_maxima(&g, &dt, 0.0);
        let cells: Vec<(usize, usize)> = m.iter().map(|s| (s.2, s.3)).collect();
        assert_eq!(cells, vec![(5, 0), (4, 2), (3, 4)]);
        for &(p, v, c, r) in &m {
            assert_eq!(p, g.cell_center(c, r));
            assert_eq!(v, dt[r * g.cols + c]);
        }
        assert_eq!(m[0].1, 10.0);
        // below the minimum clearance nothing is a seed; far values (empty grid) neither
        assert_eq!(dt_maxima(&g, &dt, 9.0).len(), 2);
        assert!(dt_maxima(&g, &dt, 100.0).is_empty());
        let far = distance_transform(&g, |_| false);
        assert!(dt_maxima(&g, &far, 0.0).is_empty());
    }

    #[test]
    fn matches_brute_force() {
        let g = GridSpec {
            ox: 0.0,
            oy: 0.0,
            cell: 2.0,
            cols: 13,
            rows: 9,
        };
        let occ: Vec<bool> = (0..g.cells()).map(|i| i % 17 == 3 || i == 50).collect();
        let dt = distance_transform(&g, |i| occ[i]);
        for r in 0..g.rows {
            for c in 0..g.cols {
                let mut best = f64::INFINITY;
                for (j, &o) in occ.iter().enumerate() {
                    if o {
                        let (cr, cc) = (j / g.cols, j % g.cols);
                        let dx = c as f64 - cc as f64;
                        let dy = r as f64 - cr as f64;
                        best = best.min((dx * dx + dy * dy).sqrt());
                    }
                }
                let v = dt[r * g.cols + c];
                assert!(
                    (v - best * 2.0).abs() < 1e-9,
                    "({c},{r}) {v} vs {}",
                    best * 2.0
                );
            }
        }
    }

    /// The two-pass parabola-envelope transform (columns, then rows) the column sweeps
    /// replace: identical results on random binary grids.
    #[test]
    fn column_sweeps_equal_the_envelope_pass() {
        fn reference(g: &GridSpec, occ: &[bool]) -> Vec<f64> {
            let (cols, rows) = (g.cols, g.rows);
            let mut grid: Vec<f64> = occ.iter().map(|&o| if o { 0.0 } else { INF }).collect();
            let n = cols.max(rows);
            let (mut f, mut d) = (vec![0.0; n], vec![0.0; n]);
            let (mut v, mut z) = (vec![0usize; n], vec![0.0; n + 1]);
            for c in 0..cols {
                for r in 0..rows {
                    f[r] = grid[r * cols + c];
                }
                dt1d(&f[..rows], &mut d[..rows], &mut v, &mut z);
                for r in 0..rows {
                    grid[r * cols + c] = d[r];
                }
            }
            for r in 0..rows {
                f[..cols].copy_from_slice(&grid[r * cols..(r + 1) * cols]);
                dt1d(&f[..cols], &mut d[..cols], &mut v, &mut z);
                for c in 0..cols {
                    let sq = d[c];
                    grid[r * cols + c] = if sq >= INF * 0.5 {
                        1e9
                    } else {
                        sq.sqrt() * g.cell
                    };
                }
            }
            grid
        }
        let mut x = 0x2545_F491_4F6C_DD1Du64;
        let mut next = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        for case in 0..300 {
            let cols = 1 + (next() % 160) as usize;
            let rows = 1 + (next() % 160) as usize;
            // densities from empty to full, and long free columns (rows up to 160)
            let density = [0, 1, 2, 5, 20, 50, 90, 100][case % 8];
            let occ: Vec<bool> = (0..cols * rows).map(|_| (next() % 100) < density).collect();
            let g = GridSpec {
                ox: 0.0,
                oy: 0.0,
                cell: 2.5,
                cols,
                rows,
            };
            let got = distance_transform(&g, |i| occ[i]);
            assert_eq!(
                got,
                reference(&g, &occ),
                "case {case}: {cols} x {rows}, {density} %"
            );
        }
    }

    #[test]
    fn empty_grid_is_far() {
        let g = GridSpec {
            ox: 0.0,
            oy: 0.0,
            cell: 1.0,
            cols: 4,
            rows: 3,
        };
        let dt = distance_transform(&g, |_| false);
        assert!(dt.iter().all(|&v| v >= 1e9));
    }
}
