//! Rough timings of the geometry hot paths, for comparison with the TypeScript port
//! (`ts/packages/core/bench/geom-bench.mjs` draws the same inputs from PCG32 and must print
//! the same checksums):
//!
//! * rasterize 100k discs (r = 1.5 px) into a 1920×1080 extent with 4 px cells, then build
//!   the summed-area table;
//! * 1M SAT queries (`covered_area`) of label-sized rectangles;
//! * 100k static index queries on 100k points (and the index build);
//! * 1M shape-vs-rectangle overlap tests per shape kind (rectangles near the shapes).
//!
//! Run: `cargo run --release -p label-anything-core --example geom_bench [runs]`
//! (prints the best of `runs`, default 5).

use std::hint::black_box;
use std::time::Instant;

use la_expr::det_math::{sin_cos_deg, Pcg32};
use label_anything_core::geom::shape::Shape;
use label_anything_core::geom::{Rect, P};
use label_anything_core::grid::raster::MaskRaster;
use label_anything_core::grid::{GridSpec, Sat};
use label_anything_core::index::StaticIndex;

/// Best wall time in ms of `runs` runs of `f` (which returns a checksum). On a busy
/// machine the minimum is the most stable statistic.
fn best(runs: usize, mut f: impl FnMut() -> f64) -> (f64, f64) {
    let mut t = f64::INFINITY;
    let mut sum = 0.0;
    for _ in 0..runs {
        let t0 = Instant::now();
        sum = black_box(f());
        t = t.min(t0.elapsed().as_secs_f64() * 1e3);
    }
    (t, sum)
}

fn report(name: &str, (ms, checksum): (f64, f64)) {
    println!("{name:<44} {ms:>9.2} ms   checksum {checksum}");
}

fn shapes(rng: &mut Pcg32, kind: u32, n: usize) -> Vec<Shape> {
    (0..n)
        .map(|_| {
            let c = P::new(rng.next_f64() * 200.0, rng.next_f64() * 200.0);
            match kind {
                0 => Shape::circle(c, 1.0 + rng.next_f64() * 19.0),
                1 => {
                    let rx = 2.0 + rng.next_f64() * 18.0;
                    let ry = 2.0 + rng.next_f64() * 18.0;
                    Shape::ellipse(c, rx, ry, rng.next_f64() * 180.0)
                }
                2 => {
                    let w = 4.0 + rng.next_f64() * 36.0;
                    let h = 4.0 + rng.next_f64() * 36.0;
                    let r = rng.next_f64() * 5.0;
                    Shape::rect(c, w, h, r, rng.next_f64() * 90.0)
                }
                _ => {
                    let ring: Vec<P> = (0..8)
                        .map(|k| {
                            let (s, co) = sin_cos_deg(k as f64 * 45.0);
                            let r = 5.0 + rng.next_f64() * 15.0;
                            P::new(c.x + co * r, c.y + s * r)
                        })
                        .collect();
                    Shape::polygon(vec![ring], false, c)
                }
            }
        })
        .collect()
}

fn main() {
    let runs: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);

    // 1. rasterize 100k discs + SAT
    let grid = GridSpec::covering(&Rect::new(0.0, 0.0, 1920.0, 1080.0), 4.0);
    let mut rng = Pcg32::new(1);
    let discs: Vec<P> = (0..100_000)
        .map(|_| P::new(rng.next_f64() * 1920.0, rng.next_f64() * 1080.0))
        .collect();
    let mut sat = None;
    report(
        "raster: 100k discs r=1.5 (480x270) + SAT",
        best(runs, || {
            let mut m = MaskRaster::new(grid);
            for &c in &discs {
                m.disc(c, 1.5);
            }
            let cov = m.into_coverage();
            let s = Sat::from_coverage(grid.cols, grid.rows, &cov);
            let sum: u64 = cov.iter().map(|&v| v as u64).sum();
            sat = Some(s);
            sum as f64
        }),
    );
    let sat = sat.expect("sat");

    // 2. 1M SAT queries
    let mut rng = Pcg32::new(2);
    let pool: Vec<Rect> = (0..65_536)
        .map(|_| {
            let x = rng.next_f64() * 1940.0 - 20.0;
            let y = rng.next_f64() * 1100.0 - 20.0;
            Rect::xywh(
                x,
                y,
                5.0 + rng.next_f64() * 75.0,
                5.0 + rng.next_f64() * 25.0,
            )
        })
        .collect();
    report(
        "sat: 1M covered_area queries",
        best(runs, || {
            let mut total = 0.0;
            for i in 0..1_000_000usize {
                total += sat.covered_area(&grid, &pool[i & 65_535]);
            }
            total
        }),
    );

    // 3. spatial index: 100k points, 100k queries
    let mut rng = Pcg32::new(3);
    let boxes: Vec<Rect> = (0..100_000)
        .map(|_| {
            let p = P::new(rng.next_f64() * 1920.0, rng.next_f64() * 1080.0);
            Rect::from_center(p, 0.0, 0.0)
        })
        .collect();
    let queries: Vec<Rect> = (0..100_000)
        .map(|_| {
            let x = rng.next_f64() * 1920.0 - 40.0;
            let y = rng.next_f64() * 1080.0 - 10.0;
            Rect::xywh(
                x,
                y,
                20.0 + rng.next_f64() * 60.0,
                8.0 + rng.next_f64() * 12.0,
            )
        })
        .collect();
    let extent = Rect::new(0.0, 0.0, 1920.0, 1080.0);
    let mut ix = None;
    report(
        "index: build on 100k points (cell 16)",
        best(runs, || {
            let built = StaticIndex::new(boxes.clone(), &extent, 16.0);
            let n = built.len() as f64;
            ix = Some(built);
            n
        }),
    );
    let ix = ix.expect("index");
    report(
        "index: 100k queries",
        best(runs, || {
            let mut buf = Vec::new();
            let mut total = 0usize;
            for q in &queries {
                ix.query(q, &mut buf);
                total += buf.len();
            }
            total as f64
        }),
    );

    // 4. shape-vs-rect overlap tests
    for (kind, name) in [
        (0, "circle"),
        (1, "ellipse"),
        (2, "round rect"),
        (3, "polygon"),
    ] {
        let mut rng = Pcg32::new(4 + kind as u64);
        let ss = shapes(&mut rng, kind, 1024);
        let pairs: Vec<(usize, Rect)> = (0..4096)
            .map(|_| {
                let k = rng.next_below(1024) as usize;
                let c = ss[k].reference();
                let x = c.x + rng.next_f64() * 60.0 - 40.0;
                let y = c.y + rng.next_f64() * 40.0 - 25.0;
                (
                    k,
                    Rect::xywh(
                        x,
                        y,
                        10.0 + rng.next_f64() * 50.0,
                        6.0 + rng.next_f64() * 14.0,
                    ),
                )
            })
            .collect();
        report(
            &format!("overlaps_rect: 1M tests, {name}"),
            best(runs, || {
                let mut hits = 0usize;
                for i in 0..1_000_000usize {
                    let (k, r) = &pairs[i & 4095];
                    if ss[*k].overlaps_rect(r) {
                        hits += 1;
                    }
                }
                hits as f64
            }),
        );
    }
}
