//! Runs every case of `conformance/raster` (format: `conformance/raster/README.md`).

mod support;

use std::path::{Path, PathBuf};

use label_anything_raster::{
    decode_base64, estimate_background, parse_hex_color, process, srgb_to_oklab,
};
use serde_json::Value;
use support::{fnv1a32, load_image, parse_grid, parse_mode, parse_placement};

fn conformance_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance/raster")
}

fn cases() -> Vec<(String, Value)> {
    let dir = conformance_dir();
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .map(|e| e.expect("dir entry").path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|p| {
            let text = std::fs::read_to_string(&p).expect("read case");
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            (name, serde_json::from_str(&text).expect("parse case"))
        })
        .collect()
}

fn as_u64(v: &Value) -> u64 {
    v.as_u64().expect("integer")
}

/// Checks one case and returns its failures (empty = pass) and the number of runs.
fn check(file: &str, case: &Value, dir: &Path) -> (Vec<String>, usize) {
    let mut fails = Vec::new();
    let mut runs = 0;
    let mut fail = |msg: String| fails.push(format!("{file}: {msg}"));
    assert_eq!(case["kind"], "raster", "{file}: kind");
    if let Some(image) = case.get("image") {
        let expect = &case["decode"];
        match (load_image(image, dir), expect.get("error")) {
            (Err(e), Some(code)) => {
                if code != e.code() {
                    fail(format!(
                        "expected error {code}, got {} ({})",
                        e.code(),
                        e.message
                    ));
                }
            }
            (Err(e), None) => fail(format!("unexpected error {e}")),
            (Ok(_), Some(code)) => fail(format!("expected error {code}, decoded fine")),
            (Ok(img), None) => {
                let got = (
                    u64::from(img.width),
                    u64::from(img.height),
                    fnv1a32(&img.data),
                );
                let want = (
                    as_u64(&expect["width"]),
                    as_u64(&expect["height"]),
                    expect["rgba_fnv1a32"].as_str().unwrap().to_owned(),
                );
                if got != want {
                    fail(format!("decode: got {got:?}, want {want:?}"));
                }
                if let Some(bg) = case.get("background") {
                    let want: Vec<u64> = bg.as_array().unwrap().iter().map(as_u64).collect();
                    let got: Vec<u64> = estimate_background(&img)
                        .iter()
                        .map(|&c| u64::from(c))
                        .collect();
                    if got != want {
                        fail(format!("background: got {got:?}, want {want:?}"));
                    }
                }
                for run in case["runs"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
                    runs += 1;
                    let name = run["name"].as_str().unwrap_or("?");
                    let grid = parse_grid(&run["grid"]);
                    let got = process(
                        &img,
                        &parse_mode(&run["mode"]),
                        run["class"].as_str().unwrap_or("ink"),
                        &parse_placement(&run["placement"]),
                        &grid,
                    );
                    let want = run["expect"].as_array().unwrap();
                    let got_classes: Vec<&str> = got.iter().map(|c| c.class.as_str()).collect();
                    let want_classes: Vec<&str> =
                        want.iter().map(|e| e["class"].as_str().unwrap()).collect();
                    if got_classes != want_classes {
                        fail(format!(
                            "run '{name}': classes {got_classes:?}, want {want_classes:?}"
                        ));
                        continue;
                    }
                    for (c, e) in got.iter().zip(want) {
                        let cov = &c.coverage;
                        if let Some(b64) = e.get("coverage").and_then(Value::as_str) {
                            let bytes = decode_base64(b64).expect("expected coverage base64");
                            if *cov != bytes {
                                let first = cov.iter().zip(&bytes).position(|(a, b)| a != b);
                                fail(format!(
                                    "run '{name}' class {}: coverage differs (len {} vs {}, first diff at {first:?})",
                                    c.class,
                                    cov.len(),
                                    bytes.len()
                                ));
                            }
                        }
                        let sum: u64 = cov.iter().map(|&v| u64::from(v)).sum();
                        let nonzero = cov.iter().filter(|&&v| v > 0).count() as u64;
                        if fnv1a32(cov) != e["fnv1a32"].as_str().unwrap()
                            || sum != as_u64(&e["sum"])
                            || nonzero != as_u64(&e["nonzero"])
                        {
                            fail(format!(
                                "run '{name}' class {}: checksum/sum/nonzero differ",
                                c.class
                            ));
                        }
                        for s in e
                            .get("samples")
                            .and_then(Value::as_array)
                            .map(Vec::as_slice)
                            .unwrap_or(&[])
                        {
                            let (x, y, v) = (
                                as_u64(&s[0]) as usize,
                                as_u64(&s[1]) as usize,
                                as_u64(&s[2]),
                            );
                            if u64::from(cov[y * grid.cols + x]) != v {
                                fail(format!(
                                    "run '{name}' class {}: cell ({x}, {y}) differs",
                                    c.class
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
    for e in case
        .get("oklab")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let rgb: Vec<u8> = e["rgb"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| as_u64(c) as u8)
            .collect();
        let lab = srgb_to_oklab([rgb[0], rgb[1], rgb[2]]);
        let got: Vec<String> = lab
            .iter()
            .map(|v| format!("{:016x}", v.to_bits()))
            .collect();
        let want: Vec<&str> = e["lab_bits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b.as_str().unwrap())
            .collect();
        if got != want {
            fail(format!("oklab {rgb:?}: got {lab:?}"));
        }
    }
    for e in case
        .get("hex")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let input = e["input"].as_str().unwrap();
        let want = match &e["rgb"] {
            Value::Null => None,
            v => {
                let c: Vec<u8> = v
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|c| as_u64(c) as u8)
                    .collect();
                Some([c[0], c[1], c[2]])
            }
        };
        if parse_hex_color(input) != want {
            fail(format!("hex {input:?}"));
        }
    }
    for e in case
        .get("base64")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let input = e["input"].as_str().unwrap();
        let got = decode_base64(input);
        match (got, e.get("hex"), e.get("error")) {
            (Ok(bytes), Some(hex), _) => {
                let text: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
                if text != hex.as_str().unwrap() {
                    fail(format!("base64 {input:?}: got {text}"));
                }
            }
            (Err(err), _, Some(code)) if code == err.code() => {}
            (got, _, _) => fail(format!("base64 {input:?}: got {got:?}")),
        }
    }
    (fails, runs)
}

#[test]
fn raster_conformance() {
    let dir = conformance_dir();
    let all = cases();
    assert!(
        all.len() >= 50,
        "expected the conformance/raster cases, found {}",
        all.len()
    );
    let mut failures = Vec::new();
    let mut runs = 0;
    for (file, case) in &all {
        let (f, r) = check(file, case, &dir);
        failures.extend(f);
        runs += r;
    }
    assert!(
        failures.is_empty(),
        "{} failure(s):\n{}",
        failures.len(),
        failures.join("\n")
    );
    eprintln!(
        "raster conformance: {} cases, {runs} runs passed",
        all.len()
    );
}
