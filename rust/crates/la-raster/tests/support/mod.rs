//! Shared helpers of the conformance runner (`tests/conformance.rs`) and the expectation
//! oracle (`examples/raster_oracle.rs`): parsing the JSON case format of
//! `conformance/raster/README.md` into API values.
#![allow(dead_code)]

use std::path::Path;

use label_anything_raster::{
    decode, decode_source, parse_hex_color, rgba_from_base64, GridSpec, Mode, RasterError,
    RasterPlacement, Rgba,
};
use serde_json::Value;

/// FNV-1a (32 bit) of `bytes`, as 8 lowercase hex digits.
pub fn fnv1a32(bytes: &[u8]) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for &b in bytes {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

/// Standard base64 with padding.
pub fn base64_encode(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for k in 0..4 {
            if k <= chunk.len() {
                out.push(A[((n >> (18 - 6 * k)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn num(v: &Value, what: &str) -> f64 {
    v.as_f64()
        .unwrap_or_else(|| panic!("{what}: expected a number, got {v}"))
}

fn pair(v: &Value, what: &str) -> [f64; 2] {
    let a = v
        .as_array()
        .unwrap_or_else(|| panic!("{what}: expected [x, y]"));
    [num(&a[0], what), num(&a[1], what)]
}

fn color(v: &Value, what: &str) -> Option<[u8; 3]> {
    match v {
        Value::Null => None,
        Value::String(s) => {
            Some(parse_hex_color(s).unwrap_or_else(|| panic!("{what}: bad colour {s}")))
        }
        _ => panic!("{what}: expected null or #rrggbb"),
    }
}

/// `{"kind": "ink" | "alpha" | "cost" | "classmap" | "saliency", ...}` → [`Mode`].
pub fn parse_mode(v: &Value) -> Mode {
    let kind = v["kind"].as_str().expect("mode.kind");
    match kind {
        "ink" => Mode::Ink {
            background: color(&v["background"], "ink.background"),
            threshold: num(&v["threshold"], "ink.threshold"),
            dilate: v["dilate"].as_u64().expect("ink.dilate") as u32,
        },
        "alpha" => Mode::Alpha {
            threshold: num(&v["threshold"], "alpha.threshold"),
        },
        "cost" => Mode::Cost {
            invert: v["invert"].as_bool().expect("cost.invert"),
        },
        "classmap" => Mode::ClassMap {
            palette: v["palette"]
                .as_array()
                .expect("classmap.palette")
                .iter()
                .map(|e| {
                    let hex = e[0].as_str().expect("palette colour");
                    (
                        parse_hex_color(hex).unwrap_or_else(|| panic!("bad palette colour {hex}")),
                        e[1].as_str().expect("palette class").to_owned(),
                    )
                })
                .collect(),
            tolerance: num(&v["tolerance"], "classmap.tolerance"),
            unmatched_ink: v["unmatched_ink"]
                .as_bool()
                .expect("classmap.unmatched_ink"),
            background: color(&v["background"], "classmap.background"),
            ink_threshold: num(&v["ink_threshold"], "classmap.ink_threshold"),
        },
        "saliency" => Mode::Saliency,
        other => panic!("unknown mode kind {other}"),
    }
}

/// `{"scale": s, "offset": [x, y]}` → [`RasterPlacement`].
pub fn parse_placement(v: &Value) -> RasterPlacement {
    RasterPlacement {
        scale: num(&v["scale"], "placement.scale"),
        offset: pair(&v["offset"], "placement.offset"),
    }
}

/// `{"origin": [x, y], "cell": c, "cols": n, "rows": m}` → [`GridSpec`].
pub fn parse_grid(v: &Value) -> GridSpec {
    let [origin_x, origin_y] = pair(&v["origin"], "grid.origin");
    GridSpec {
        origin_x,
        origin_y,
        cell: num(&v["cell"], "grid.cell"),
        cols: v["cols"].as_u64().expect("grid.cols") as usize,
        rows: v["rows"].as_u64().expect("grid.rows") as usize,
    }
}

/// Loads the case's `image`: `{"file": path}` (relative to `dir`), `{"base64": text}`,
/// `{"source": data-url-or-base64}` or `{"rgba": {"width", "height", "data"}}`.
pub fn load_image(v: &Value, dir: &Path) -> Result<Rgba, RasterError> {
    if let Some(file) = v.get("file").and_then(Value::as_str) {
        let bytes = std::fs::read(dir.join(file)).unwrap_or_else(|e| panic!("read {file}: {e}"));
        decode(&bytes)
    } else if let Some(text) = v.get("base64").and_then(Value::as_str) {
        decode_source(text)
    } else if let Some(text) = v.get("source").and_then(Value::as_str) {
        decode_source(text)
    } else if let Some(rgba) = v.get("rgba") {
        rgba_from_base64(
            rgba["width"].as_u64().expect("rgba.width") as u32,
            rgba["height"].as_u64().expect("rgba.height") as u32,
            rgba["data"].as_str().expect("rgba.data"),
        )
    } else {
        panic!("image: expected file, base64, source or rgba")
    }
}
