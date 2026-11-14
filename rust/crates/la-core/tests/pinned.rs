//! Pinned labels (spec §10.1, ADR motion/pinned-labels): with `warm_start.pin`, a view that
//! only moved keeps every label where it is. The solve adds labels around them.
use label_anything_core::env::BasicEnv;
use label_anything_core::place;
use serde_json::{json, Value};

/// Deterministic pseudo-random numbers in [0, 1).
fn lcg(seed: u32) -> impl FnMut() -> f64 {
    let mut s = seed;
    move || {
        s = s.wrapping_mul(1664525).wrapping_add(1013904223);
        f64::from(s) / 4294967296.0
    }
}

const W: f64 = 400.0;
const H: f64 = 300.0;
/// The map is labeled this far beyond the view, and its points are known that far beyond
/// that again: farther than a label reaches from its point.
const OVERSCAN: f64 = 60.0;
const MARKS: f64 = 130.0;

/// Places of a map of 2000 × 1400 px with a priority each.
fn places(n: usize) -> Vec<(String, f64, f64, f64)> {
    let mut r = lcg(5);
    (0..n)
        .map(|i| {
            let (x, y) = ((r() * 2000.0).round(), (r() * 1400.0).round());
            (format!("p{i}"), x, y, (r() * 1000.0).round())
        })
        .collect()
}

/// The problem of a view whose top-left corner is at (`cx`, `cy`) of the map.
fn view(all: &[(String, f64, f64, f64)], cx: f64, cy: f64, warm: Option<Value>) -> Value {
    let reach = OVERSCAN + MARKS;
    let items: Vec<Value> = all
        .iter()
        .map(|(id, x, y, pop)| (id, x - cx, y - cy, pop))
        .filter(|(_, x, y, _)| *x >= -reach && *y >= -reach && *x <= W + reach && *y <= H + reach)
        .map(|(id, x, y, pop)| {
            json!({"id": id, "priority": pop,
                   "anchor": {"type": "point", "x": x, "y": y, "mark": {"shape": "circle", "r": 3}},
                   "label": {"type": "text", "text": id, "width": 46, "height": 14, "padding": 0}})
        })
        .collect();
    let mut p = json!({"version": "1", "preset": "map", "items": items,
        "canvas": {"width": W, "height": H, "overscan": OVERSCAN}});
    if let Some(w) = warm {
        p["warm_start"] = w;
    }
    p
}

/// An item of a result: its id, its label's offset from its anchor, whether it is a mark only.
type Labeled = (String, Option<(f64, f64)>, bool);

/// Offsets of the placed labels from their anchors, and the points that are marks only.
fn offsets(r: &Value) -> Vec<Labeled> {
    r["placements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let off = p.get("box").map(|b| {
                (
                    b["x"].as_f64().unwrap() - p["anchor"][0].as_f64().unwrap(),
                    b["y"].as_f64().unwrap() - p["anchor"][1].as_f64().unwrap(),
                )
            });
            (
                p["id"].as_str().unwrap().to_string(),
                off,
                p["reason"] == "outside",
            )
        })
        .collect()
}

/// Pans the view in 40 steps; the labels that are kept, moved and lost on the way, and
/// the labels that came.
fn pan(all: &[(String, f64, f64, f64)], pin: bool) -> (usize, usize, usize, usize) {
    let (mut kept, mut moved, mut lost, mut came) = (0, 0, 0, 0);
    let mut prev = place(&view(all, 700.0, 500.0, None), &BasicEnv).unwrap();
    for step in 1..=40 {
        let (cx, cy) = (700.0 + 7.0 * f64::from(step), 500.0 + 3.0 * f64::from(step));
        let warm = json!({"pin": pin, "placements": prev["placements"]});
        let r = place(&view(all, cx, cy, Some(warm)), &BasicEnv).unwrap();
        assert_eq!(r["stats"]["hard_violations"], 0);
        if pin {
            assert_eq!(r["stats"]["strategy_used"], "greedy");
            assert!(
                r["stats"]["pinned"].as_u64().unwrap() > 20,
                "{}",
                r["stats"]
            );
        } else {
            assert!(r["stats"].get("pinned").is_none());
        }
        let before = offsets(&prev);
        for (id, off, outside) in offsets(&r) {
            let old = before.iter().find(|b| b.0 == id).and_then(|b| b.1);
            match (old, off) {
                // a point that left the working extent is a mark only: its label is gone
                (Some(_), None) if outside => {}
                (Some(_), None) => lost += 1,
                (Some(a), Some(b)) if (a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9 => {
                    kept += 1
                }
                (Some(_), Some(_)) => moved += 1,
                (None, Some(_)) => came += 1,
                (None, None) => {}
            }
        }
        prev = r;
    }
    (kept, moved, lost, came)
}

#[test]
fn a_pan_moves_no_label_and_loses_none() {
    let all = places(1400);
    let (kept, moved, lost, came) = pan(&all, true);
    assert_eq!((moved, lost), (0, 0), "{kept} labels kept, {came} came");
    assert!(kept > 1500 && came > 40, "{kept} labels kept, {came} came");
    // the same pan with warm starts alone: labels move, and some lose their place
    let (_, moved, lost, _) = pan(&all, false);
    assert!(
        moved + lost > 40,
        "{moved} moved, {lost} lost without the pin"
    );
}

/// A point beyond the working extent has no label; one in the overscan has.
#[test]
fn the_points_beyond_the_overscan_are_marks_only() {
    let all = places(1400);
    let r = place(&view(&all, 700.0, 500.0, None), &BasicEnv).unwrap();
    let (mut inside, mut beyond) = (0, 0);
    for p in r["placements"].as_array().unwrap() {
        let it = all
            .iter()
            .find(|a| a.0 == p["id"].as_str().unwrap())
            .unwrap();
        let (x, y) = (it.1 - 700.0, it.2 - 500.0);
        // (the mark's bounding box against the working extent)
        let out = x + 3.0 < -OVERSCAN
            || y + 3.0 < -OVERSCAN
            || x - 3.0 > W + OVERSCAN
            || y - 3.0 > H + OVERSCAN;
        assert_eq!(p["reason"] == "outside", out, "{p}");
        if out {
            assert_eq!(p["placed"], false);
            beyond += 1;
        } else {
            inside += 1;
        }
    }
    assert!(
        inside > 60 && beyond > 60,
        "{inside} to label, {beyond} beyond"
    );
}
