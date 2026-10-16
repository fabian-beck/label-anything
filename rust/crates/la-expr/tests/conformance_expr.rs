//! Runs `conformance/expr/*.json` (format: `conformance/README.md`, "expr cases").
//! Values must match exactly: numbers bit for bit (so `-0` ≠ `0`), strings, lists and
//! objects structurally.

use label_anything_expr::{parse, term_number, truthy, Context, Value};
use serde_json::Value as Json;
use std::path::{Path, PathBuf};

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance/expr")
}

/// Exact equality: like `values_equal`, but numbers must have identical bits.
fn identical(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Num(x), Value::Num(y)) => x.to_bits() == y.to_bits(),
        (Value::List(x), Value::List(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| identical(p, q))
        }
        (Value::Obj(x), Value::Obj(y)) => {
            x.len() == y.len()
                && x.iter()
                    .zip(y)
                    .all(|((k1, v1), (k2, v2))| k1 == k2 && identical(v1, v2))
        }
        _ => a == b,
    }
}

struct Ctx {
    attrs: Value,
    id: String,
    index: usize,
    text: String,
    priority: Option<f64>,
    tier: Option<i64>,
    x: f64,
    y: f64,
}

impl Ctx {
    fn apply(&mut self, c: &Json) {
        let Some(o) = c.as_object() else { return };
        if let Some(v) = o.get("attrs") {
            self.attrs = Value::from(v);
        }
        if let Some(v) = o.get("id") {
            self.id = v.as_str().expect("id").to_string();
        }
        if let Some(v) = o.get("index") {
            self.index = v.as_u64().expect("index") as usize;
        }
        if let Some(v) = o.get("text") {
            self.text = v.as_str().expect("text").to_string();
        }
        if let Some(v) = o.get("priority") {
            self.priority = v.as_f64();
        }
        if let Some(v) = o.get("tier") {
            self.tier = v.as_i64();
        }
        if let Some(v) = o.get("x") {
            self.x = v.as_f64().expect("x");
        }
        if let Some(v) = o.get("y") {
            self.y = v.as_f64().expect("y");
        }
    }

    fn get(&self) -> Context<'_> {
        Context {
            attrs: &self.attrs,
            id: &self.id,
            index: self.index,
            text: &self.text,
            priority: self.priority,
            tier: self.tier,
            x: self.x,
            y: self.y,
        }
    }
}

fn context(file: &Json, case: &Json) -> Ctx {
    let mut c = Ctx {
        attrs: Value::Obj(Default::default()),
        id: String::new(),
        index: 0,
        text: String::new(),
        priority: None,
        tier: None,
        x: 0.0,
        y: 0.0,
    };
    c.apply(&file["context"]);
    c.apply(&case["context"]);
    c
}

fn run_case(file: &Json, case: &Json) -> Result<(), String> {
    let src = case["expr"].as_str().ok_or("missing expr")?;
    let parsed = parse(src);
    if let Some(code) = case.get("error") {
        let e = match parsed {
            Ok(_) => return Err(format!("expected error {code}, parsed fine")),
            Err(e) => e,
        };
        if e.code != code.as_str().unwrap() {
            return Err(format!("expected {code}, got {} ({})", e.code, e.message));
        }
        if let Some(off) = case.get("offset") {
            if e.offset as u64 != off.as_u64().unwrap() {
                return Err(format!(
                    "expected offset {off}, got {} ({})",
                    e.offset, e.message
                ));
            }
        }
        if e.message.is_empty() {
            return Err("empty message".into());
        }
        return Ok(());
    }
    let expr = parsed.map_err(|e| format!("unexpected error: {e}"))?;
    let c = context(file, case);
    let ctx = c.get();
    let got = expr.eval(&ctx);
    if let Some(want) = case.get("value") {
        let want = Value::from(want);
        if !identical(&got, &want) {
            return Err(format!("got {got:?}, want {want:?}"));
        }
    } else {
        return Err("case has neither value nor error".into());
    }
    if let Some(t) = case.get("truthy") {
        let t = t.as_bool().unwrap();
        if truthy(&got) != t || expr.matches(&ctx) != t {
            return Err(format!("truthy: want {t}"));
        }
    }
    if let Some(t) = case.get("term") {
        let want = t.as_f64();
        let same = |v: Option<f64>| match (v, want) {
            (Some(a), Some(b)) => a.to_bits() == b.to_bits(),
            (None, None) => true,
            _ => false,
        };
        if !same(term_number(&got)) || !same(expr.eval_number(&ctx)) {
            return Err(format!("term: got {:?}, want {want:?}", term_number(&got)));
        }
    }
    Ok(())
}

#[test]
fn expr_conformance() {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir())
        .expect("conformance/expr")
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    let mut total = 0;
    let mut failures = Vec::new();
    for path in &files {
        let text = std::fs::read_to_string(path).unwrap();
        let file: Json = serde_json::from_str(&text).unwrap();
        assert_eq!(file["kind"], "expr", "{}", path.display());
        for case in file["cases"].as_array().unwrap() {
            total += 1;
            if let Err(msg) = run_case(&file, case) {
                let name = path.file_name().unwrap().to_string_lossy();
                let src: String = case["expr"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .take(80)
                    .collect();
                failures.push(format!("{name}: {src:?}: {msg}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {total} cases failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(total >= 200, "only {total} cases");
    eprintln!("{total} expr conformance cases passed");
}
