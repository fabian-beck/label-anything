//! Windows (spec §2.3, ADR motion/windows): with `canvas.overscan` the canvas shows part of
//! a larger drawing. Labels are placed as if the drawing went on beyond its edges, so a
//! label near an edge keeps its place when the view moves it across.
use label_anything_core::env::BasicEnv;
use label_anything_core::place;
use serde_json::{json, Value};

fn solve(p: &Value) -> Value {
    place(p, &BasicEnv).expect("a valid problem")
}

/// Deterministic pseudo-random numbers in [0, 1).
fn lcg(seed: u32) -> impl FnMut() -> f64 {
    let mut s = seed;
    move || {
        s = s.wrapping_mul(1664525).wrapping_add(1013904223);
        f64::from(s) / 4294967296.0
    }
}

/// Points of a map of 900 × 700 px, with labels of a fixed size (no font needed).
fn map_points(n: usize) -> Vec<(String, f64, f64)> {
    let mut r = lcg(11);
    (0..n)
        .map(|i| {
            (
                format!("p{i}"),
                (r() * 900.0).round(),
                (r() * 700.0).round(),
            )
        })
        .collect()
}

fn item(id: &str, x: f64, y: f64) -> Value {
    json!({"id": id, "anchor": {"type": "point", "x": x, "y": y, "mark": {"shape": "circle", "r": 3}},
           "label": {"type": "text", "text": id, "width": 46, "height": 14, "padding": 0}})
}

fn boxes(r: &Value) -> Vec<(String, Option<[f64; 4]>)> {
    r["placements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let b = p.get("box").map(|b| {
                let f = |k: &str| b[k].as_f64().unwrap();
                [f("x"), f("y"), f("w"), f("h")]
            });
            (p["id"].as_str().unwrap().to_string(), b)
        })
        .collect()
}

/// A window places its labels as the middle of a canvas larger by the overscan does,
/// where labels may leave that canvas: the same grids, the same candidates, no edge.
#[test]
fn a_window_is_the_middle_of_a_larger_canvas() {
    let (w, h, m) = (400.0, 300.0, 48.0);
    let pts: Vec<_> = map_points(160)
        .into_iter()
        .map(|(id, x, y)| (id, x - 250.0, y - 200.0))
        .filter(|(_, x, y)| *x >= -m && *y >= -m && *x <= w + m && *y <= h + m)
        .collect();
    assert!(pts.len() > 40, "{} points", pts.len());
    let road = |dx: f64| {
        json!({"vector": [{"class": "lines", "width": 2,
        "polylines": [[[-80.0 + dx, 40.0 + dx], [200.0 + dx, 180.0 + dx], [520.0 + dx, 90.0 + dx]]]}]})
    };
    let window = json!({"version": "1", "canvas": {"width": w, "height": h, "overscan": m},
        "preset": "map", "obstacles": road(0.0),
        "items": pts.iter().map(|(id, x, y)| item(id, *x, *y)).collect::<Vec<_>>()});
    let larger = json!({"version": "1",
        "canvas": {"width": w + 2.0 * m, "height": h + 2.0 * m, "allow_outside": true},
        "preset": "map", "obstacles": road(m),
        "items": pts.iter().map(|(id, x, y)| item(id, x + m, y + m)).collect::<Vec<_>>()});
    let (a, b) = (boxes(&solve(&window)), boxes(&solve(&larger)));
    assert_eq!(a.len(), b.len());
    let mut crossing = 0;
    for ((ia, ba), (ib, bb)) in a.iter().zip(&b) {
        assert_eq!(ia, ib);
        match (ba, bb) {
            (Some(p), Some(q)) => {
                assert!(
                    (p[0] + m - q[0]).abs() < 1e-6 && (p[1] + m - q[1]).abs() < 1e-6,
                    "{ia}: {p:?} in the window, {q:?} on the larger canvas"
                );
                let inside = p[0] >= 0.0 && p[1] >= 0.0 && p[0] + p[2] <= w && p[1] + p[3] <= h;
                let outside = p[0] >= w || p[1] >= h || p[0] + p[2] <= 0.0 || p[1] + p[3] <= 0.0;
                crossing += usize::from(!inside && !outside);
            }
            (None, None) => {}
            _ => panic!("{ia}: placed in one of the two only"),
        }
    }
    assert!(crossing >= 3, "{crossing} labels cross the window's edges");
}

/// One frame of a view that pans to the right by `pan` px: the point `r` comes to the
/// right edge and leaves the canvas.
fn frame(pan: f64, canvas: Value, warm: Option<&Value>) -> Value {
    let mut p = json!({"version": "1", "canvas": canvas,
        "items": [item("r", 130.0 + pan, 50.0), item("a", 60.0 + pan, 30.0), item("b", 40.0 + pan, 75.0)]});
    if let Some(w) = warm {
        p["warm_start"] = w.clone();
    }
    solve(&p)
}

fn box_of<'a>(r: &'a Value, id: &str) -> Option<&'a Value> {
    r["placements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id)
        .and_then(|p| p.get("box"))
}

#[test]
fn a_label_keeps_its_place_while_the_view_moves_it_across_the_edge() {
    let window = json!({"width": 160, "height": 100, "overscan": 60});
    let first = frame(0.0, window.clone(), None);
    let b0 = box_of(&first, "r").expect("placed").clone();
    let offset = b0["x"].as_f64().unwrap() - 130.0;
    let mut prev = first;
    // 5 px inside the edge, on it, 20 and 50 px beyond it
    for pan in [25.0, 30.0, 50.0, 80.0] {
        let r = frame(pan, window.clone(), Some(&prev));
        let b = box_of(&r, "r").unwrap_or_else(|| panic!("pan {pan}: r lost its label"));
        assert!(
            (b["x"].as_f64().unwrap() - (130.0 + pan + offset)).abs() < 1e-9 && b["y"] == b0["y"],
            "pan {pan}: {b} after {b0}"
        );
        prev = r;
    }
    // the same view without the overscan: the canvas edge pushes the label aside
    let contained = json!({"width": 160, "height": 100});
    let c0 = frame(0.0, contained.clone(), None);
    assert_eq!(box_of(&c0, "r"), Some(&b0), "the first frame is the same");
    let c1 = frame(25.0, contained, Some(&c0));
    let b = box_of(&c1, "r").expect("placed");
    assert!(
        (b["x"].as_f64().unwrap() - (155.0 + offset)).abs() > 1.0,
        "{b}"
    );
}

/// The label of an area passed whole has its place in the area, wherever the window is.
#[test]
fn an_area_label_stays_with_its_area() {
    let outline = [
        [40.0, 30.0],
        [330.0, 20.0],
        [360.0, 120.0],
        [250.0, 190.0],
        [70.0, 160.0],
    ];
    let at = |dx: f64, dy: f64| {
        let poly: Vec<[f64; 2]> = outline.iter().map(|p| [p[0] + dx, p[1] + dy]).collect();
        let r = solve(
            &json!({"version": "1", "canvas": {"width": 200, "height": 150, "overscan": 40},
            "items": [{"id": "a", "anchor": {"type": "area", "polygon": poly},
                       "label": {"type": "text", "text": "Area", "width": 60, "height": 14, "padding": 0}}]}),
        );
        let b = box_of(&r, "a").expect("placed").clone();
        (b["x"].as_f64().unwrap() - dx, b["y"].as_f64().unwrap() - dy)
    };
    let home = at(0.0, 0.0);
    // into view, half out of it, out of it and beyond the overscan
    for (dx, dy) in [
        (-60.0, 0.0),
        (-150.0, -40.0),
        (-320.0, 10.0),
        (500.0, 300.0),
    ] {
        let p = at(dx, dy);
        assert!(
            (p.0 - home.0).abs() < 1e-6 && (p.1 - home.1).abs() < 1e-6,
            "moved by ({dx}, {dy}): {p:?}, at home {home:?}"
        );
    }
}

/// `priority.budget.max_ink_fraction` is a fraction of the working extent in a window: the
/// labels in the overscan count, and so does its area. (The greedy pass alone: it is the
/// pass that keeps to this budget.)
#[test]
fn the_ink_budget_counts_the_working_extent() {
    // labels of 40 × 20 px: 2 % of the extent of 200 × 200 px, 8 % of the canvas
    let items: Vec<Value> = [[30.0, 30.0], [70.0, 70.0], [130.0, 130.0]]
        .iter()
        .enumerate()
        .map(|(i, p)| {
            json!({"id": format!("l{i}"), "anchor": {"type": "point", "x": p[0], "y": p[1]},
                   "label": {"type": "text", "text": "L", "width": 40, "height": 20, "padding": 0}})
        })
        .collect();
    let problem = |canvas: Value| {
        json!({"version": "1", "canvas": canvas, "items": items, "solver": {"strategy": "greedy"},
               "priority": {"budget": {"max_ink_fraction": 0.05}}})
    };
    let r = solve(&problem(
        json!({"width": 100, "height": 100, "overscan": 50}),
    ));
    assert_eq!(r["stats"]["placed"], 2, "{}", r["stats"]);
    let r = solve(&problem(json!({"width": 100, "height": 100})));
    assert_eq!(r["stats"]["placed"], 0, "{}", r["stats"]);
}
