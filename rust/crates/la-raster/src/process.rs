//! Pixel modes (spec §4.6): per-pixel values in [0, 1], area-averaged into coverage grids.

use crate::color::{composite, estimate_background, oklab_distance, srgb_to_oklab};
use crate::grid::{dilate, Axis, GridSpec, RasterPlacement, Resampler};
use crate::rgba::Rgba;

/// How raster pixels become obstacle coverage (spec §4.6). All colour distances are
/// Euclidean OKLab distances ([`srgb_to_oklab`]).
///
/// Every mode first composites a pixel over a backdrop (the background colour for `Ink`
/// and `ClassMap`, white for `Cost` and `Saliency`), rounding each channel to 8 bits:
/// `c' = (c·a + bg·(255 − a) + 127) div 255`.
#[derive(Debug, Clone, PartialEq)]
pub enum Mode {
    /// 1 where the composited pixel differs from the background by more than `threshold`.
    Ink {
        /// Background colour; `None` estimates it ([`estimate_background`]).
        background: Option<[u8; 3]>,
        /// OKLab distance above which a pixel is ink (default 0.12).
        threshold: f64,
        /// 3×3 maximum filter applied this many times to the quantized grid (default 1).
        dilate: u32,
    },
    /// 1 where `alpha / 255 > threshold`.
    Alpha {
        /// Default 0.1.
        threshold: f64,
    },
    /// `1 − Y'` (or `Y'` with `invert`), `Y'` the Rec. 709 luma of the pixel composited
    /// over white: `Y' = (2126·R + 7152·G + 722·B) / 2 550 000`.
    Cost {
        /// `false`: dark is costly; `true`: bright is costly.
        invert: bool,
    },
    /// Pixels are assigned to the class of the nearest palette colour.
    ClassMap {
        /// `(colour, class)` in document order; class `"ignore"` drops matching pixels.
        palette: Vec<([u8; 3], String)>,
        /// Max. OKLab distance of a match (default 0.08); ties go to the first entry.
        tolerance: f64,
        /// Unmatched non-background pixels go to class `"ink"` (`true`) or nowhere.
        unmatched_ink: bool,
        /// Background colour; `None` estimates it.
        background: Option<[u8; 3]>,
        /// Pixels within this OKLab distance of the background are skipped (the ink
        /// threshold, default 0.12).
        ink_threshold: f64,
    },
    /// Normalized Sobel gradient magnitude of the luma averaged with its local contrast.
    Saliency,
}

/// The coverage of one class: `rows × cols` cells, row-major, `0..=255` (spec §4.1).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ClassCoverage {
    /// The obstacle class.
    pub class: String,
    /// `grid.rows * grid.cols` quantized coverage values.
    pub coverage: Vec<u8>,
}

/// The class name that drops classmap pixels.
const IGNORE: &str = "ignore";
/// The class of unmatched classmap pixels.
const INK: &str = "ink";
/// "No class" label.
const NONE: u32 = u32::MAX;
/// `2126 + 7152 + 722 = 10000`, times 255.
const LUMA_DENOM: u32 = 2_550_000;

/// Validated geometry shared by all modes.
struct Setup {
    w: usize,
    h: usize,
    cols: Axis,
    rows: Axis,
    gcols: usize,
    grows: usize,
}

impl Setup {
    fn new(img: &Rgba, place: &RasterPlacement, grid: &GridSpec) -> Option<Self> {
        let finite = [
            place.scale,
            place.offset[0],
            place.offset[1],
            grid.cell,
            grid.origin_x,
            grid.origin_y,
        ]
        .iter()
        .all(|v| v.is_finite());
        let fits = |n: usize| u32::try_from(n).is_ok();
        if !img.is_valid()
            || !finite
            || place.scale <= 0.0
            || grid.cell <= 0.0
            || !fits(grid.cols)
            || !fits(grid.rows)
            || grid.cell_count().is_none()
        {
            return None;
        }
        let (w, h) = (img.width as usize, img.height as usize);
        Some(Self {
            w,
            h,
            cols: Axis::new(
                w,
                place.offset[0],
                place.scale,
                grid.origin_x,
                grid.cell,
                grid.cols,
            ),
            rows: Axis::new(
                h,
                place.offset[1],
                place.scale,
                grid.origin_y,
                grid.cell,
                grid.rows,
            ),
            gcols: grid.cols,
            grows: grid.rows,
        })
    }

    fn resampler(&self, k: usize) -> Resampler<'_> {
        Resampler::new(&self.cols, &self.rows, self.gcols, self.grows, k)
    }

    /// Runs `per_pixel(resampler, px, pixel)` for every pixel that touches the grid, row by
    /// row, and returns the `k` quantized grids.
    fn run(
        &self,
        img: &Rgba,
        k: usize,
        mut per_pixel: impl FnMut(&mut Resampler<'_>, usize, usize, &[u8]),
    ) -> Vec<Vec<u8>> {
        let mut res = self.resampler(k);
        let stride = self.w * 4;
        for py in self.rows.lo..self.rows.hi {
            if !res.begin_row(py) {
                continue;
            }
            let row = &img.data[py * stride..(py + 1) * stride];
            for px in self.cols.lo..self.cols.hi {
                per_pixel(&mut res, px, py, &row[px * 4..px * 4 + 4]);
            }
            res.end_row(py);
        }
        res.finish()
    }
}

/// A direct-mapped memo of per-colour results keyed by the packed RGBA value. It is a
/// pure cache: results are identical with or without it.
struct ColorMemo {
    keys: Vec<u32>,
    /// `value + 1`; 0 = empty slot.
    vals: Vec<u32>,
}

impl ColorMemo {
    const BITS: u32 = 16;

    fn new() -> Self {
        Self {
            keys: vec![0; 1 << Self::BITS],
            vals: vec![0; 1 << Self::BITS],
        }
    }

    #[inline]
    fn get_or_insert(&mut self, key: u32, compute: impl FnOnce() -> u32) -> u32 {
        let slot = (key.wrapping_mul(0x9E37_79B1) >> (32 - Self::BITS)) as usize;
        if self.vals[slot] != 0 && self.keys[slot] == key {
            return self.vals[slot] - 1;
        }
        let v = compute();
        self.keys[slot] = key;
        self.vals[slot] = v + 1;
        v
    }
}

#[inline]
fn pack(p: &[u8]) -> u32 {
    u32::from_le_bytes([p[0], p[1], p[2], p[3]])
}

/// Composites a pixel over `bg` (8-bit result, see [`Mode`]).
#[inline]
fn over(p: &[u8], bg: [u8; 3]) -> [u8; 3] {
    let a = p[3];
    if a == 255 {
        [p[0], p[1], p[2]]
    } else {
        [
            composite(p[0], bg[0], a),
            composite(p[1], bg[1], a),
            composite(p[2], bg[2], a),
        ]
    }
}

/// `2126·R + 7152·G + 722·B` of the pixel composited over white (`0..=2 550 000`).
#[inline]
fn luma_numerator(p: &[u8]) -> u32 {
    let [r, g, b] = over(p, [255, 255, 255]);
    2126 * u32::from(r) + 7152 * u32::from(g) + 722 * u32::from(b)
}

/// Turns a raster into per-class coverage grids (spec §4.6).
///
/// * `Ink`, `Alpha`, `Cost`, `Saliency`: exactly one entry, for `class`.
/// * `ClassMap`: one entry per class with non-zero coverage somewhere, in palette order
///   of first occurrence, followed by `"ink"` (unmatched pixels) if `unmatched_ink` and
///   `"ink"` is not a palette class. `class` is not used.
///
/// Invalid input (an [`Rgba`] whose data does not match its size, a non-finite or
/// non-positive `scale` or `cell`, non-finite offsets or origins, or a grid with more
/// than `u32::MAX` rows or columns) produces all-zero coverage (no classmap entries),
/// never a panic. A grid whose cell count overflows `usize` yields empty coverage arrays.
pub fn process(
    img: &Rgba,
    mode: &Mode,
    class: &str,
    place: &RasterPlacement,
    grid: &GridSpec,
) -> Vec<ClassCoverage> {
    let Some(setup) = Setup::new(img, place, grid) else {
        return match mode {
            Mode::ClassMap { .. } => Vec::new(),
            _ => vec![ClassCoverage {
                class: class.to_owned(),
                coverage: vec![0; grid.cell_count().unwrap_or(0)],
            }],
        };
    };
    let single = |coverage: Vec<u8>| {
        vec![ClassCoverage {
            class: class.to_owned(),
            coverage,
        }]
    };
    match mode {
        Mode::Ink {
            background,
            threshold,
            dilate: times,
        } => {
            let mut grid_out = ink(
                &setup,
                img,
                background.unwrap_or_else(|| estimate_background(img)),
                *threshold,
            );
            dilate(&mut grid_out, setup.gcols, setup.grows, *times);
            single(grid_out)
        }
        Mode::Alpha { threshold } => {
            let mut table = [false; 256];
            for (a, t) in table.iter_mut().enumerate() {
                *t = (a as f64) / 255.0 > *threshold;
            }
            let grids = setup.run(img, 1, |res, px, _, p| {
                if table[p[3] as usize] {
                    res.add_one(0, px);
                }
            });
            single(take_first(grids))
        }
        Mode::Cost { invert } => {
            let invert = *invert;
            let grids = setup.run(img, 1, |res, px, _, p| {
                let n = luma_numerator(p);
                let v = if invert {
                    f64::from(n)
                } else {
                    f64::from(LUMA_DENOM - n)
                } / f64::from(LUMA_DENOM);
                if v != 0.0 {
                    res.add(0, px, v);
                }
            });
            single(take_first(grids))
        }
        Mode::Saliency => single(saliency(&setup, img)),
        Mode::ClassMap {
            palette,
            tolerance,
            unmatched_ink,
            background,
            ink_threshold,
        } => classmap(
            &setup,
            img,
            palette,
            *tolerance,
            *unmatched_ink,
            background.unwrap_or_else(|| estimate_background(img)),
            *ink_threshold,
        ),
    }
}

fn take_first(mut grids: Vec<Vec<u8>>) -> Vec<u8> {
    grids.swap_remove(0)
}

fn ink(setup: &Setup, img: &Rgba, bg: [u8; 3], threshold: f64) -> Vec<u8> {
    let bg_lab = srgb_to_oklab(bg);
    let mut memo = ColorMemo::new();
    // Runs of equal pixels are common: remember the last decision as well.
    let mut last_key = u64::MAX;
    let mut last_ink = false;
    let grids = setup.run(img, 1, |res, px, _, p| {
        let key = pack(p);
        if u64::from(key) != last_key {
            last_key = u64::from(key);
            last_ink = memo.get_or_insert(key, || {
                u32::from(oklab_distance(&srgb_to_oklab(over(p, bg)), &bg_lab) > threshold)
            }) == 1;
        }
        if last_ink {
            res.add_one(0, px);
        }
    });
    take_first(grids)
}

fn classmap(
    setup: &Setup,
    img: &Rgba,
    palette: &[([u8; 3], String)],
    tolerance: f64,
    unmatched_ink: bool,
    bg: [u8; 3],
    ink_threshold: f64,
) -> Vec<ClassCoverage> {
    /// Index of `name` in `classes`, appending it if new (first-occurrence order).
    fn index_of<'a>(classes: &mut Vec<&'a str>, name: &'a str) -> u32 {
        match classes.iter().position(|c| *c == name) {
            Some(i) => i as u32,
            None => {
                classes.push(name);
                (classes.len() - 1) as u32
            }
        }
    }
    let mut classes: Vec<&str> = Vec::new();
    let mut entry_class = Vec::with_capacity(palette.len());
    for (_, name) in palette {
        entry_class.push(if name == IGNORE {
            NONE
        } else {
            index_of(&mut classes, name.as_str())
        });
    }
    let unmatched = if unmatched_ink {
        index_of(&mut classes, INK)
    } else {
        NONE
    };
    if classes.is_empty() {
        return Vec::new();
    }
    let bg_lab = srgb_to_oklab(bg);
    let pal_lab: Vec<[f64; 3]> = palette.iter().map(|(rgb, _)| srgb_to_oklab(*rgb)).collect();
    let label_of = |p: &[u8]| -> u32 {
        let lab = srgb_to_oklab(over(p, bg));
        if oklab_distance(&lab, &bg_lab) <= ink_threshold {
            return NONE;
        }
        let mut best = NONE;
        let mut best_d = 0.0;
        for (k, plab) in pal_lab.iter().enumerate() {
            let d = oklab_distance(&lab, plab);
            if d <= tolerance && (best == NONE || d < best_d) {
                best = k as u32;
                best_d = d;
            }
        }
        if best == NONE {
            unmatched
        } else {
            entry_class[best as usize]
        }
    };
    let mut memo = ColorMemo::new();
    let mut last_key = u64::MAX;
    let mut last_label = NONE;
    let grids = setup.run(img, classes.len(), |res, px, _, p| {
        let key = pack(p);
        if u64::from(key) != last_key {
            last_key = u64::from(key);
            // `NONE + 1` would overflow the memo encoding; store labels shifted by one.
            last_label = memo
                .get_or_insert(key, || label_of(p).wrapping_add(1))
                .wrapping_sub(1);
        }
        if last_label != NONE {
            res.add_one(last_label as usize, px);
        }
    });
    classes
        .iter()
        .zip(grids)
        .filter(|(_, g)| g.iter().any(|&q| q > 0))
        .map(|(c, coverage)| ClassCoverage {
            class: (*c).to_owned(),
            coverage,
        })
        .collect()
}

/// Saliency (spec §4.6) on the integer luma numerators `n = 2126·R + 7152·G + 722·B`
/// (composited over white): all sums are exact integers, so only the final `sqrt`,
/// divisions and the averaging are rounded.
fn saliency(setup: &Setup, img: &Rgba) -> Vec<u8> {
    let (w, h) = (setup.w, setup.h);
    let n: Vec<u32> = img.data.chunks_exact(4).map(luma_numerator).collect();
    // Horizontal 5-sums, clamped to the image (≤ 5 · 2 550 000).
    let mut hs = vec![0u32; w * h];
    for y in 0..h {
        let row = &n[y * w..(y + 1) * w];
        for x in 0..w {
            hs[y * w + x] = row[x.saturating_sub(2)..=(x + 2).min(w - 1)].iter().sum();
        }
    }
    let gc = |x: usize, y: usize| -> (f64, f64) {
        let at = |xx: usize, yy: usize| i64::from(n[yy * w + xx]);
        let (xm, xp) = (x.saturating_sub(1), (x + 1).min(w - 1));
        let (ym, yp) = (y.saturating_sub(1), (y + 1).min(h - 1));
        let gx =
            (at(xp, ym) + 2 * at(xp, y) + at(xp, yp)) - (at(xm, ym) + 2 * at(xm, y) + at(xm, yp));
        let gy =
            (at(xm, yp) + 2 * at(x, yp) + at(xp, yp)) - (at(xm, ym) + 2 * at(x, ym) + at(xp, ym));
        let g = ((gx * gx + gy * gy) as f64).sqrt();
        let (y0, y1) = (y.saturating_sub(2), (y + 2).min(h - 1));
        let s: i64 = (y0..=y1).map(|yy| i64::from(hs[yy * w + x])).sum();
        let kx = (x + 2).min(w - 1) - x.saturating_sub(2) + 1;
        let k = (kx * (y1 - y0 + 1)) as i64;
        let c = (k * at(x, y) - s).unsigned_abs() as f64 / k as f64;
        (g, c)
    };
    let (mut max_g, mut max_c) = (0.0f64, 0.0f64);
    for y in 0..h {
        for x in 0..w {
            let (g, c) = gc(x, y);
            if g > max_g {
                max_g = g;
            }
            if c > max_c {
                max_c = c;
            }
        }
    }
    let grids = setup.run(img, 1, |res, px, py, _| {
        let (g, c) = gc(px, py);
        let tg = if max_g > 0.0 { g / max_g } else { 0.0 };
        let tc = if max_c > 0.0 { c / max_c } else { 0.0 };
        let v = (tg + tc) / 2.0;
        if v != 0.0 {
            res.add(0, px, v);
        }
    });
    take_first(grids)
}
