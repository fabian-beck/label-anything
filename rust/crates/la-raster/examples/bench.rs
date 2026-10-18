//! Rough timings of `process` and `backdrop_luma` on 2048×2048 synthetic rasters
//! (decode excluded):
//!
//! * `chart`: white background, grid lines, 3000 anti-aliased scatter points, line series
//!   and text-like blocks (typical line art);
//! * `photo`: smooth gradients with per-pixel noise (almost every pixel a new colour, the
//!   worst case for the colour memo).
//!
//! The images are generated with integer arithmetic only; `ts/packages/raster/bench/bench.mjs`
//! generates the same pixels, so the printed coverage checksums must agree.
//!
//! Run: `cargo run --release -p label-anything-raster --example bench [size] [cell] [filter]`
//! (`filter` selects the scenarios whose label contains it, e.g. `"chart ink"`).

use std::time::Instant;

use label_anything_raster::{
    backdrop_luma, process, ClassCoverage, GridSpec, Mode, RasterPlacement, Rgba,
};

struct Lcg(u32);

impl Lcg {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        self.0
    }
    fn below(&mut self, n: u32) -> u32 {
        ((u64::from(self.next()) * u64::from(n)) >> 32) as u32
    }
}

/// Blends `rgb` over pixel `(x, y)` with coverage `k / 16`.
fn blend(img: &mut Rgba, x: i64, y: i64, rgb: [u8; 3], k: u32) {
    if x < 0 || y < 0 || x >= i64::from(img.width) || y >= i64::from(img.height) || k == 0 {
        return;
    }
    let i = ((y as usize) * img.width as usize + x as usize) * 4;
    for (d, &c) in img.data[i..i + 3].iter_mut().zip(&rgb) {
        *d = ((u32::from(c) * k + u32::from(*d) * (16 - k)) / 16) as u8;
    }
}

/// Anti-aliased disc (4×4 supersampling) with centre and radius in 1/8 px.
fn disc(img: &mut Rgba, cx8: i64, cy8: i64, r8: i64, rgb: [u8; 3]) {
    let (x0, x1) = ((cx8 - r8) / 8 - 1, (cx8 + r8) / 8 + 1);
    let (y0, y1) = ((cy8 - r8) / 8 - 1, (cy8 + r8) / 8 + 1);
    for y in y0..=y1 {
        for x in x0..=x1 {
            let mut k = 0;
            for sy in 0..4 {
                for sx in 0..4 {
                    let dx = x * 8 + sx * 2 + 1 - cx8;
                    let dy = y * 8 + sy * 2 + 1 - cy8;
                    if dx * dx + dy * dy <= r8 * r8 {
                        k += 1;
                    }
                }
            }
            blend(img, x, y, rgb, k);
        }
    }
}

fn chart(size: u32) -> Rgba {
    let n = size as usize;
    let mut img = Rgba::new(size, size, vec![255; n * n * 4]).unwrap();
    for y in 0..n {
        for x in 0..n {
            if x % 128 == 0 || y % 128 == 0 {
                let i = (y * n + x) * 4;
                img.data[i..i + 3].copy_from_slice(&[225, 225, 225]);
            }
        }
    }
    let mut rng = Lcg(42);
    let colors = [
        [31, 119, 180],
        [255, 127, 14],
        [44, 160, 44],
        [214, 39, 40],
        [148, 103, 189],
    ];
    for color in colors {
        let mut y8 = i64::from(rng.below(size * 8));
        for x in 0..i64::from(size) {
            y8 = (y8 + i64::from(rng.below(41)) - 20).clamp(0, i64::from(size) * 8 - 1);
            disc(&mut img, x * 8 + 4, y8, 12, color);
        }
    }
    for _ in 0..3000 {
        let (cx, cy) = (
            i64::from(rng.below(size * 8)),
            i64::from(rng.below(size * 8)),
        );
        let r = 16 + i64::from(rng.below(32));
        disc(&mut img, cx, cy, r, colors[rng.below(5) as usize]);
    }
    for _ in 0..400 {
        let (x0, y0) = (rng.below(size - 40) as usize, rng.below(size - 12) as usize);
        let (w, h) = (4 + rng.below(30) as usize, 6 + rng.below(5) as usize);
        for y in y0..y0 + h {
            for x in x0..x0 + w {
                if (x + y) % 5 != 0 {
                    let i = (y * n + x) * 4;
                    img.data[i..i + 3].copy_from_slice(&[20, 20, 20]);
                }
            }
        }
    }
    img
}

fn photo(size: u32) -> Rgba {
    let n = size as usize;
    let mut data = vec![255u8; n * n * 4];
    let mut rng = Lcg(7);
    for y in 0..n {
        for x in 0..n {
            let i = (y * n + x) * 4;
            let noise = rng.below(48) as usize;
            data[i] = ((x * 255 / n + noise) % 256) as u8;
            data[i + 1] = ((y * 255 / n + noise / 2) % 256) as u8;
            data[i + 2] = ((((x + y) * 127) / n + noise) % 256) as u8;
        }
    }
    Rgba::new(size, size, data).unwrap()
}

fn fnv1a32(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811c_9dc5, |h, &b| {
        (h ^ u32::from(b)).wrapping_mul(0x0100_0193)
    })
}

fn bench(filter: &str, label: &str, iterations: usize, mut f: impl FnMut() -> Vec<ClassCoverage>) {
    if !label.contains(filter) {
        return;
    }
    let first = f();
    let mut times = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let t = Instant::now();
        std::hint::black_box(f());
        times.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    let sums: Vec<String> = first
        .iter()
        .map(|c| format!("{}:{:08x}", c.class, fnv1a32(&c.coverage)))
        .collect();
    println!(
        "{label:<22} min {:>7.2} ms  median {:>7.2} ms  {}",
        times[0],
        times[times.len() / 2],
        sums.join(" ")
    );
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let size: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(2048);
    let cell: f64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(2.0);
    let filter = args.get(3).map_or("", String::as_str);
    let cols = (f64::from(size) / cell).ceil() as usize;
    let grid = GridSpec {
        origin_x: 0.0,
        origin_y: 0.0,
        cell,
        cols,
        rows: cols,
    };
    let place = RasterPlacement::default();
    let ink = Mode::Ink {
        background: None,
        threshold: 0.12,
        dilate: 1,
    };
    let classmap = Mode::ClassMap {
        palette: vec![
            ([31, 119, 180], "a".into()),
            ([214, 39, 40], "b".into()),
            ([20, 20, 20], "text".into()),
        ],
        tolerance: 0.08,
        unmatched_ink: true,
        background: None,
        ink_threshold: 0.12,
    };
    println!("{size}x{size} raster, cell {cell} -> {cols}x{cols} grid");
    for (name, img) in [("chart", chart(size)), ("photo", photo(size))] {
        bench(filter, &format!("{name} ink"), 15, || {
            process(&img, &ink, "ink", &place, &grid)
        });
        bench(filter, &format!("{name} alpha"), 9, || {
            process(&img, &Mode::Alpha { threshold: 0.1 }, "ink", &place, &grid)
        });
        bench(filter, &format!("{name} cost"), 9, || {
            process(&img, &Mode::Cost { invert: false }, "cost", &place, &grid)
        });
        bench(filter, &format!("{name} classmap"), 9, || {
            process(&img, &classmap, "ink", &place, &grid)
        });
        bench(filter, &format!("{name} saliency"), 5, || {
            process(&img, &Mode::Saliency, "salient", &place, &grid)
        });
        bench(filter, &format!("{name} luma"), 9, || {
            vec![ClassCoverage {
                class: "luma".into(),
                coverage: backdrop_luma(&[(&img, place)], [255, 255, 255], &grid),
            }]
        });
    }
}
