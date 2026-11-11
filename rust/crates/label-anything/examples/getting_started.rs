//! The Rust getting-started program of the documentation (docs/getting-started/rust.md
//! includes its sections).
//!
//!   cargo run --manifest-path rust/Cargo.toml -p label-anything --example getting_started

use label_anything::serde_json::json;
use label_anything::{
    place, place_with, render_svg, validate, Env, FontSpec, NativeEnv, TextMetrics,
};

fn main() {
    // --8<-- [start:place]
    let problem = json!({
        "canvas": {"width": 400, "height": 300},
        "items": [
            {"id": "a", "anchor": {"type": "point", "x": 100, "y": 100},
             "label": {"type": "text", "text": "Alpha"}},
            {"id": "b", "anchor": {"type": "point", "x": 104, "y": 102},
             "label": {"type": "text", "text": "Beta"}},
        ],
    });
    let result = place(&problem).expect("a valid problem");

    for p in result["placements"].as_array().unwrap() {
        let id = p["id"].as_str().unwrap();
        if p["placed"] == true {
            // box: {x, y, w, h} in canvas pixels, origin top-left, y down
            println!("{id} at {}", p["box"]);
        } else {
            println!("{id} omitted: {}", p["reason"]);
        }
    }
    assert_eq!(result["stats"]["placed"], 2);
    assert_eq!(result["stats"]["hard_violations"], 0);
    // --8<-- [end:place]

    // --8<-- [start:invalid]
    let invalid = json!({"items": [{"id": "a", "anchor": {"type": "point", "x": 100}}]});
    let error = place(&invalid).unwrap_err();
    for e in &error.errors {
        println!("{} [{}] {}", e.pointer, e.code, e.message);
    }
    assert_eq!(error.errors[0].pointer, "/items/0/anchor/y");
    assert_eq!(error.errors[0].code, "required");

    // the same list without solving, with the warnings
    let report = validate(&invalid);
    assert!(!report.valid);
    assert_eq!(report.errors.len(), error.errors.len());
    // --8<-- [end:invalid]

    // --8<-- [start:render]
    // relative paths in the problem (backgrounds, fonts) resolve against a directory
    let env = NativeEnv::with_base_dir(std::env::temp_dir());
    let result = place_with(&problem, &env).unwrap();
    let svg = render_svg(&problem, &result, &env);
    assert!(svg.starts_with("<svg"));
    // --8<-- [end:render]

    // --8<-- [start:env]
    /// Measures text as the host draws it: here, a monospaced font.
    struct Monospace(NativeEnv);

    impl Env for Monospace {
        fn measure(&self, text: &str, font: &FontSpec) -> Option<TextMetrics> {
            Some(TextMetrics {
                width: 0.6 * font.size * text.chars().count() as f64,
                ascent: 0.8 * font.size,
                descent: 0.2 * font.size,
            })
        }
        fn now_ms(&self) -> f64 {
            self.0.now_ms()
        }
    }

    let result = place_with(&problem, &Monospace(NativeEnv::new())).unwrap();
    let width = result["placements"][0]["box"]["w"].as_f64().unwrap();
    // "Alpha" at the default 12 px, plus the padding
    assert!(width >= 0.6 * 12.0 * 5.0);
    // --8<-- [end:env]
}
