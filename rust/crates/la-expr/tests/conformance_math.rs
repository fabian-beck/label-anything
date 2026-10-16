//! Runs `conformance/math/*.json` (format: `conformance/math/README.md`): every f64
//! result must match bit for bit (any NaN matches an expected NaN), and the PCG32 streams
//! must match exactly.

use label_anything_expr::det_math::{self, Pcg32};
use serde_json::Value as Json;
use std::path::{Path, PathBuf};

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance/math")
}

fn load(name: &str) -> Json {
    let path = dir().join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn hex_u64(v: &Json) -> u64 {
    let s = v.as_str().expect("hex string");
    u64::from_str_radix(s.trim_start_matches("0x"), 16).expect("hex")
}

fn f(v: &Json) -> f64 {
    f64::from_bits(hex_u64(v))
}

fn same(got: f64, want: f64) -> bool {
    (got.is_nan() && want.is_nan()) || got.to_bits() == want.to_bits()
}

fn eval(function: &str, args: &[f64]) -> Vec<f64> {
    match function {
        "ln" => vec![det_math::ln(args[0])],
        "ln_1p" => vec![det_math::ln_1p(args[0])],
        "exp" => vec![det_math::exp(args[0])],
        "pow" => vec![det_math::pow(args[0], args[1])],
        "sin_cos_deg" => {
            let (s, c) = det_math::sin_cos_deg(args[0]);
            vec![s, c]
        }
        "atan2_deg" => vec![det_math::atan2_deg(args[0], args[1])],
        "cbrt" => vec![det_math::cbrt(args[0])],
        "floor" => vec![det_math::floor(args[0])],
        "ceil" => vec![det_math::ceil(args[0])],
        "trunc" => vec![det_math::trunc(args[0])],
        "round_half_away" => vec![det_math::round_half_away(args[0])],
        other => panic!("unknown function {other}"),
    }
}

#[test]
fn function_vectors_are_bit_exact() {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir())
        .expect("conformance/math")
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    let mut checked = 0;
    for path in files {
        let name = path.file_name().unwrap().to_str().unwrap().to_string();
        let doc = load(&name);
        assert_eq!(doc["kind"], "math", "{name}");
        let function = doc["function"].as_str().unwrap();
        if function == "pcg32" {
            continue;
        }
        let n_in = doc["inputs"].as_u64().unwrap() as usize;
        let n_out = doc["outputs"].as_u64().unwrap() as usize;
        let vectors = doc["vectors"].as_array().unwrap();
        assert!(vectors.len() >= 500, "{name}: {} vectors", vectors.len());
        let mut failures = Vec::new();
        for v in vectors {
            let v = v.as_array().unwrap();
            assert_eq!(v.len(), n_in + n_out, "{name}");
            let args: Vec<f64> = v[..n_in].iter().map(f).collect();
            let got = eval(function, &args);
            for (k, want) in v[n_in..].iter().map(f).enumerate() {
                if !same(got[k], want) {
                    failures.push(format!(
                        "{function}({:?}) output {k}: got {:#018x} want {:#018x}",
                        args,
                        got[k].to_bits(),
                        want.to_bits()
                    ));
                }
            }
            checked += 1;
        }
        assert!(failures.is_empty(), "{name}: {} mismatches, e.g. {}", failures.len(), failures[0]);
    }
    assert!(checked >= 11 * 500, "only {checked} vectors");
}

#[test]
fn pcg32_vectors() {
    let doc = load("pcg32.json");
    for s in doc["streams"].as_array().unwrap() {
        let mut rng = Pcg32::new(hex_u64(&s["seed"]));
        let want: Vec<u64> = s["next_u32"].as_array().unwrap().iter().map(hex_u64).collect();
        assert_eq!(want.len(), 1000);
        for (i, w) in want.iter().enumerate() {
            assert_eq!(rng.next_u32() as u64, *w, "seed {} output {i}", s["seed"]);
        }
    }
    for c in doc["next_below"].as_array().unwrap() {
        let mut rng = Pcg32::new(hex_u64(&c["seed"]));
        let n = c["n"].as_u64().unwrap() as u32;
        for w in c["values"].as_array().unwrap() {
            assert_eq!(rng.next_below(n) as u64, w.as_u64().unwrap(), "next_below({n})");
        }
    }
    for c in doc["next_f64"].as_array().unwrap() {
        let mut rng = Pcg32::new(hex_u64(&c["seed"]));
        for w in c["values"].as_array().unwrap() {
            assert_eq!(rng.next_f64().to_bits(), hex_u64(w));
        }
    }
    for c in doc["shuffle"].as_array().unwrap() {
        let mut rng = Pcg32::new(hex_u64(&c["seed"]));
        let len = c["len"].as_u64().unwrap() as usize;
        let mut v: Vec<u64> = (0..len as u64).collect();
        rng.shuffle(&mut v);
        let want: Vec<u64> = c["result"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap()).collect();
        assert_eq!(v, want, "shuffle len {len}");
        assert_eq!(rng.next_u32() as u64, hex_u64(&c["next_u32_after"]));
    }
}
