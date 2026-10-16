//! Prints scenes as JSON (the same shape as the objects returned by
//! `@label-anything/svg`), e.g. for comparing the two implementations
//! (`ts/packages/svg/scripts/parity.mjs` does that):
//!
//! ```text
//! cargo run -p label-anything-svg --features serde --example dump -- file.svg [WxH|-] [tolerance]
//! cargo run -p label-anything-svg --features serde --example dump -- --jsonl < cases.jsonl
//! ```
//!
//! With `--jsonl`, every input line is a case
//!
//! ```text
//! {"svg": "...", "canvas": [w, h] | null, "tolerance": t | null,
//!  "rules": [{"selector": "...", "class": "..."}] | null, "default_class": "ink",
//!  "select": ["selector", ...] | null}
//! ```
//!
//! and the corresponding output line is `{"error": e}` if parsing fails, else
//! `{"scene": scene, "classified": [{"class", "index"}] | {"error": e},
//! "selected": [[primitive, ...] | {"error": e}, ...]}` (the last two only when requested).

use std::io::{BufWriter, Read, Write};

use label_anything_svg::{classify, parse, select, ClassRule, ParseOptions};
use serde_json::{json, Value};

fn options(case: &Value) -> ParseOptions<'static> {
    let mut options = ParseOptions::default();
    if let Some([w, h]) = case["canvas"].as_array().map(Vec::as_slice) {
        options.canvas = Some((w.as_f64().unwrap_or(0.0), h.as_f64().unwrap_or(0.0)));
    }
    if let Some(t) = case["tolerance"].as_f64() {
        options.tolerance = t;
    }
    options
}

fn run_case(case: &Value) -> Value {
    let svg = case["svg"].as_str().unwrap_or_default();
    let scene = match parse(svg, &options(case)) {
        Ok(scene) => scene,
        Err(e) => return json!({ "error": e }),
    };
    let mut out = json!({});
    if let Some(rules) = case["rules"].as_array() {
        let rules: Vec<ClassRule> = rules
            .iter()
            .map(|r| {
                ClassRule::new(
                    r["selector"].as_str().unwrap_or_default(),
                    r["class"].as_str().unwrap_or_default(),
                )
            })
            .collect();
        let default_class = case["default_class"].as_str().unwrap_or("ink");
        out["classified"] = match classify(&scene, &rules, default_class) {
            Ok(list) => list
                .iter()
                .map(|c| json!({ "class": c.class, "index": c.index }))
                .collect(),
            Err(e) => json!({ "error": e }),
        };
    }
    if let Some(selectors) = case["select"].as_array() {
        out["selected"] = selectors
            .iter()
            .map(|s| match select(&scene, s.as_str().unwrap_or_default()) {
                Ok(prims) => json!(prims),
                Err(e) => json!({ "error": e }),
            })
            .collect();
    }
    out["scene"] = json!(scene);
    out
}

fn jsonl() {
    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        eprintln!("cannot read stdin: {e}");
        std::process::exit(2);
    }
    let stdout = std::io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    for (n, line) in input.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let case: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("line {}: {e}", n + 1);
                std::process::exit(2);
            }
        };
        writeln!(out, "{}", run_case(&case)).expect("stdout");
    }
    out.flush().expect("stdout");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(path) = args.get(1) else {
        eprintln!("usage: dump <file.svg> [WIDTHxHEIGHT|-] [tolerance]  |  dump --jsonl");
        std::process::exit(2);
    };
    if path == "--jsonl" {
        jsonl();
        return;
    }
    let svg = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("cannot read {path}: {e}");
            std::process::exit(2);
        }
    };
    let mut options = ParseOptions::default();
    if let Some(size) = args.get(2).filter(|s| s.as_str() != "-") {
        let mut it = size
            .split('x')
            .map(|v| v.parse::<f64>().expect("canvas size"));
        options.canvas = Some((it.next().expect("width"), it.next().expect("height")));
    }
    if let Some(t) = args.get(3) {
        options.tolerance = t.parse().expect("tolerance");
    }
    match parse(&svg, &options) {
        Ok(scene) => println!("{}", serde_json::to_string(&scene).expect("serializable")),
        Err(e) => println!("{}", json!({ "error": e })),
    }
}
