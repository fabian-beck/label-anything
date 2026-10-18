//! Backdrop luma (spec §4.6): the lightness of what lies behind labels, per grid cell, for
//! the `contrast` cost term of the core (spec §8).

use crate::grid::{GridSpec, RasterPlacement};
use crate::rgba::Rgba;

/// `2126·R + 7152·G + 722·B` of the colour itself (no compositing); the Rec. 709 luma is
/// this over 2 550 000.
#[inline(always)]
fn luma(p: &[u8]) -> f64 {
    f64::from(2126 * u32::from(p[0]) + 7152 * u32::from(p[1]) + 722 * u32::from(p[2]))
}

/// Quantizes a luma numerator (`0..=2 550 000`) to `0..=255`: `floor(n / 10 000 + 1/2)`,
/// clamped (no minimum of 1, unlike coverage). (`t as u8` truncates, which equals `floor`
/// for `1 ≤ t < 255`.)
#[inline]
fn quantize_luma(n: f64) -> u8 {
    let t = n / 10_000.0 + 0.5;
    if t >= 255.0 {
        255
    } else if t >= 1.0 {
        t as u8
    } else {
        0
    }
}

/// For the sample positions `origin + (k + 1/2) · step` (`k < n`), the index of the raster
/// pixel containing each, `floor((position − offset) · scale)`, or `u32::MAX` outside the
/// `size` pixels.
fn pixel_indices(n: usize, origin: f64, step: f64, offset: f64, scale: f64, size: u32) -> Vec<u32> {
    (0..n)
        .map(|k| {
            let t = ((origin + (k as f64 + 0.5) * step - offset) * scale).floor();
            if t >= 0.0 && t < f64::from(size) {
                t as u32
            } else {
                u32::MAX
            }
        })
        .collect()
}

/// The backdrop luma grid (spec §4.6): rasters drawn in order over a canvas filled with
/// `background`, and per grid cell the Rec. 709 luma `Y'` of the result (as in the `cost`
/// mode), quantized to `0..=255` (row-major, `grid.rows × grid.cols`).
///
/// Every cell is sampled at the 2 × 2 points `(x0 + (2·col + i + 1/2)·c/2,
/// y0 + (2·row + j + 1/2)·c/2)`, `i, j ∈ {0, 1}`. A sample starts with the luma numerator
/// `n` of `background`; each raster, in order, whose pixel `(floor((x − ox)·s),
/// floor((y − oy)·s))` exists replaces it by `(a·n_px + (255 − a)·n) / 255` (`n_px` the
/// numerator of the pixel's colour, `a` its alpha: opaque pixels replace what lies below,
/// transparent ones let it show through). A cell's value is
/// `((n₀₀ + n₁₀) + (n₀₁ + n₁₁)) / 4`, quantized as `floor(n / 10 000 + 1/2)` clamped to 255.
/// Rasters that cannot be placed (an [`Rgba`] whose data does not match its size, or a
/// scale or offset that is not finite and positive) are skipped, as are grids with a cell
/// size that is not finite and positive. A grid whose cell count overflows `usize` yields
/// an empty vector.
pub fn backdrop_luma(
    layers: &[(&Rgba, RasterPlacement)],
    background: [u8; 3],
    grid: &GridSpec,
) -> Vec<u8> {
    let (cols, rows) = (grid.cols, grid.rows);
    let Some(n) = grid.cell_count() else {
        return Vec::new();
    };
    let (Some(sc), Some(sr)) = (cols.checked_mul(2), rows.checked_mul(2)) else {
        return Vec::new();
    };
    let base = luma(&background);
    let geometry_ok = grid.cell.is_finite()
        && grid.cell > 0.0
        && grid.origin_x.is_finite()
        && grid.origin_y.is_finite();
    let step = grid.cell / 2.0;
    // per layer: the pixel column of every sample column and the pixel row of every sample row
    let placed: Vec<(&Rgba, Vec<u32>, Vec<u32>)> = layers
        .iter()
        .filter(|(img, place)| {
            geometry_ok
                && img.is_valid()
                && place.scale.is_finite()
                && place.scale > 0.0
                && place.offset[0].is_finite()
                && place.offset[1].is_finite()
        })
        .map(|(img, place)| {
            let xs = pixel_indices(
                sc,
                grid.origin_x,
                step,
                place.offset[0],
                place.scale,
                img.width,
            );
            let ys = pixel_indices(
                sr,
                grid.origin_y,
                step,
                place.offset[1],
                place.scale,
                img.height,
            );
            (*img, xs, ys)
        })
        .collect();
    let mut out = vec![quantize_luma(base); n];
    if placed.is_empty() {
        return out;
    }
    // two rows of samples at a time
    let mut row = vec![base; 2 * sc];
    for gy in 0..rows {
        row.fill(base);
        for (img, xs, ys) in &placed {
            let w = img.width as usize;
            let pixels = img.data.as_chunks::<4>().0;
            for j in 0..2 {
                let py = ys[2 * gy + j];
                if py == u32::MAX {
                    continue;
                }
                let line = &pixels[py as usize * w..(py as usize + 1) * w];
                let samples = &mut row[j * sc..(j + 1) * sc];
                for (s, &px) in samples.iter_mut().zip(xs) {
                    // `u32::MAX` (outside the raster) is never a pixel of the line
                    let Some(p) = line.get(px as usize) else {
                        continue;
                    };
                    let a = p[3];
                    if a == 255 {
                        *s = luma(p);
                    } else if a != 0 {
                        *s = (f64::from(a) * luma(p) + f64::from(255 - a) * *s) / 255.0;
                    }
                }
            }
        }
        let (top, bottom) = row.split_at(sc);
        for (gx, o) in out[gy * cols..(gy + 1) * cols].iter_mut().enumerate() {
            let v = ((top[2 * gx] + top[2 * gx + 1]) + (bottom[2 * gx] + bottom[2 * gx + 1])) / 4.0;
            *o = quantize_luma(v);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(cols: usize, rows: usize, cell: f64) -> GridSpec {
        GridSpec {
            origin_x: 0.0,
            origin_y: 0.0,
            cell,
            cols,
            rows,
        }
    }

    fn at(x: f64) -> RasterPlacement {
        RasterPlacement {
            scale: 1.0,
            offset: [x, 0.0],
        }
    }

    const WHITE: [u8; 3] = [255, 255, 255];

    #[test]
    fn quantization() {
        assert_eq!(quantize_luma(2_550_000.0), 255);
        assert_eq!(quantize_luma(0.0), 0);
        assert_eq!(quantize_luma(-1.0), 0);
        assert_eq!(quantize_luma(3_000_000.0), 255);
        assert_eq!(quantize_luma(1_275_000.0), 128);
        assert_eq!(quantize_luma(1_274_999.0), 127);
    }

    #[test]
    fn layers_over_the_background() {
        let g = grid(4, 1, 1.0);
        // a 2×1 black raster at x = 1 on a white canvas of 4 cells of 1 px
        let black = Rgba::new(2, 1, vec![0, 0, 0, 255, 0, 0, 0, 255]).unwrap();
        assert_eq!(
            backdrop_luma(&[(&black, at(1.0))], WHITE, &g),
            [255, 0, 0, 255]
        );
        // half a cell covered: two of the four samples black
        assert_eq!(
            backdrop_luma(&[(&black, at(0.5))], WHITE, &g),
            [128, 0, 128, 255]
        );
        // grey (Y' = 128/255 rounds to 128), pure red (Y' = 0.2126)
        let grey = Rgba::new(1, 1, vec![128, 128, 128, 255]).unwrap();
        assert_eq!(
            backdrop_luma(&[(&grey, at(2.0))], WHITE, &g),
            [255, 255, 128, 255]
        );
        let red = Rgba::new(1, 1, vec![255, 0, 0, 255]).unwrap();
        assert_eq!(
            backdrop_luma(&[(&red, at(0.0))], [0, 0, 0], &g),
            [54, 0, 0, 0]
        );
        // a transparent pixel lets the layer below show through, a later layer covers
        let clear = Rgba::new(2, 1, vec![255, 255, 255, 0, 255, 255, 255, 255]).unwrap();
        assert_eq!(
            backdrop_luma(&[(&black, at(1.0)), (&clear, at(1.0))], WHITE, &g),
            [255, 0, 255, 255]
        );
        // half transparent black over white: 127/255 of white
        let half = Rgba::new(1, 1, vec![0, 0, 0, 128]).unwrap();
        assert_eq!(
            backdrop_luma(&[(&half, at(0.0))], WHITE, &g),
            [127, 255, 255, 255]
        );
        // no layers: the background everywhere; invalid layers are skipped
        let bad = RasterPlacement {
            scale: 0.0,
            offset: [0.0, 0.0],
        };
        assert_eq!(backdrop_luma(&[(&black, bad)], [0, 0, 0], &g), [0; 4]);
        assert_eq!(backdrop_luma(&[], WHITE, &g), [255; 4]);
    }

    #[test]
    fn scale_and_rows() {
        // a 4×4 raster at scale 2 (2×2 canvas px) at (1, 1) on a 2×2 grid of 2 px cells:
        // left column black, right column white; cell (0, 0) holds one sample of it
        let mut data = Vec::new();
        for _ in 0..4 {
            data.extend_from_slice(&[
                0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255,
            ]);
        }
        let img = Rgba::new(4, 4, data).unwrap();
        let place = RasterPlacement {
            scale: 2.0,
            offset: [1.0, 1.0],
        };
        // samples at 0.5 and 1.5 per axis: only (1.5, 1.5) of cell (0, 0) falls on the
        // raster (pixel (1, 1), black); cell (1, 0) samples (2.5, 0.5) and (3.5, 0.5) miss
        // it vertically, (2.5, 1.5) is pixel (3, 1) (white) and (3.5, 1.5) is outside
        assert_eq!(
            backdrop_luma(&[(&img, place)], [128, 128, 128], &grid(2, 2, 2.0)),
            [96, 160, 96, 160]
        );
    }
}
