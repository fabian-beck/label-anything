//! Runs `conformance/validate/*.json` against the Rust validator.
use label_anything_core::validate::validate;
use serde_json::Value;
use std::path::{Path, PathBuf};

fn conformance_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance")
}

#[test]
fn validate_cases() {
    let dir = conformance_dir().join("validate");
    let mut n = 0;
    let mut failures = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    entries.sort();
    for path in entries
        .into_iter()
        .filter(|p| p.extension().map(|e| e == "json").unwrap_or(false))
    {
        let case: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let mut problems = Vec::new();
        if let Some(p) = case.get("problem") {
            problems.push((path.display().to_string(), p.clone()));
        }
        for f in case
            .get("problem_files")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .chain(case.get("problem_file"))
        {
            let fp = dir.join(f.as_str().unwrap());
            let p: Value = serde_json::from_str(&std::fs::read_to_string(&fp).unwrap()).unwrap();
            problems.push((fp.display().to_string(), p));
        }
        let exp = &case["expect"];
        for (name, p) in problems {
            n += 1;
            let r = validate(&p);
            if r.valid != exp["valid"].as_bool().unwrap() {
                failures.push(format!(
                    "{name}: valid={} expected {} errors={:?}",
                    r.valid, exp["valid"], r.errors
                ));
                continue;
            }
            for e in exp
                .get("errors")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
            {
                let (ptr, code) = (e["pointer"].as_str().unwrap(), e["code"].as_str().unwrap());
                if !r.errors.iter().any(|x| x.pointer == ptr && x.code == code) {
                    failures.push(format!(
                        "{name}: missing error {ptr} {code}; got {:?}",
                        r.errors
                    ));
                }
            }
            for w in exp
                .get("warnings")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
            {
                let (ptr, code) = (w["pointer"].as_str().unwrap(), w["code"].as_str().unwrap());
                if !r
                    .warnings
                    .iter()
                    .any(|x| x.pointer == ptr && x.code == code)
                {
                    failures.push(format!(
                        "{name}: missing warning {ptr} {code}; got {:?}",
                        r.warnings
                    ));
                }
            }
            if exp.get("exact").and_then(|v| v.as_bool()).unwrap_or(false) {
                let want = exp["errors"].as_array().map(|a| a.len()).unwrap_or(0);
                if r.errors.len() != want {
                    failures.push(format!(
                        "{name}: expected exactly {want} errors, got {:?}",
                        r.errors
                    ));
                }
            }
        }
    }
    assert!(n >= 20, "only {n} problems checked");
    assert!(
        failures.is_empty(),
        "{} failure(s):\n{}",
        failures.len(),
        failures.join("\n")
    );
}
