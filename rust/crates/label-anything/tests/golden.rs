//! Golden visual tests of the debug renderer (brief §9): solve sample problems (without
//! deadlines, so deterministically), render the debug SVG, rasterize it with resvg and the
//! bundled Noto Sans, and compare with `tests/golden/<name>.png` within a pixel tolerance.
//!
//! Regenerate after an intended change: `LA_UPDATE_GOLDEN=1 cargo test -p label-anything --test golden`.
use std::path::PathBuf;

use resvg::{tiny_skia, usvg};
use serde_json::{json, Value};

const PROBLEMS: [&str; 6] = [
    "scatter-basic",
    "leaders-angles",
    "area-anchor",
    "icons-composite",
    "shapes-nodes",
    "elbow-boundary",
];

/// Pixels whose channels differ by more than this count as different.
const CHANNEL_TOLERANCE: u8 = 48;
/// Fraction of pixels allowed to differ (anti-aliasing across platforms).
const PIXEL_TOLERANCE: f64 = 0.005;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn rasterize(svg: &str) -> tiny_skia::Pixmap {
    let mut opt = usvg::Options::default();
    let fonts = opt.fontdb_mut();
    for f in ["NotoSans-Regular.ttf", "NotoSans-Bold.ttf"] {
        fonts.load_font_data(std::fs::read(repo().join("fonts").join(f)).unwrap());
    }
    fonts.set_sans_serif_family("Noto Sans");
    let tree = usvg::Tree::from_str(svg, &opt).expect("debug SVG parses");
    let size = tree.size().to_int_size();
    let mut pixmap = tiny_skia::Pixmap::new(size.width(), size.height()).unwrap();
    resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());
    pixmap
}

fn render(name: &str) -> tiny_skia::Pixmap {
    let path = repo()
        .join("conformance/problems")
        .join(format!("{name}.json"));
    let mut problem: Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    // no deadline: the result depends on iteration counts only
    problem["solver"]["time_budget_ms"] = json!(1e7);
    let mut result = label_anything::place(&problem).unwrap();
    result["stats"]["runtime_ms"] = json!(0.0);
    let env = label_anything::NativeEnv::new();
    rasterize(&label_anything::render_svg(&problem, &result, &env))
}

#[test]
fn debug_renderings_match_the_golden_images() {
    let update = std::env::var_os("LA_UPDATE_GOLDEN").is_some();
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let mut failures = Vec::new();
    for name in PROBLEMS {
        let got = render(name);
        let file = dir.join(format!("{name}.png"));
        if update {
            std::fs::create_dir_all(&dir).unwrap();
            got.save_png(&file).unwrap();
            continue;
        }
        let Ok(want) = tiny_skia::Pixmap::load_png(&file) else {
            failures.push(format!(
                "{name}: missing {} (run with LA_UPDATE_GOLDEN=1)",
                file.display()
            ));
            continue;
        };
        if (got.width(), got.height()) != (want.width(), want.height()) {
            failures.push(format!(
                "{name}: size {}x{} instead of {}x{}",
                got.width(),
                got.height(),
                want.width(),
                want.height()
            ));
            continue;
        }
        let differ = got
            .data()
            .chunks_exact(4)
            .zip(want.data().chunks_exact(4))
            .filter(|(a, b)| {
                a.iter()
                    .zip(b.iter())
                    .any(|(x, y)| x.abs_diff(*y) > CHANNEL_TOLERANCE)
            })
            .count();
        let total = (got.width() * got.height()) as f64;
        if differ as f64 > PIXEL_TOLERANCE * total {
            let out = std::env::temp_dir().join(format!("la-golden-{name}.png"));
            let _ = got.save_png(&out);
            failures.push(format!(
                "{name}: {differ} pixels differ ({:.2} %), rendering written to {}",
                100.0 * differ as f64 / total,
                out.display()
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
