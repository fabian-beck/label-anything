//! Exact Euclidean distance transform (Felzenszwalb & Huttenlocher 2012) on the grid.

use super::GridSpec;

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
    // columns
    for c in 0..cols {
        for r in 0..rows {
            f[r] = grid[r * cols + c];
        }
        dt1d(&f[..rows], &mut d[..rows], &mut v, &mut z);
        for r in 0..rows {
            grid[r * cols + c] = d[r];
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

#[cfg(test)]
mod tests {
    use super::*;

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
