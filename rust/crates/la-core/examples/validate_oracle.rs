//! Reference reports for differential tests of the TypeScript validator
//! (`ts/packages/core/src/validate.ts`): prints what the Rust validator reports.
//!
//! ```text
//! validate_oracle FILE...            one report per file; its JSON text goes through validate_str
//! validate_oracle --batch            one report per element of the JSON array on stdin (validate)
//! validate_oracle --batch --text     the array elements are strings of JSON text (validate_str)
//! --values                           with --text: parse only, print `{"value": ..}` or
//!                                    `{"error": message}` per text instead of reports
//! --repeat N                         also time every input: median of N runs, on stderr
//! ```
//!
//! Output (stdout): a JSON array of reports `{"valid", "errors", "warnings"}` (issues with
//! `pointer`, `code`, `message`) in input order. Run it with
//! `cargo run -p label-anything-core --example validate_oracle -- ...`; it drives
//! `tools/validate/parity.mjs` (fixtures and fuzzing).

use label_anything_core::validate::{validate, validate_str, Report};
use serde_json::Value;
use std::io::Read;
use std::process::ExitCode;
use std::time::{Duration, Instant};

enum Input {
    Text(String),
    Value(Value),
}

impl Input {
    fn report(&self) -> Report {
        match self {
            Input::Text(s) => validate_str(s),
            Input::Value(v) => validate(v),
        }
    }
}

const USAGE: &str =
    "usage: validate_oracle [--repeat N] FILE... | --batch [--text [--values]] [--repeat N] < array.json";

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let (mut batch, mut text, mut values, mut repeat) = (false, false, false, 0usize);
    let mut files = Vec::new();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--batch" => batch = true,
            "--text" => text = true,
            "--values" => values = true,
            "--repeat" => {
                repeat = args
                    .next()
                    .and_then(|n| n.parse().ok())
                    .ok_or_else(|| USAGE.to_string())?
            }
            "-h" | "--help" => return Err(USAGE.to_string()),
            _ => files.push(a),
        }
    }
    let inputs: Vec<Input> = if batch {
        let mut s = String::new();
        std::io::stdin()
            .read_to_string(&mut s)
            .map_err(|e| format!("stdin: {e}"))?;
        let all: Vec<Value> = serde_json::from_str(&s).map_err(|e| format!("stdin: {e}"))?;
        all.into_iter()
            .map(|v| match (text, v) {
                (true, Value::String(s)) => Ok(Input::Text(s)),
                (true, _) => Err("--text: every element must be a string".to_string()),
                (false, v) => Ok(Input::Value(v)),
            })
            .collect::<Result<_, _>>()?
    } else if files.is_empty() {
        return Err(USAGE.to_string());
    } else {
        files
            .iter()
            .map(|f| {
                std::fs::read_to_string(f)
                    .map(Input::Text)
                    .map_err(|e| format!("{f}: {e}"))
            })
            .collect::<Result<_, _>>()?
    };
    if values {
        // serde_json's reading of each text (the TypeScript reader must agree bit for bit)
        let out: Vec<Value> = inputs
            .iter()
            .map(|i| match i {
                Input::Text(s) => match serde_json::from_str::<Value>(s) {
                    Ok(v) => serde_json::json!({ "value": v }),
                    Err(e) => serde_json::json!({ "error": e.to_string() }),
                },
                Input::Value(_) => serde_json::json!({ "error": "--values needs --text" }),
            })
            .collect();
        println!(
            "{}",
            serde_json::to_string(&out).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    let reports: Vec<Report> = inputs.iter().map(Input::report).collect();
    if repeat > 0 {
        for (k, input) in inputs.iter().enumerate() {
            let mut times: Vec<Duration> = (0..repeat)
                .map(|_| {
                    let t = Instant::now();
                    std::hint::black_box(input.report());
                    t.elapsed()
                })
                .collect();
            times.sort();
            eprintln!(
                "input {k}: median {:.3} ms, min {:.3} ms ({repeat} runs)",
                times[times.len() / 2].as_secs_f64() * 1e3,
                times[0].as_secs_f64() * 1e3
            );
        }
    }
    let out = serde_json::to_string(&reports).map_err(|e| e.to_string())?;
    println!("{out}");
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("validate_oracle: {e}");
            ExitCode::from(2)
        }
    }
}
