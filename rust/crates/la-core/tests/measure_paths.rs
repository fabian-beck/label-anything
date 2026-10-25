//! Without a host measurement callback, wrapping and truncation measure their candidate
//! lines with the fonts in constant time (`la_text::Measure::Font`, ADR text/measurement); with
//! one, every line goes through `Measurer::width`. The two paths must give bit-identical label
//! variants and byte-identical results.
use label_anything_core::env::{BasicEnv, Env};
use label_anything_core::labels::{self, Measurer};
use label_anything_core::{model, place};
use serde_json::{json, Value};
use std::path::Path;

/// Declares a measurement callback that never measures, so every line takes the closure
/// path and falls back to the same fonts.
struct ClosurePath;

impl Env for ClosurePath {}

fn assert_same_results(name: &str, problem: &Value) {
    assert!(!BasicEnv.has_measure_callback() && ClosurePath.has_measure_callback());
    let fast = place(problem, &BasicEnv).unwrap_or_else(|e| panic!("{name}: {e}"));
    let closure = place(problem, &ClosurePath).unwrap_or_else(|e| panic!("{name}: {e}"));
    assert_eq!(
        serde_json::to_string(&fast).unwrap(),
        serde_json::to_string(&closure).unwrap(),
        "{name}"
    );
}

/// The base variants and the variants of every ladder step of every item, as `Debug` text
/// (which tells every f64 bit pattern apart). Returns the number of text lines compared.
fn assert_same_variants(name: &str, problem: &Value) -> usize {
    let mut m = model::build(problem, &BasicEnv).unwrap_or_else(|e| panic!("{name}: {e:?}"));
    let owned = labels::user_fonts(&mut m, &BasicEnv).unwrap();
    let fonts = owned.as_ref().unwrap_or_else(|| labels::bundled_fonts());
    let measurer = |env| Measurer {
        fonts,
        env,
        shaping: &m.shaping,
    };
    let (fast, closure) = (measurer(&BasicEnv), measurer(&ClosurePath));
    let mut lines = 0;
    for item in &m.items {
        let mut variants = [
            labels::base_variants(&fast, item),
            labels::base_variants(&closure, item),
        ];
        let (min_scale, wrap_max_lines) = (m.degrade.min_scale, m.degrade.wrap_max_lines);
        for step in &m.ladder {
            let [a, b] = [(&fast, &variants[0]), (&closure, &variants[1])].map(|(measurer, v)| {
                labels::ladder_variants(measurer, item, step, v, min_scale, wrap_max_lines)
            });
            variants[0].extend(a);
            variants[1].extend(b);
        }
        assert_eq!(
            format!("{:?}", variants[0]),
            format!("{:?}", variants[1]),
            "{name}: item {}",
            item.id
        );
        lines += variants[0].iter().map(|v| v.lines()).sum::<usize>();
    }
    lines
}

fn conformance(dir: &str) -> Vec<(String, Value)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../conformance")
        .join(dir);
    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    paths.sort();
    paths
        .into_iter()
        .map(|p| {
            let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
            (p.file_stem().unwrap().to_string_lossy().into_owned(), v)
        })
        .collect()
}

#[test]
fn sample_problems_and_place_cases() {
    for (name, problem) in conformance("problems") {
        assert_same_results(&name, &problem);
    }
    // the other place cases reference the sample problems
    for (name, case) in conformance("place") {
        if let Some(problem) = case.get("problem") {
            assert_same_results(&name, problem);
        }
    }
}

/// A data URL (percent-encoded) of a synthetic font whose kern pair `T o` skips its second
/// glyph (ValueFormat2 ≠ 0) and whose acute accent is a GDEF mark.
fn synthetic_gpos_font() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../conformance/text/fonts/synthetic-gpos.ttf");
    let bytes = std::fs::read(path).unwrap();
    let encoded: String = bytes.iter().map(|b| format!("%{b:02X}")).collect();
    format!("data:font/ttf,{encoded}")
}

/// Far more labels than fit: long qualified class names without wrap settings (the `wrap`
/// ladder step), with wrap settings and every truncation mode, alternatives, bold text,
/// combining marks, a Hebrew name, and a user font, with a `truncate` ladder step.
fn crowded(shaping: &str) -> Value {
    const NAMES: [&str; 8] = [
        "com.facebook.react.uimanager.layoutanimation.LayoutAnimationController",
        "org.springframework.beans.factory.support.DefaultListableBeanFactory",
        "java.util.concurrent.ConcurrentHashMap$KeySetView",
        "XMLHttpRequestFactory",
        "Cre\u{300}me bru\u{302}le\u{301}e a\u{300} la carte, Ste\u{301}phane",
        "\u{5e9}\u{5dc}\u{5d5}\u{5dd} \u{5e2}\u{5d5}\u{5dc}\u{5dd} hello.world",
        "Toa.ToToa-AVAVA yo\u{301}To ToaB.CyTo",
        "std::collections::HashMap<String, Vec<u8>>",
    ];
    let font_file = synthetic_gpos_font();
    let items: Vec<Value> = (0..48)
        .map(|i| {
            let name = NAMES[i % NAMES.len()];
            let mut label = json!({"type": "text", "text": format!("{name}{i}")});
            match i % 6 {
                1 => label["wrap"] = json!({"max_width": 60 + i % 50, "max_lines": 1 + i % 4}),
                2 => {
                    label["wrap"] = json!({"max_width": 50, "max_lines": 2});
                    label["truncate"] = json!(["end", "middle", "none"][i % 3]);
                }
                3 => label["alternatives"] = json!([name.rsplit('.').next().unwrap(), "x.y"]),
                4 => label["font"] = json!({"weight": "bold", "size": 9}),
                _ => {}
            }
            if name.starts_with("Toa") && i % 3 != 0 {
                label["font"] = json!({"family": "Synthetic", "file": font_file});
            }
            let (x, y) = (30.0 + (i % 12) as f64 * 28.0, 25.0 + (i / 12) as f64 * 22.0);
            json!({"id": format!("i{i}"), "anchor": {"type": "point", "x": x, "y": y},
                   "label": label, "priority": (i % 7) as f64})
        })
        .collect();
    json!({
        "canvas": {"width": 400, "height": 120},
        "items": items,
        "text": {"shaping": shaping},
        "degrade": ["alternatives", "wrap", "truncate", "distant", "shrink:0.85", "omit"],
        "solver": {"max_iterations": 2000}
    })
}

/// (`full` shaping measures every line with the closure on both paths, see the unit tests
/// of `Measurer::wrap_measure`.)
#[test]
fn crowded_labels() {
    for shaping in ["auto", "simple"] {
        let problem = crowded(shaping);
        let lines = assert_same_variants(shaping, &problem);
        assert!(lines > 500, "{shaping}: {lines} lines");
        assert_same_results(shaping, &problem);
    }
}
