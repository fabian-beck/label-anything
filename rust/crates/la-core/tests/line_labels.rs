//! Labels of line anchors (spec §6.5a, ADR placement/lines): along the line, on it or
//! beside it, turned along it.
use label_anything_core::env::BasicEnv;
use label_anything_core::place;
use serde_json::{json, Value};

fn problem(points: &[[f64; 2]], anchor: Value, extra: Value) -> Value {
    let mut a = json!({"type": "line", "points": points});
    for (k, v) in anchor.as_object().into_iter().flatten() {
        a[k] = v.clone();
    }
    let mut p = json!({"version": "1", "canvas": {"width": 400, "height": 300},
        "items": [{"id": "a", "anchor": a,
                   "label": {"type": "text", "text": "Line", "width": 60, "height": 14, "padding": 0}}],
        "output": {"candidates": true}});
    for (k, v) in extra.as_object().into_iter().flatten() {
        p[k] = v.clone();
    }
    p
}

fn solve(p: &Value) -> Value {
    place(p, &BasicEnv).expect("a valid problem")
}

/// The corners of a placement's or candidate's box, turned by its rotation.
fn corners(p: &Value) -> Vec<(f64, f64)> {
    let b = &p["box"];
    let f = |k: &str| b[k].as_f64().unwrap();
    let (x, y, w, h) = (f("x"), f("y"), f("w"), f("h"));
    let (cx, cy) = (x + w / 2.0, y + h / 2.0);
    let (s, c) = p["rotation"].as_f64().unwrap_or(0.0).to_radians().sin_cos();
    [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
        .iter()
        .map(|&(px, py)| {
            (
                cx + (px - cx) * c - (py - cy) * s,
                cy + (px - cx) * s + (py - cy) * c,
            )
        })
        .collect()
}

fn center(p: &Value) -> (f64, f64) {
    let b = &p["box"];
    let f = |k: &str| b[k].as_f64().unwrap();
    (f("x") + f("w") / 2.0, f("y") + f("h") / 2.0)
}

/// The distance of `p` from the segment `a`–`b`.
fn dist_seg(p: (f64, f64), a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 {
        (((p.0 - a[0]) * dx + (p.1 - a[1]) * dy) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    ((p.0 - a[0] - t * dx).powi(2) + (p.1 - a[1] - t * dy).powi(2)).sqrt()
}

#[test]
fn a_label_stands_above_the_middle_of_a_horizontal_line() {
    let r = solve(&problem(
        &[[50.0, 150.0], [350.0, 150.0]],
        json!({}),
        json!({}),
    ));
    let p = &r["placements"][0];
    assert_eq!(p["placed"], true);
    assert_eq!(p["model"], "internal");
    assert_eq!(p["anchor_side"], "top");
    assert!(p.get("rotation").is_none());
    assert_eq!(p["anchor"], json!([200.0, 150.0]));
    // centered on the middle, its lower edge the offset (1 px) above the stroke (1 px)
    let b = &p["box"];
    assert!((b["x"].as_f64().unwrap() - 170.0).abs() < 1e-9);
    assert!((b["y"].as_f64().unwrap() - (150.0 - 0.5 - 1.0 - 14.0)).abs() < 1e-9);
}

#[test]
fn a_label_is_turned_along_a_slanted_line_and_reads_from_the_left() {
    // the same edge given in either direction: 30° down to the right
    let (dx, dy) = (
        30f64.to_radians().cos() * 120.0,
        30f64.to_radians().sin() * 120.0,
    );
    let fwd = [[200.0 - dx, 150.0 - dy], [200.0 + dx, 150.0 + dy]];
    let back = [fwd[1], fwd[0]];
    for line in [fwd, back] {
        let r = solve(&problem(&line, json!({}), json!({})));
        let p = &r["placements"][0];
        assert!((p["rotation"].as_f64().unwrap() - 30.0).abs() < 1e-9, "{p}");
        assert_eq!(p["anchor_side"], "top");
        // every corner keeps clear of the line, the lower ones at the offset
        let ds: Vec<f64> = corners(p)
            .iter()
            .map(|&q| dist_seg(q, line[0], line[1]))
            .collect();
        assert!(
            (ds[3] - 1.5).abs() < 1e-6 && (ds[2] - 1.5).abs() < 1e-6,
            "{ds:?}"
        );
        assert!((ds[0] - 15.5).abs() < 1e-6, "{ds:?}");
        // above: the label's center has the smaller y at its x
        let (cx, cy) = center(p);
        assert!((cx - 200.0).abs() < 10.0 && cy < 150.0 + (cx - 200.0) * 30f64.to_radians().tan());
    }
}

#[test]
fn a_vertical_line_reads_upwards() {
    let r = solve(&problem(
        &[[200.0, 40.0], [200.0, 260.0]],
        json!({}),
        json!({}),
    ));
    let p = &r["placements"][0];
    assert_eq!(p["rotation"], -90.0);
    // above the line as the label reads: to its left
    assert!(center(p).0 < 200.0);
}

#[test]
fn line_rotation_limits_the_lines_whose_labels_are_turned() {
    let steep = [[150.0, 40.0], [250.0, 260.0]];
    let off = solve(&problem(
        &steep,
        json!({}),
        json!({"placement": {"line_rotation": 0}}),
    ));
    let p = &off["placements"][0];
    assert!(p.get("rotation").is_none());
    assert_eq!(p["model"], "internal");
    // the upright box touches the line's clearance with a corner
    let d = corners(p)
        .iter()
        .map(|&q| dist_seg(q, steep[0], steep[1]))
        .fold(f64::INFINITY, f64::min);
    assert!((d - 1.5).abs() < 1e-6, "{d}");
    // a line steeper than the limit gets an upright label, a flatter one a turned label
    let lim = solve(&problem(
        &steep,
        json!({}),
        json!({"placement": {"line_rotation": 45}}),
    ));
    assert!(lim["placements"][0].get("rotation").is_none());
    let flat = [[60.0, 100.0], [340.0, 200.0]];
    let lim = solve(&problem(
        &flat,
        json!({}),
        json!({"placement": {"line_rotation": 45}}),
    ));
    assert!(lim["placements"][0]["rotation"].as_f64().unwrap() > 15.0);
}

#[test]
fn a_label_goes_on_a_line_that_is_wide_enough_or_when_asked() {
    let line = [[50.0, 150.0], [350.0, 150.0]];
    // a street 20 px wide takes its 14 px label
    let wide = solve(&problem(&line, json!({"width": 20}), json!({})));
    let p = &wide["placements"][0];
    assert_eq!(p["anchor_side"], "internal");
    assert_eq!(center(p), (200.0, 150.0));
    // a thin line does when the item prefers it
    let mut pr = problem(&line, json!({}), json!({}));
    pr["items"][0]["placement"] = json!({"internal": "prefer"});
    assert_eq!(solve(&pr)["placements"][0]["anchor_side"], "internal");
    // and never with `never`
    let never = solve(&problem(
        &line,
        json!({"width": 20}),
        json!({"placement": {"internal": "never"}}),
    ));
    assert_eq!(never["placements"][0]["anchor_side"], "top");
    assert!(never["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["anchor_side"] != "internal"));
}

#[test]
fn position_order_chooses_the_side() {
    let line = [[50.0, 150.0], [350.0, 150.0]];
    let below = solve(&problem(
        &line,
        json!({}),
        json!({"placement": {"position_order": ["bottom", "top"]}}),
    ));
    let p = &below["placements"][0];
    assert_eq!(p["anchor_side"], "bottom");
    assert!((p["box"]["y"].as_f64().unwrap() - 151.5).abs() < 1e-9);
    let only = solve(&problem(
        &line,
        json!({}),
        json!({"placement": {"position_order": ["bottom"]}}),
    ));
    assert!(only["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["anchor_side"] == "bottom"));
}

#[test]
fn places_are_spread_along_the_line_and_a_blocked_middle_is_left() {
    let line = [[20.0, 150.0], [380.0, 150.0]];
    let free = solve(&problem(&line, json!({}), json!({})));
    let cands = free["candidates"].as_array().unwrap();
    // nine places, above and below
    assert_eq!(cands.len(), 18);
    let xs: Vec<f64> = cands.iter().map(|c| center(c).0).collect();
    assert_eq!(xs[0], 200.0);
    assert!((xs.iter().cloned().fold(f64::INFINITY, f64::min) - 50.0).abs() < 1e-9);
    assert!((xs.iter().cloned().fold(0.0, f64::max) - 350.0).abs() < 1e-9);
    // a mark in the middle of the line moves the label along it
    let mut p = problem(&line, json!({}), json!({}));
    p["items"].as_array_mut().unwrap().push(json!({"id": "node",
        "anchor": {"type": "point", "x": 200.0, "y": 150.0, "mark": {"shape": "circle", "r": 12}},
        "label": {"type": "text", "text": "N", "width": 8, "height": 8, "padding": 0}}));
    let r = solve(&p);
    assert_eq!(r["stats"]["placed"], 2);
    assert_eq!(r["stats"]["hard_violations"], 0);
    let q = &r["placements"][0];
    assert_eq!(q["model"], "internal");
    assert!((center(q).0 - 200.0).abs() > 30.0, "{q}");
}

#[test]
fn a_label_keeps_off_a_corner_of_its_line() {
    // an orthogonal edge: no label over the corner, none against the leg behind it
    let line = [[40.0, 200.0], [220.0, 200.0], [220.0, 60.0]];
    let r = solve(&problem(&line, json!({}), json!({})));
    for c in r["candidates"].as_array().unwrap() {
        for k in 0..2 {
            let cs = corners(c);
            // the box's nearest point to each leg is 1.5 px away at least: test its corners
            // and its center
            let d = cs
                .iter()
                .chain(std::iter::once(&center(c)))
                .map(|&q| dist_seg(q, line[k], line[k + 1]))
                .fold(f64::INFINITY, f64::min);
            assert!(d >= 1.5 - 1e-6, "{c}");
        }
    }
    assert_eq!(r["placements"][0]["model"], "internal");
}

#[test]
fn a_line_bent_everywhere_has_its_label_beside_the_dot() {
    // a zigzag with teeth higher than the label and shorter than it is wide
    let line: Vec<[f64; 2]> = (0..=150)
        .map(|k| {
            [
                50.0 + 2.0 * k as f64,
                if k % 2 == 0 { 140.0 } else { 160.0 },
            ]
        })
        .collect();
    let r = solve(&problem(&line, json!({}), json!({})));
    let p = &r["placements"][0];
    assert_eq!(p["placed"], true);
    assert_ne!(p["model"], "internal");
    assert!(r["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["model"] != "internal"));
}

#[test]
fn a_line_shorter_than_its_label_is_labeled_at_its_middle() {
    let line = [[190.0, 150.0], [210.0, 150.0]];
    let r = solve(&problem(&line, json!({}), json!({})));
    let cands = r["candidates"].as_array().unwrap();
    assert_eq!(cands.len(), 2);
    let p = &r["placements"][0];
    assert_eq!(p["model"], "internal");
    assert_eq!(center(p).0, 200.0);
}

#[test]
fn a_line_label_keeps_its_place_as_a_warm_start() {
    let line = [[60.0, 60.0], [340.0, 230.0]];
    let mut p = problem(&line, json!({}), json!({}));
    // a mark that moves the label off the middle
    p["items"].as_array_mut().unwrap().push(json!({"id": "node",
        "anchor": {"type": "point", "x": 200.0, "y": 145.0, "mark": {"shape": "circle", "r": 14}},
        "label": {"type": "text", "text": "N", "width": 8, "height": 8, "padding": 0}}));
    let first = solve(&p);
    let mut again = p.clone();
    again["warm_start"] = json!({"placements": first["placements"]});
    let second = solve(&again);
    let (a, b) = (&first["placements"][0], &second["placements"][0]);
    assert_eq!(a["box"], b["box"]);
    assert_eq!(a["rotation"], b["rotation"]);
    assert_eq!(b["displacement"], 0.0);
    // the whole drawing moves: the label moves with its line
    let mut moved = again.clone();
    for it in moved["items"].as_array_mut().unwrap() {
        if let Some(pts) = it["anchor"].get_mut("points") {
            for q in pts.as_array_mut().unwrap() {
                q[0] = json!(q[0].as_f64().unwrap() + 17.0);
                q[1] = json!(q[1].as_f64().unwrap() - 9.0);
            }
        } else {
            it["anchor"]["x"] = json!(217.0);
            it["anchor"]["y"] = json!(136.0);
        }
    }
    let third = solve(&moved);
    let c = &third["placements"][0];
    assert!((center(c).0 - center(a).0 - 17.0).abs() < 1e-6);
    assert!((center(c).1 - center(a).1 + 9.0).abs() < 1e-6);
    assert_eq!(c["rotation"], a["rotation"]);
}

#[test]
fn in_a_window_the_places_lie_on_the_piece_in_view() {
    // a street far longer than the view, which shows its right end
    let line = [[-2000.0, 150.0], [300.0, 150.0]];
    let r = solve(&problem(
        &line,
        json!({}),
        json!({"canvas": {"width": 400, "height": 300, "overscan": 0}}),
    ));
    let p = &r["placements"][0];
    assert_eq!(p["model"], "internal");
    assert_eq!(center(p).0, 150.0);
    assert_eq!(p["anchor"], json!([-850.0, 150.0]));
}

#[test]
fn line_labels_and_node_labels_share_a_graph() {
    let nodes = [("a", 80.0, 70.0), ("b", 320.0, 90.0), ("c", 200.0, 240.0)];
    let mut items: Vec<Value> = nodes
        .iter()
        .map(|&(id, x, y)| {
            json!({"id": id,
            "anchor": {"type": "point", "x": x, "y": y, "mark": {"shape": "circle", "r": 8}},
            "label": {"type": "text", "text": format!("Node {id}")}})
        })
        .collect();
    for (i, j) in [(0, 1), (1, 2), (2, 0)] {
        items.push(json!({"id": format!("{}{}", nodes[i].0, nodes[j].0),
            "anchor": {"type": "line", "points": [[nodes[i].1, nodes[i].2], [nodes[j].1, nodes[j].2]]},
            "label": {"type": "text", "text": "relates to"}}));
    }
    let r = solve(
        &json!({"version": "1", "canvas": {"width": 400, "height": 300}, "preset": "graph",
        "items": items}),
    );
    assert_eq!(r["stats"]["placed"], 6, "{}", r["placements"]);
    assert_eq!(r["stats"]["hard_violations"], 0);
    for p in &r["placements"].as_array().unwrap()[3..] {
        assert_eq!(p["model"], "internal");
        assert!(p["rotation"].as_f64().is_some());
    }
}

#[test]
fn a_line_without_length_is_invalid() {
    let p = problem(&[[10.0, 10.0], [10.0, 10.0]], json!({}), json!({}));
    let rep = label_anything_core::validate::validate(&p);
    assert!(!rep.valid);
    assert_eq!(rep.errors[0].code, "invalid_value");
    assert_eq!(rep.errors[0].pointer, "/items/0/anchor/points");
}
