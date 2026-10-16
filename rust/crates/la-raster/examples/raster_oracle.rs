//! Expectation oracle for `conformance/raster` (used by `tools/raster/make_conformance.py`).
//!
//! Reads `{"dir": <conformance/raster>, "cases": [<case inputs>]}` from stdin and writes,
//! per case, what this (reference) implementation computes:
//!
//! ```json
//! {"cases": [{"decode": {"width", "height", "rgba_fnv1a32"} | {"error": code},
//!             "background": [r, g, b] | null,
//!             "runs": [[{"class", "coverage": base64}]],
//!             "oklab": [[L, a, b]], "hex": [[r, g, b] | null],
//!             "base64": [{"hex": "..."} | {"error": code}]}]}
//! ```
//!
//! Run: `cargo run --release -p label-anything-raster --example raster_oracle < in.json`.

#[path = "../tests/support/mod.rs"]
mod support;

use std::io::Read;
use std::path::PathBuf;

use label_anything_raster::{
    decode_base64, estimate_background, parse_hex_color, process, srgb_to_oklab,
};
use serde_json::{json, Value};
use support::{base64_encode, fnv1a32, load_image, parse_grid, parse_mode, parse_placement};

fn main() {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .expect("read stdin");
    let request: Value = serde_json::from_str(&input).expect("parse request");
    let dir = PathBuf::from(request["dir"].as_str().expect("dir"));
    let mut out = Vec::new();
    for case in request["cases"].as_array().expect("cases") {
        let mut result = serde_json::Map::new();
        if let Some(image) = case.get("image") {
            match load_image(image, &dir) {
                Ok(img) => {
                    result.insert(
                        "decode".into(),
                        json!({"width": img.width, "height": img.height, "rgba_fnv1a32": fnv1a32(&img.data)}),
                    );
                    result.insert("background".into(), json!(estimate_background(&img)));
                    let mut runs = Vec::new();
                    for run in case["runs"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
                        let coverages = process(
                            &img,
                            &parse_mode(&run["mode"]),
                            run["class"].as_str().unwrap_or("ink"),
                            &parse_placement(&run["placement"]),
                            &parse_grid(&run["grid"]),
                        );
                        runs.push(Value::Array(
                            coverages
                                .iter()
                                .map(|c| json!({"class": c.class, "coverage": base64_encode(&c.coverage)}))
                                .collect(),
                        ));
                    }
                    result.insert("runs".into(), Value::Array(runs));
                }
                Err(e) => {
                    result.insert("decode".into(), json!({"error": e.code()}));
                    result.insert("background".into(), Value::Null);
                }
            }
        }
        if let Some(list) = case.get("oklab").and_then(Value::as_array) {
            let labs: Vec<Value> = list
                .iter()
                .map(|e| {
                    let rgb: Vec<u8> = e["rgb"]
                        .as_array()
                        .expect("rgb")
                        .iter()
                        .map(|c| c.as_u64().expect("u8") as u8)
                        .collect();
                    json!(srgb_to_oklab([rgb[0], rgb[1], rgb[2]]))
                })
                .collect();
            result.insert("oklab".into(), Value::Array(labs));
        }
        if let Some(list) = case.get("hex").and_then(Value::as_array) {
            let parsed: Vec<Value> = list
                .iter()
                .map(|e| json!(parse_hex_color(e["input"].as_str().expect("input"))))
                .collect();
            result.insert("hex".into(), Value::Array(parsed));
        }
        if let Some(list) = case.get("base64").and_then(Value::as_array) {
            let decoded: Vec<Value> = list
                .iter()
                .map(|e| match decode_base64(e["input"].as_str().expect("input")) {
                    Ok(bytes) => json!({"hex": bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()}),
                    Err(err) => json!({"error": err.code()}),
                })
                .collect();
            result.insert("base64".into(), Value::Array(decoded));
        }
        out.push(Value::Object(result));
    }
    println!(
        "{}",
        serde_json::to_string(&json!({"cases": out})).expect("serialize")
    );
}
