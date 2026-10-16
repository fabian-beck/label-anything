//! Runs the `text` conformance cases in `conformance/text/*.json` (see
//! `tools/text/gen_text_cases.py` for the keys). Widths must match within the case's
//! tolerance and, stricter, be bit-identical to the reference values.
#![cfg(feature = "bundled-font")]

use std::path::{Path, PathBuf};

use label_anything_text::{
    balanced_wrap, break_opportunities, extra_wrap_variants, greedy_wrap, truncate_end,
    truncate_middle, wrap_variants, Font, FontBook, TextVariant, Truncate, WrapOptions,
};
use serde_json::Value;

fn case_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance/text")
}

fn str_of(v: &Value) -> &str {
    v.as_str().expect("string")
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .expect("array")
        .iter()
        .map(|s| str_of(s).to_owned())
        .collect()
}

fn opt_width(v: &Value) -> Option<f64> {
    v.as_f64()
}

/// Resolves `font` of a case: a file relative to the case directory, or a bundled family.
fn load_font<'a>(book: &'a mut FontBook, spec: &Value) -> &'a Font {
    let weight = match &spec["weight"] {
        Value::String(w) if w == "bold" => 700,
        Value::Number(n) => n.as_u64().expect("weight") as u16,
        _ => 400,
    };
    let italic = spec["style"].as_str() == Some("italic");
    let id = match spec["file"].as_str() {
        Some(file) => {
            let data = std::fs::read(case_dir().join(file)).expect("font file");
            book.register(file, weight, italic, data)
                .expect("valid font")
        }
        None => book.resolve(spec["family"].as_str().unwrap_or("default"), weight, italic),
    };
    book.font(id)
}

fn check_variants(errors: &mut Vec<String>, context: &str, got: &[TextVariant], expected: &Value) {
    let expected = expected.as_array().expect("variants");
    if got.len() != expected.len() {
        errors.push(format!(
            "{context}: {} variants, expected {}",
            got.len(),
            expected.len()
        ));
        return;
    }
    for (g, e) in got.iter().zip(expected) {
        let lines = strings(&e["lines"]);
        if g.lines != lines || g.truncated != e["truncated"].as_bool().unwrap() {
            errors.push(format!(
                "{context}: {:?} (truncated {}), expected {lines:?}",
                g.lines, g.truncated
            ));
        }
        let widths: Vec<f64> = e["widths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w.as_f64().unwrap())
            .collect();
        if g.widths.len() != widths.len()
            || g.widths
                .iter()
                .zip(&widths)
                .any(|(a, b)| (a - b).abs() > 0.01)
        {
            errors.push(format!(
                "{context}: widths {:?}, expected {widths:?}",
                g.widths
            ));
        }
    }
}

fn run_case(name: &str, case: &Value, errors: &mut Vec<String>) -> usize {
    assert_eq!(case["kind"], "text", "{name}");
    let mut book = FontBook::with_bundled();
    let font = load_font(&mut book, &case["font"]);
    let size = case["size"].as_f64().expect("size");
    let measure = |s: &str| font.width(s, size);
    let mut checked = 0;
    let mut fail = |message: String| errors.push(format!("{name}: {message}"));

    if let Some(m) = case.get("metrics") {
        let got: (i64, i64, i64, i64) = (
            font.units_per_em().into(),
            font.ascender().into(),
            font.descender().into(),
            font.line_gap().into(),
        );
        let expected = (
            m["units_per_em"].as_i64(),
            m["ascender"].as_i64(),
            m["descender"].as_i64(),
            m["line_gap"].as_i64(),
        );
        if (Some(got.0), Some(got.1), Some(got.2), Some(got.3)) != expected {
            fail(format!("metrics {got:?}, expected {expected:?}"));
        }
        checked += 1;
    }
    for entry in case["widths"].as_array().into_iter().flatten() {
        let text = str_of(&entry["text"]);
        let expected = entry["width"].as_f64().unwrap();
        let width = font.width(text, size);
        if (width - expected).abs() > entry["tol"].as_f64().unwrap_or(0.01) {
            fail(format!("width({text:?}) = {width}, expected {expected}"));
        } else if width.to_bits() != expected.to_bits() {
            fail(format!(
                "width({text:?}) = {width:?} is not bit-identical to {expected:?}"
            ));
        }
        if let Some(units) = entry["units"].as_i64() {
            if font.advance_units(text) != units {
                fail(format!(
                    "advance_units({text:?}) = {}, expected {units}",
                    font.advance_units(text)
                ));
            }
        }
        checked += 1;
    }
    for entry in case["breaks"].as_array().into_iter().flatten() {
        let text = str_of(&entry["text"]);
        let expected: Vec<usize> = entry["breaks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_u64().unwrap() as usize)
            .collect();
        if break_opportunities(text) != expected {
            fail(format!(
                "breaks({text:?}) = {:?}, expected {expected:?}",
                break_opportunities(text)
            ));
        }
        checked += 1;
    }
    for entry in case["wrap"].as_array().into_iter().flatten() {
        let (text, w) = (str_of(&entry["text"]), entry["max_width"].as_f64().unwrap());
        let got = greedy_wrap(text, w, &measure);
        if got != strings(&entry["lines"]) {
            fail(format!(
                "greedy({text:?}, {w}) = {got:?}, expected {:?}",
                entry["lines"]
            ));
        }
        checked += 1;
    }
    for entry in case["balanced"].as_array().into_iter().flatten() {
        let text = str_of(&entry["text"]);
        let n = entry["lines_target"].as_u64().unwrap() as usize;
        let m = opt_width(&entry["max_width"]);
        let got = balanced_wrap(text, n, m, &measure);
        if got != strings(&entry["lines"]) {
            fail(format!(
                "balanced({text:?}, {n}, {m:?}) = {got:?}, expected {:?}",
                entry["lines"]
            ));
        }
        checked += 1;
    }
    for entry in case["truncate"].as_array().into_iter().flatten() {
        let (text, w) = (str_of(&entry["text"]), entry["max_width"].as_f64().unwrap());
        let got = match str_of(&entry["mode"]) {
            "end" => vec![truncate_end(text, w, &measure)],
            _ => truncate_middle(
                text,
                w,
                entry["max_lines"].as_u64().unwrap_or(1) as usize,
                &measure,
            ),
        };
        let expected = match entry.get("result") {
            Some(result) => vec![str_of(result).to_owned()],
            None => strings(&entry["lines"]),
        };
        if got != expected {
            fail(format!(
                "truncate {}({text:?}, {w}) = {got:?}, expected {expected:?}",
                entry["mode"]
            ));
        }
        checked += 1;
    }
    for entry in case["variants"].as_array().into_iter().flatten() {
        let text = str_of(&entry["text"]);
        let o = &entry["options"];
        let opts = WrapOptions {
            max_width: opt_width(&o["max_width"]),
            max_lines: o["max_lines"].as_u64().map_or(usize::MAX, |n| n as usize),
            balance: o["balance"].as_bool().unwrap_or(true),
            truncate: match o["truncate"].as_str() {
                Some("end") => Truncate::End,
                Some("middle") => Truncate::Middle,
                _ => Truncate::None,
            },
        };
        let got = wrap_variants(text, &opts, &measure);
        check_variants(
            errors,
            &format!("{name}: variants({text:?}, {o})"),
            &got,
            &entry["variants"],
        );
        checked += 1;
    }
    for entry in case["extra_variants"].as_array().into_iter().flatten() {
        let text = str_of(&entry["text"]);
        let n = entry["max_lines"].as_u64().unwrap() as usize;
        let got = extra_wrap_variants(text, n, &measure);
        check_variants(
            errors,
            &format!("{name}: extra_variants({text:?}, {n})"),
            &got,
            &entry["variants"],
        );
        checked += 1;
    }
    checked
}

#[test]
fn text_conformance() {
    let mut files: Vec<PathBuf> = std::fs::read_dir(case_dir())
        .expect("conformance/text exists")
        .map(|entry| entry.expect("readable").path())
        .filter(|path| path.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no text conformance cases");
    let mut errors = Vec::new();
    let mut checked = 0;
    for path in &files {
        let case: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        checked += run_case(
            &path.file_name().unwrap().to_string_lossy(),
            &case,
            &mut errors,
        );
    }
    assert!(
        errors.is_empty(),
        "{} of {checked} checks failed:\n{}",
        errors.len(),
        errors.join("\n")
    );
    assert!(checked > 500, "only {checked} checks");
}
