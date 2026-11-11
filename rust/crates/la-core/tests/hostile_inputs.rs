//! Small problems that ask for unbounded work: each once hung a solve or took the host's
//! memory. They must end, quickly, with a result or an error.
//! (TypeScript: ts/packages/core/test/hostile-inputs.test.ts.)

use label_anything_core::{env::BasicEnv, place};
use serde_json::{json, Value};
use std::time::Instant;

fn point(id: &str, x: f64, y: f64) -> Value {
    json!({"id": id, "anchor": {"type": "point", "x": x, "y": y}, "label": {"type": "text", "text": id}})
}

/// Solves within `secs` seconds (a normal solve of these takes milliseconds).
fn solve(problem: &Value, secs: u64) -> Result<Value, Vec<String>> {
    let t = Instant::now();
    let r =
        place(problem, &BasicEnv).map_err(|e| e.errors.iter().map(|i| i.code.clone()).collect());
    assert!(t.elapsed().as_secs() < secs, "took {:?}", t.elapsed());
    r
}

/// A country that reaches far beyond the view of a zoomed-in map.
#[test]
fn an_area_far_larger_than_the_canvas() {
    for side in [1e5, 1e7, 1e17] {
        let problem = json!({
            "canvas": {"width": 400, "height": 300},
            "items": [{"id": "country",
                       "anchor": {"type": "area", "polygon": [[0, 0], [side, 0], [side, side], [0, side]]},
                       "label": {"type": "text", "text": "Country"}}],
        });
        let r = solve(&problem, 20).expect("a valid problem");
        assert_eq!(r["placements"].as_array().unwrap().len(), 1);
    }
}

/// `k` nearest neighbours of two points.
#[test]
fn more_neighbours_than_points() {
    for k in [1_000_000_000_000_000_000u64, 2_000_000_000_000_000_000] {
        let problem = json!({
            "canvas": {"width": 400, "height": 300},
            "items": [point("a", 100.0, 100.0), point("b", 104.0, 102.0)],
            "priority": {"terms": [{"builtin": "outlierness", "k": k}]},
        });
        assert_eq!(
            solve(&problem, 20).expect("a valid problem")["stats"]["placed"],
            2
        );
    }
}

/// Sizes beyond what a double holds: the costs of the fan pass are infinite.
#[test]
fn labels_too_large_for_numbers() {
    let problem = json!({
        "canvas": {"width": 400, "height": 300},
        "defaults": {"font": {"size": 1e160}},
        "items": [point("a", 100.0, 100.0), point("b", 104.0, 102.0)],
    });
    let _ = solve(&problem, 20);
}

/// Counts the format limits: an error, not a billion candidates.
#[test]
fn counts_beyond_their_limits() {
    for (section, key, value) in [
        ("placement", "slider_per_quadrant", 1e9),
        ("placement", "distant_directions", 1e9),
        ("placement", "distant_rings", 1e9),
        ("degrade_options", "wrap_max_lines", 1e15),
    ] {
        let mut problem = json!({
            "canvas": {"width": 400, "height": 300},
            "items": [point("a", 100.0, 100.0)],
        });
        problem[section] = json!({ key: value });
        assert_eq!(solve(&problem, 5).unwrap_err(), ["range"], "{key}");
    }
}
