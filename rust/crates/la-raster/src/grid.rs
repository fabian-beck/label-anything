//! Area averaging of per-pixel values into a coverage grid (spec §4.6), quantization and
//! dilation. The arithmetic is specified exactly and mirrored by the TypeScript code.
//!
//! Raster pixel `(px, py)` covers the canvas square
//! `[ox + px/s, ox + (px+1)/s) × [oy + py/s, oy + (py+1)/s)` and grid cell `(gx, gy)` the
//! square `[x0 + gx·c, x0 + (gx+1)·c) × [y0 + gy·c, y0 + (gy+1)·c)`. Along each axis the
//! weight of a (pixel, cell) pair is `overlap / c` with
//! `overlap = min(p1, g1) − max(p0, g0)`, kept only when `overlap > 0`. With per-pixel
//! values `v`, the coverage of a cell is the nested sum
//!
//! ```text
//! h[py][gx]   = Σ over px ascending:  h + v(px, py) · wx(px, gx)      (h starts at +0)
//! cov[gy][gx] = Σ over py ascending:  cov + wy(py, gy) · h[py][gx]    (cov starts at +0)
//! ```
//!
//! i.e. raster rows are first resampled horizontally, then accumulated vertically, both
//! in ascending pixel order (adding a zero term never changes a sum, so implementations
//! may skip zero values). It is quantized with [`quantize`].

/// The coverage grid geometry in canvas pixels: `cols × rows` square cells of size `cell`
/// whose top-left corner is `(origin_x, origin_y)`. Coverage arrays are row-major.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GridSpec {
    /// Canvas x of the grid's left edge.
    pub origin_x: f64,
    /// Canvas y of the grid's top edge.
    pub origin_y: f64,
    /// Cell size in canvas pixels (> 0).
    pub cell: f64,
    /// Number of columns.
    pub cols: usize,
    /// Number of rows.
    pub rows: usize,
}

impl GridSpec {
    /// `cols * rows`, or `None` if the product overflows `usize`.
    pub fn cell_count(&self) -> Option<usize> {
        self.cols.checked_mul(self.rows)
    }
}

/// Where a raster lies on the canvas: `scale` raster pixels per canvas pixel (2 = HiDPI:
/// a 1600×1200 image covers an 800×600 canvas) and the canvas position of the raster's
/// top-left corner.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RasterPlacement {
    /// Raster pixels per canvas pixel (> 0).
    pub scale: f64,
    /// Canvas position `[x, y]` of the raster's top-left corner.
    pub offset: [f64; 2],
}

impl Default for RasterPlacement {
    /// Scale 1 at the canvas origin (the spec defaults).
    fn default() -> Self {
        Self {
            scale: 1.0,
            offset: [0.0, 0.0],
        }
    }
}

/// `min` with plain comparisons (same result as the TypeScript code for every input).
#[inline]
fn fmin(a: f64, b: f64) -> f64 {
    if a < b {
        a
    } else {
        b
    }
}

/// `max` with plain comparisons (same result as the TypeScript code for every input).
#[inline]
fn fmax(a: f64, b: f64) -> f64 {
    if a > b {
        a
    } else {
        b
    }
}

/// Overlap weights between the pixels of one raster axis and the cells of one grid axis.
#[derive(Debug)]
pub(crate) struct Axis {
    /// `cells[offs[i]..offs[i + 1]]` (ascending) and `weights[..]` belong to pixel `i`.
    offs: Vec<usize>,
    cells: Vec<u32>,
    weights: Vec<f64>,
    /// Pixels `lo..hi` contain every pixel with at least one pair (`lo == hi`: none).
    pub(crate) lo: usize,
    pub(crate) hi: usize,
    /// Largest `last cell − first cell + 1` of any pixel.
    pub(crate) span: usize,
    /// The same weights in two-cell form, if every pixel overlaps at most two adjacent
    /// cells (pixels no wider than a cell): pixel `i` adds `w0[i]` to cell `c0[i]` and
    /// `w1[i]` to cell `c0[i] + 1` (0 when there is no second cell; adding `+0.0` to a
    /// non-negative sum leaves it unchanged, so this is identical to the general form).
    two: Option<TwoCells>,
}

#[derive(Debug)]
struct TwoCells {
    c0: Vec<u32>,
    w0: Vec<f64>,
    w1: Vec<f64>,
}

impl TwoCells {
    fn from_pairs(offs: &[usize], cells: &[u32], weights: &[f64]) -> Option<Self> {
        let n = offs.len() - 1;
        let mut c0 = Vec::with_capacity(n);
        let mut w0 = Vec::with_capacity(n);
        let mut w1 = Vec::with_capacity(n);
        let mut prev = 0u32;
        for i in 0..n {
            let (a, b) = (offs[i], offs[i + 1]);
            match b - a {
                0 => {
                    c0.push(prev);
                    w0.push(0.0);
                    w1.push(0.0);
                }
                1 => {
                    prev = cells[a];
                    c0.push(prev);
                    w0.push(weights[a]);
                    w1.push(0.0);
                }
                2 if cells[a + 1] == cells[a] + 1 => {
                    prev = cells[a];
                    c0.push(prev);
                    w0.push(weights[a]);
                    w1.push(weights[a + 1]);
                }
                _ => return None,
            }
        }
        Some(Self { c0, w0, w1 })
    }
}

impl Axis {
    /// Builds the weights of `n_px` pixels starting at canvas coordinate `offset` with
    /// `scale` pixels per canvas pixel against `n_cells` cells of size `cell` from `origin`.
    /// All inputs must be finite, `scale > 0`, `cell > 0` and `n_cells ≤ u32::MAX`.
    pub(crate) fn new(
        n_px: usize,
        offset: f64,
        scale: f64,
        origin: f64,
        cell: f64,
        n_cells: usize,
    ) -> Self {
        let mut offs = Vec::with_capacity(n_px + 1);
        let mut cells = Vec::new();
        let mut weights = Vec::new();
        let (mut lo, mut hi, mut span) = (n_px, 0, 0);
        offs.push(0);
        for i in 0..n_px {
            let p0 = offset + (i as f64) / scale;
            let p1 = offset + ((i + 1) as f64) / scale;
            let start = cells.len();
            if n_cells > 0 {
                // A first candidate cell; it only affects speed, not the result.
                let t = ((p0 - origin) / cell).floor();
                let mut j = if t > 0.0 {
                    if t < (n_cells - 1) as f64 {
                        t as usize
                    } else {
                        n_cells - 1
                    }
                } else {
                    0
                };
                // Step back while the previous cell still ends after p0.
                while j > 0 && origin + (j as f64) * cell > p0 {
                    j -= 1;
                }
                while j < n_cells {
                    let g0 = origin + (j as f64) * cell;
                    if g0 >= p1 {
                        break;
                    }
                    let g1 = origin + ((j + 1) as f64) * cell;
                    let overlap = fmin(p1, g1) - fmax(p0, g0);
                    if overlap > 0.0 {
                        cells.push(j as u32);
                        weights.push(overlap / cell);
                    }
                    j += 1;
                }
            }
            if cells.len() > start {
                lo = lo.min(i);
                hi = i + 1;
                span = span.max((cells[cells.len() - 1] - cells[start]) as usize + 1);
            }
            offs.push(cells.len());
        }
        if hi == 0 {
            lo = 0;
        }
        let two = TwoCells::from_pairs(&offs, &cells, &weights);
        Self {
            offs,
            cells,
            weights,
            lo,
            hi,
            span,
            two,
        }
    }

    /// The `(cell, weight)` index range of pixel `i`.
    #[inline]
    fn range(&self, i: usize) -> (usize, usize) {
        (self.offs[i], self.offs[i + 1])
    }
}

/// Quantizes a coverage fraction: `q = floor(cov·255 + 1/2)` clamped to 255; a positive
/// coverage never quantizes to 0 (it becomes 1). (`t as u8` truncates, which equals
/// `floor` for `1 ≤ t < 255`.)
#[inline]
pub(crate) fn quantize(cov: f64) -> u8 {
    let t = cov * 255.0 + 0.5;
    if t >= 255.0 {
        255
    } else if t >= 1.0 {
        t as u8
    } else if cov > 0.0 {
        1
    } else {
        0
    }
}

const NO_ROW: usize = usize::MAX;
const NO_PX: usize = usize::MAX;

/// Streams raster rows (ascending) into `k` coverage grids with exactly the summation order
/// of the module documentation. Only the grid rows touched by the current raster row are
/// kept as `f64` accumulators (a ring of `rows.span` rows); finished rows are quantized.
pub(crate) struct Resampler<'a> {
    cols: &'a Axis,
    rows: &'a Axis,
    gcols: usize,
    grows: usize,
    k: usize,
    cap: usize,
    /// `cap × k × gcols` accumulators; slot `gy % cap` holds grid row `slot_row[slot]`.
    acc: Vec<f64>,
    slot_row: Vec<usize>,
    /// `k` rows of `gcols + 1` horizontal sums of the current raster row (one padding cell
    /// for the two-cell form), and per class the first and last pixel added to them.
    h: Vec<f64>,
    first_px: Vec<usize>,
    last_px: Vec<usize>,
    out: Vec<Vec<u8>>,
    /// Grid rows below this one are final.
    next_final: usize,
}

impl<'a> Resampler<'a> {
    pub(crate) fn new(
        cols: &'a Axis,
        rows: &'a Axis,
        gcols: usize,
        grows: usize,
        k: usize,
    ) -> Self {
        let cap = rows.span.max(1);
        Self {
            cols,
            rows,
            gcols,
            grows,
            k,
            cap,
            acc: vec![0.0; cap * k * gcols],
            slot_row: vec![NO_ROW; cap],
            h: vec![0.0; k * (gcols + 1)],
            first_px: vec![NO_PX; k],
            last_px: vec![0; k],
            out: vec![vec![0; gcols * grows]; k],
            next_final: 0,
        }
    }

    /// Starts raster row `py`; returns `false` (skip the row) if it touches no grid row.
    pub(crate) fn begin_row(&mut self, py: usize) -> bool {
        let (a, b) = self.rows.range(py);
        if a == b {
            return false;
        }
        // Rows are monotone: grid rows above this row's first one receive nothing more.
        let first = self.rows.cells[a] as usize;
        while self.next_final < first {
            self.finalize(self.next_final);
            self.next_final += 1;
        }
        true
    }

    /// Adds value `v` of pixel `px` to class `class` (`h += v · w`).
    #[inline(always)]
    pub(crate) fn add(&mut self, class: usize, px: usize, v: f64) {
        let stride = self.gcols + 1;
        let h = &mut self.h[class * stride..(class + 1) * stride];
        if let Some(two) = &self.cols.two {
            let c = two.c0[px] as usize;
            h[c] += v * two.w0[px];
            h[c + 1] += v * two.w1[px];
        } else {
            let (a, b) = self.cols.range(px);
            if a == b {
                return;
            }
            for (&cell, &w) in self.cols.cells[a..b].iter().zip(&self.cols.weights[a..b]) {
                h[cell as usize] += v * w;
            }
        }
        self.note(class, px);
    }

    /// Adds value 1 of pixel `px` to class `class` (`h += w`; identical to `add(.., 1.0)`).
    #[inline(always)]
    pub(crate) fn add_one(&mut self, class: usize, px: usize) {
        let stride = self.gcols + 1;
        let h = &mut self.h[class * stride..(class + 1) * stride];
        if let Some(two) = &self.cols.two {
            let c = two.c0[px] as usize;
            h[c] += two.w0[px];
            h[c + 1] += two.w1[px];
        } else {
            let (a, b) = self.cols.range(px);
            if a == b {
                return;
            }
            for (&cell, &w) in self.cols.cells[a..b].iter().zip(&self.cols.weights[a..b]) {
                h[cell as usize] += w;
            }
        }
        self.note(class, px);
    }

    /// Records that pixel `px` (ascending within a row) touched class `class`.
    #[inline(always)]
    fn note(&mut self, class: usize, px: usize) {
        if self.first_px[class] == NO_PX {
            self.first_px[class] = px;
        }
        self.last_px[class] = px;
    }

    /// The cells `lo..hi` of class `class` that the current row may have touched.
    fn dirty(&self, class: usize) -> (usize, usize) {
        let (first, last) = (self.first_px[class], self.last_px[class]);
        if let Some(two) = &self.cols.two {
            let lo = two.c0[first] as usize;
            (lo, (two.c0[last] as usize + 2).min(self.gcols))
        } else {
            let lo = self.cols.cells[self.cols.offs[first]] as usize;
            (
                lo,
                self.cols.cells[self.cols.offs[last + 1] - 1] as usize + 1,
            )
        }
    }

    /// Ends raster row `py`: `cov[gy][gx] += wy · h[gx]` for its grid rows, then clears `h`.
    pub(crate) fn end_row(&mut self, py: usize) {
        let (a, b) = self.rows.range(py);
        let stride = self.gcols + 1;
        for class in 0..self.k {
            if self.first_px[class] == NO_PX {
                continue;
            }
            let (lo, hi) = self.dirty(class);
            let hrow = class * stride;
            for t in a..b {
                let gy = self.rows.cells[t] as usize;
                let wy = self.rows.weights[t];
                let slot = gy % self.cap;
                if self.slot_row[slot] != gy {
                    if self.slot_row[slot] != NO_ROW {
                        // Unreachable for monotone axes; flushing keeps it correct anyway.
                        self.finalize(self.slot_row[slot]);
                    }
                    self.slot_row[slot] = gy;
                }
                let base = (slot * self.k + class) * self.gcols;
                let acc = &mut self.acc[base + lo..base + hi];
                let h = &self.h[hrow + lo..hrow + hi];
                for (c, &v) in acc.iter_mut().zip(h) {
                    *c += wy * v;
                }
            }
            // Clear the touched cells, including the padding cell of the two-cell form.
            self.h[hrow + lo..hrow + stride.min(hi + 1)].fill(0.0);
            self.first_px[class] = NO_PX;
        }
    }

    /// Quantizes grid row `gy` (if it holds data) and frees its slot.
    fn finalize(&mut self, gy: usize) {
        let slot = gy % self.cap;
        if self.slot_row[slot] != gy {
            return;
        }
        for class in 0..self.k {
            let base = (slot * self.k + class) * self.gcols;
            let acc = &mut self.acc[base..base + self.gcols];
            let out = &mut self.out[class][gy * self.gcols..(gy + 1) * self.gcols];
            for (o, c) in out.iter_mut().zip(acc.iter_mut()) {
                *o = quantize(*c);
                *c = 0.0;
            }
        }
        self.slot_row[slot] = NO_ROW;
    }

    /// Finalizes all remaining rows and returns the `k` quantized grids.
    pub(crate) fn finish(mut self) -> Vec<Vec<u8>> {
        while self.next_final < self.grows {
            self.finalize(self.next_final);
            self.next_final += 1;
        }
        self.out
    }
}

/// Clamped sliding-window maximum of radius `r` over `line` into `res` (O(n) for any `r`).
fn window_max(line: &[u8], r: usize, res: &mut [u8], dq: &mut [usize]) {
    let n = line.len();
    let (mut head, mut tail, mut next) = (0usize, 0usize, 0usize);
    for (i, out) in res.iter_mut().enumerate().take(n) {
        let hi = i.saturating_add(r).min(n - 1);
        while next <= hi {
            let v = line[next];
            while tail > head && line[dq[tail - 1]] <= v {
                tail -= 1;
            }
            dq[tail] = next;
            tail += 1;
            next += 1;
        }
        let lo = i.saturating_sub(r);
        while dq[head] < lo {
            head += 1;
        }
        *out = line[dq[head]];
    }
}

/// One clamped 3-wide maximum along every row, in place.
fn max3_rows(grid: &mut [u8], cols: usize, tmp: &mut [u8]) {
    if cols < 2 {
        return;
    }
    for row in grid.chunks_exact_mut(cols) {
        tmp.copy_from_slice(row);
        row[0] = tmp[0].max(tmp[1]);
        for x in 1..cols - 1 {
            row[x] = tmp[x - 1].max(tmp[x]).max(tmp[x + 1]);
        }
        row[cols - 1] = tmp[cols - 2].max(tmp[cols - 1]);
    }
}

/// One clamped 3-tall maximum along every column, in place, processed row by row.
fn max3_cols(grid: &mut [u8], cols: usize, rows: usize, prev: &mut [u8], cur: &mut [u8]) {
    if rows < 2 {
        return;
    }
    prev.copy_from_slice(&grid[..cols]);
    for y in 0..rows {
        let start = y * cols;
        cur.copy_from_slice(&grid[start..start + cols]);
        let (head, tail) = grid.split_at_mut(start + cols);
        let row = &mut head[start..];
        if y + 1 < rows {
            let next = &tail[..cols];
            for x in 0..cols {
                row[x] = prev[x].max(cur[x]).max(next[x]);
            }
        } else {
            for x in 0..cols {
                row[x] = prev[x].max(cur[x]);
            }
        }
        prev.copy_from_slice(cur);
    }
}

/// Radii up to this use repeated 3-tap passes; larger ones the O(cells) deque.
const DILATE_PASSES_MAX: usize = 8;

/// Applies a 3×3 maximum filter `times` times (cells outside the grid are ignored).
///
/// Equivalent to one clamped `(2t+1)×(2t+1)` window maximum, computed separably (rows,
/// then columns); maxima are exact, so every strategy gives the same result.
pub(crate) fn dilate(grid: &mut [u8], cols: usize, rows: usize, times: u32) {
    if times == 0 || cols == 0 || rows == 0 {
        return;
    }
    let r = (times as usize).min(cols.max(rows));
    if r <= DILATE_PASSES_MAX {
        let mut a = vec![0u8; cols];
        let mut b = vec![0u8; cols];
        for _ in 0..r {
            max3_rows(grid, cols, &mut a);
        }
        for _ in 0..r {
            max3_cols(grid, cols, rows, &mut a, &mut b);
        }
        return;
    }
    let n = cols.max(rows);
    let mut line = vec![0u8; n];
    let mut res = vec![0u8; n];
    let mut dq = vec![0usize; n];
    for y in 0..rows {
        let row = &mut grid[y * cols..(y + 1) * cols];
        line[..cols].copy_from_slice(row);
        window_max(&line[..cols], r, &mut res[..cols], &mut dq);
        row.copy_from_slice(&res[..cols]);
    }
    for x in 0..cols {
        for y in 0..rows {
            line[y] = grid[y * cols + x];
        }
        window_max(&line[..rows], r, &mut res[..rows], &mut dq);
        for y in 0..rows {
            grid[y * cols + x] = res[y];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantization() {
        assert_eq!(quantize(0.0), 0);
        assert_eq!(quantize(1e-12), 1);
        assert_eq!(quantize(0.5 / 255.0), 1);
        assert_eq!(quantize(1.4 / 255.0), 1);
        assert_eq!(quantize(1.5 / 255.0), 2);
        assert_eq!(quantize(0.5), 128);
        assert_eq!(quantize(1.0), 255);
        assert_eq!(quantize(1.0 + 1e-12), 255);
    }

    #[test]
    fn axis_weights_partition_pixels() {
        // Scale 2, offset 0.25, cell 1: pixel i covers [0.25 + i/2, 0.25 + (i+1)/2).
        let ax = Axis::new(5, 0.25, 2.0, 0.0, 1.0, 3);
        let pairs = |i: usize| {
            let (a, b) = ax.range(i);
            (a..b)
                .map(|t| (ax.cells[t], ax.weights[t]))
                .collect::<Vec<_>>()
        };
        assert_eq!(pairs(0), vec![(0, 0.5)]);
        assert_eq!(pairs(1), vec![(0, 0.25), (1, 0.25)]);
        assert_eq!(pairs(2), vec![(1, 0.5)]);
        assert_eq!(pairs(3), vec![(1, 0.25), (2, 0.25)]);
        assert_eq!(pairs(4), vec![(2, 0.5)]);
        assert_eq!((ax.lo, ax.hi, ax.span), (0, 5, 2));
        // Cells beyond the raster get nothing; the last cell is only partially covered.
        let short = Axis::new(3, 0.0, 1.0, 0.0, 2.0, 3);
        assert_eq!(short.range(2), (2, 3));
        assert_eq!((short.cells[2], short.weights[2]), (1, 0.5));
        // Nothing overlaps: raster entirely left of the grid.
        let none = Axis::new(4, -10.0, 1.0, 0.0, 1.0, 3);
        assert_eq!((none.lo, none.hi), (0, 0));
    }

    #[test]
    fn dilation_matches_naive() {
        let (cols, rows) = (7, 5);
        let mut state = 7u32;
        let grid: Vec<u8> = (0..cols * rows)
            .map(|_| {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                if state >> 28 == 0 {
                    (state >> 20) as u8
                } else {
                    0
                }
            })
            .collect();
        for times in [0, 1, 2, 3, 5, 8, 9, 12, 40] {
            let mut fast = grid.clone();
            dilate(&mut fast, cols, rows, times);
            let mut naive = grid.clone();
            for _ in 0..times {
                let prev = naive.clone();
                for y in 0..rows {
                    for x in 0..cols {
                        let mut m = 0;
                        for yy in y.saturating_sub(1)..=(y + 1).min(rows - 1) {
                            for xx in x.saturating_sub(1)..=(x + 1).min(cols - 1) {
                                m = m.max(prev[yy * cols + xx]);
                            }
                        }
                        naive[y * cols + x] = m;
                    }
                }
            }
            assert_eq!(fast, naive, "times={times}");
        }
    }
}
