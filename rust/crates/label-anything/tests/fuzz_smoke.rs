//! Deterministic mutation fuzzing of the untrusted inputs (brief §9): problem JSON, SVG
//! backgrounds and raster images. Every input must yield a result or a structured error,
//! never a panic. Seeds are the conformance inputs; mutations come from a fixed-seed
//! generator, so failures reproduce. `LA_FUZZ_CASES` raises the count per target
//! (default 1500); coverage-guided fuzzing lives in `rust/fuzz` (cargo-fuzz).
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
}

const INTERESTING: [&[u8]; 14] = [
    b"0",
    b"-0",
    b"1e308",
    b"-1e308",
    b"1e-320",
    b"4294967296",
    b"-1",
    b"null",
    b"true",
    b"\"\"",
    b"[]",
    b"{}",
    b"\"\\u0000\xc3\xa9\xf0\x9f\x98\x80\"",
    b"9007199254740993",
];

/// One random byte-level mutation (bit flips, deletions, duplications, splices, tokens).
fn mutate(rng: &mut Rng, data: &[u8], other: &[u8]) -> Vec<u8> {
    let mut v = data.to_vec();
    for _ in 0..1 + rng.below(4) {
        let n = v.len();
        match rng.below(7) {
            0 if n > 0 => {
                let i = rng.below(n);
                v[i] ^= 1 << rng.below(8);
            }
            1 if n > 0 => {
                let i = rng.below(n);
                let len = 1 + rng.below((n - i).min(64));
                v.drain(i..i + len);
            }
            2 if n > 0 => {
                let i = rng.below(n);
                let len = 1 + rng.below((n - i).min(64));
                let chunk = v[i..i + len].to_vec();
                let at = rng.below(v.len() + 1);
                v.splice(at..at, chunk);
            }
            3 if !other.is_empty() => {
                let i = rng.below(other.len());
                let len = 1 + rng.below((other.len() - i).min(256));
                let at = rng.below(v.len() + 1);
                v.splice(at..at, other[i..i + len].iter().copied());
            }
            4 => {
                // replace a run of digits (or anything) with an interesting token
                let tok = INTERESTING[rng.below(INTERESTING.len())];
                let at = rng.below(v.len() + 1);
                let end = (at + rng.below(6)).min(v.len());
                v.splice(at..end, tok.iter().copied());
            }
            5 if n > 0 => v.truncate(rng.below(n)),
            _ => {
                let at = rng.below(v.len() + 1);
                v.insert(at, rng.next() as u8);
            }
        }
    }
    v
}

/// Schema words, so that structural mutations produce mostly well-formed problems.
const WORDS: [&str; 40] = [
    "point",
    "area",
    "circle",
    "ellipse",
    "rect",
    "polygon",
    "path",
    "icon",
    "from_svg",
    "text",
    "box",
    "composite",
    "hard",
    "ignore",
    "adjacent",
    "slider",
    "distant",
    "boundary",
    "internal",
    "straight",
    "angles",
    "orthogonal",
    "elbow",
    "curved",
    "strict",
    "prefix",
    "weighted",
    "greedy",
    "local",
    "auto",
    "points",
    "lines",
    "ink",
    "labels",
    "items",
    "em",
    "2em",
    "3pt",
    "M0 0L5 5Z",
    "x + 1",
];
const KEYS: [&str; 24] = [
    "x",
    "y",
    "r",
    "w",
    "h",
    "rx",
    "ry",
    "rotation",
    "points",
    "polygon",
    "holes",
    "mark",
    "label",
    "text",
    "font",
    "size",
    "wrap",
    "max_width",
    "priority",
    "tier",
    "required",
    "group",
    "keep_with",
    "padding",
];

fn interesting_number(rng: &mut Rng) -> Value {
    match rng.below(10) {
        0 => json!(0),
        1 => json!(-1),
        2 => json!(1e308),
        3 => json!(-1e308),
        4 => json!(1e-310),
        5 => json!(4294967296u64),
        6 => json!(-0.0),
        7 => json!(0.5),
        8 => json!(1e6),
        _ => json!(rng.below(1000) as f64 - 500.0),
    }
}

fn random_value(rng: &mut Rng) -> Value {
    match rng.below(8) {
        0 => Value::Null,
        1 => json!(rng.below(2) == 0),
        2 | 3 => interesting_number(rng),
        4 | 5 => json!(WORDS[rng.below(WORDS.len())]),
        6 => json!([interesting_number(rng), interesting_number(rng)]),
        _ => json!({}),
    }
}

/// One structural mutation of a JSON value: replace, delete, duplicate or insert.
fn mutate_json(rng: &mut Rng, v: &mut Value, depth: usize) {
    let descend = depth < 12 && rng.below(4) != 0;
    match v {
        Value::Object(m) if !m.is_empty() => {
            let keys: Vec<String> = m.keys().cloned().collect();
            let k = &keys[rng.below(keys.len())];
            if descend {
                mutate_json(rng, m.get_mut(k).unwrap(), depth + 1);
            } else {
                match rng.below(3) {
                    0 => {
                        m.remove(k);
                    }
                    1 => {
                        m.insert(KEYS[rng.below(KEYS.len())].to_string(), random_value(rng));
                    }
                    _ => {
                        m.insert(k.clone(), random_value(rng));
                    }
                }
            }
        }
        Value::Array(a) if !a.is_empty() => {
            let i = rng.below(a.len());
            if descend {
                mutate_json(rng, &mut a[i], depth + 1);
            } else {
                match rng.below(4) {
                    0 => {
                        a.remove(i);
                    }
                    1 => {
                        let dup = a[i].clone();
                        for _ in 0..1 + rng.below(3) {
                            a.insert(i, dup.clone());
                        }
                    }
                    2 => a.reverse(),
                    _ => a[i] = random_value(rng),
                }
            }
        }
        _ => *v = random_value(rng),
    }
}

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn files(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == ext))
        .collect();
    v.sort();
    v
}

fn cases() -> usize {
    std::env::var("LA_FUZZ_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1500)
}

/// Runs `f` on every seed, then on byte mutations of them; collects inputs that panic.
fn fuzz(name: &str, seeds: &[Vec<u8>], seed: u64, f: impl Fn(&[u8])) {
    let mut rng = Rng(seed);
    let mut failures = Vec::new();
    for k in 0..seeds.len() + cases() {
        let input = if k < seeds.len() {
            seeds[k].clone()
        } else {
            let a = &seeds[rng.below(seeds.len())];
            let b = &seeds[rng.below(seeds.len())];
            mutate(&mut rng, a, b)
        };
        // an abort (e.g. an impossible allocation) cannot be caught: keep the input
        let current = std::env::temp_dir().join(format!("la-fuzz-{name}-current.bin"));
        let _ = std::fs::write(&current, &input);
        if catch_unwind(AssertUnwindSafe(|| f(&input))).is_err() {
            let out = std::env::temp_dir().join(format!("la-fuzz-{name}-{k}.bin"));
            let _ = std::fs::write(&out, &input);
            failures.push(out.display().to_string());
        }
    }
    assert!(
        failures.is_empty(),
        "{name}: {} panicking inputs, written to:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// Keeps a mutated problem's run time bounded (budgets and sizes are not under test).
fn bound(v: &mut Value) {
    if let Some(o) = v.as_object_mut() {
        let solver = o.entry("solver").or_insert(json!({}));
        if let Some(s) = solver.as_object_mut() {
            s.insert("time_budget_ms".into(), json!(50));
            s.insert("max_iterations".into(), json!(2000));
            if s.get("strategy").and_then(|x| x.as_str()) == Some("exact") {
                s.insert("strategy".into(), json!("local"));
            }
        }
    }
}

#[test]
fn mutated_problems_never_panic() {
    let texts: Vec<Vec<u8>> = files(&repo().join("conformance/problems"), "json")
        .iter()
        .map(|p| std::fs::read(p).unwrap())
        .collect();
    // half of the seeds are structural mutations (mostly well-formed problems), the
    // others are mutated as bytes by `fuzz`
    let mut rng = Rng(7);
    let mut seeds = texts.clone();
    for k in 0..cases() / 2 {
        let mut v: Value = serde_json::from_slice(&texts[k % texts.len()]).unwrap();
        for _ in 0..1 + rng.below(3) {
            mutate_json(&mut rng, &mut v, 0);
        }
        seeds.push(serde_json::to_vec(&v).unwrap());
    }
    let env = label_anything::NativeEnv::new();
    let counts = std::cell::Cell::new((0usize, 0usize));
    fuzz("problem", &seeds, 1, |bytes| {
        let Ok(text) = std::str::from_utf8(bytes) else {
            return;
        };
        match serde_json::from_str::<Value>(text) {
            Ok(mut v) => {
                bound(&mut v);
                let _ = label_anything::validate(&v);
                let solved = label_anything::place_with(&v, &env).is_ok();
                let (j, s) = counts.get();
                counts.set((j + 1, s + usize::from(solved)));
            }
            Err(_) => {
                let _ = la_core::place_str(text, &env);
            }
        }
    });
    let (json, solved) = counts.get();
    eprintln!(
        "problem fuzzing: {} inputs, {json} valid JSON, {solved} solved",
        seeds.len() + cases()
    );
    assert!(
        json > cases() / 3 && solved > cases() / 20,
        "the mutations hardly reach the solver"
    );
}

#[test]
fn mutated_svgs_never_panic() {
    let mut seeds = Vec::new();
    for p in files(&repo().join("conformance/svg"), "json") {
        let case: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        if let Some(s) = case["svg"].as_str() {
            seeds.push(s.as_bytes().to_vec());
        }
    }
    assert!(seeds.len() >= 5);
    let rules = [
        la_svg::ClassRule::new("text", "text"),
        la_svg::ClassRule::new("circle, rect:small", "points"),
        la_svg::ClassRule::new("*", "ink"),
    ];
    fuzz("svg", &seeds, 2, |bytes| {
        let text = String::from_utf8_lossy(bytes);
        if let Ok(scene) = la_svg::parse(&text, &la_svg::ParseOptions::default()) {
            let _ = la_svg::classify(&scene, &rules, "ink");
        }
    });
}

#[test]
fn mutated_images_never_panic() {
    let dir = repo().join("conformance/raster/images");
    let mut seeds = Vec::new();
    for ext in ["png", "jpg", "webp"] {
        for p in files(&dir, ext) {
            seeds.push(std::fs::read(p).unwrap());
        }
    }
    assert!(seeds.len() >= 10);
    fuzz("image", &seeds, 3, |bytes| {
        let _ = la_raster::decode(bytes);
    });
}
