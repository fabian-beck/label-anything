//! The Rust validator reproduces the committed reports in `conformance/validate/reports/`,
//! which the TypeScript validator must match exactly (`ts/packages/core/test/`). When the
//! validator, the schema or the cases change, regenerate them with
//! `node tools/validate/parity.mjs reports` and `node tools/validate/parity.mjs mutants`.
use label_anything_core::validate::{validate, validate_str, Report};
use serde_json::Value;
use std::path::{Path, PathBuf};

fn conformance_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance")
}

fn read_json(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn json_files(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    names
}

fn as_value(report: &Report) -> Value {
    serde_json::to_value(report).unwrap()
}

#[test]
fn reference_reports_are_up_to_date() {
    let dir = conformance_dir();
    let fixture = read_json(&dir.join("validate/reports/rust.json"));
    let reports = fixture["reports"].as_object().expect("reports");
    // one report per sample problem and per validate case with an inline problem
    let mut keys = Vec::new();
    for name in json_files(&dir.join("problems")) {
        keys.push(format!("problems/{name}"));
    }
    for name in json_files(&dir.join("validate")) {
        let case = read_json(&dir.join("validate").join(&name));
        if case.get("problem").is_some() {
            keys.push(format!("validate/{name}"));
        }
    }
    let have: Vec<&String> = reports.keys().collect();
    assert_eq!(
        have,
        keys.iter().collect::<Vec<_>>(),
        "conformance/validate/reports/rust.json is stale; run: node tools/validate/parity.mjs reports"
    );
    let mut stale = Vec::new();
    for (key, expected) in reports {
        let path = dir.join(key);
        let report = if key.starts_with("problems/") {
            validate_str(&std::fs::read_to_string(&path).unwrap())
        } else {
            validate(&read_json(&path)["problem"])
        };
        if as_value(&report) != *expected {
            stale.push(format!(
                "{key}: {}",
                serde_json::to_string(&report).unwrap()
            ));
        }
    }
    assert!(
        stale.is_empty(),
        "stale reports (run: node tools/validate/parity.mjs reports):\n{}",
        stale.join("\n")
    );
}

#[test]
fn mutant_reports_are_up_to_date() {
    let fixture = read_json(&conformance_dir().join("validate/reports/mutants.json"));
    let cases = fixture["cases"].as_array().expect("cases");
    assert!(cases.len() >= 200, "only {} mutants", cases.len());
    let mut stale = Vec::new();
    for case in cases {
        let report = match (case.get("problem"), case.get("text")) {
            (Some(problem), None) => validate(problem),
            (None, Some(Value::String(text))) => validate_str(text),
            _ => panic!("a case has either `problem` or `text`: {case}"),
        };
        if as_value(&report) != case["report"] {
            stale.push(format!(
                "{}: {}",
                case["name"].as_str().unwrap_or("?"),
                serde_json::to_string(&report).unwrap()
            ));
        }
    }
    assert!(
        stale.is_empty(),
        "{} stale mutant report(s) (run: node tools/validate/parity.mjs mutants):\n{}",
        stale.len(),
        stale.join("\n")
    );
}
