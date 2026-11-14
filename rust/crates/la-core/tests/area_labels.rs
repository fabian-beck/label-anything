//! Labels of area anchors (spec §6.5, ADR placement/areas): inside the polygon, at places
//! spread over the part the label fits in, turned along a slanted polygon.
use label_anything_core::env::BasicEnv;
use label_anything_core::model::area_angle;
use label_anything_core::place;
use serde_json::{json, Value};

/// A `w` × `h` rectangle around (`cx`, `cy`), turned by `deg` (clockwise on screen).
fn slab(cx: f64, cy: f64, w: f64, h: f64, deg: f64) -> Vec<[f64; 2]> {
    let (s, c) = deg.to_radians().sin_cos();
    [(-w, -h), (w, -h), (w, h), (-w, h)]
        .iter()
        .map(|&(x, y)| {
            let (x, y) = (x / 2.0, y / 2.0);
            [cx + x * c - y * s, cy + x * s + y * c]
        })
        .collect()
}

fn problem(polygon: &[[f64; 2]], extra: Value) -> Value {
    let mut p = json!({"version": "1", "canvas": {"width": 400, "height": 300},
        "items": [{"id": "a", "anchor": {"type": "area", "polygon": polygon},
                   "label": {"type": "text", "text": "Area", "width": 60, "height": 14, "padding": 0}}],
        "output": {"candidates": true}});
    for (k, v) in extra.as_object().into_iter().flatten() {
        p[k] = v.clone();
    }
    p
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

/// Even-odd point in polygon.
fn inside(poly: &[[f64; 2]], (x, y): (f64, f64)) -> bool {
    let mut odd = false;
    for i in 0..poly.len() {
        let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
        if (a[1] > y) != (b[1] > y) && x < a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]) {
            odd = !odd;
        }
    }
    odd
}

fn solve(p: &Value) -> Value {
    place(p, &BasicEnv).expect("a valid problem")
}

#[test]
fn candidates_of_a_roomy_area_are_inside_it_and_apart() {
    let poly = slab(200.0, 150.0, 300.0, 200.0, 0.0);
    let r = solve(&problem(&poly, json!({})));
    let cands = r["candidates"].as_array().unwrap();
    assert!(cands.len() >= 5, "{} candidates", cands.len());
    for c in cands {
        assert_eq!(c["model"], "internal", "no place beside the pole: {c}");
        assert!(corners(c).into_iter().all(|q| inside(&poly, q)), "{c}");
    }
    // the first is the middle of the rectangle: the pole, where the label lacks nothing
    let b = &cands[0]["box"];
    assert!((b["x"].as_f64().unwrap() - 170.0).abs() < 0.5, "{b}");
    assert!((b["y"].as_f64().unwrap() - 143.0).abs() < 0.5, "{b}");
    // and the others are spread over the area, not around it
    let xs: Vec<f64> = cands
        .iter()
        .map(|c| c["box"]["x"].as_f64().unwrap())
        .collect();
    let span =
        xs.iter().cloned().fold(f64::MIN, f64::max) - xs.iter().cloned().fold(f64::MAX, f64::min);
    assert!(span > 120.0, "candidates span {span} px");
    let p = &r["placements"][0];
    assert_eq!(p["model"], "internal");
    assert!(p.get("rotation").is_none(), "upright: {p}");
}

#[test]
fn a_label_is_turned_along_a_slanted_area_it_fits_no_other_way() {
    let poly = slab(200.0, 150.0, 260.0, 24.0, -35.0);
    let r = solve(&problem(&poly, json!({})));
    let p = &r["placements"][0];
    assert_eq!(p["model"], "internal", "{p}");
    assert!((p["rotation"].as_f64().unwrap() + 35.0).abs() < 1e-6, "{p}");
    assert_eq!(p["box"]["w"], 60.0);
    assert_eq!(p["box"]["h"], 14.0);
    assert!(corners(p).into_iter().all(|q| inside(&poly, q)), "{p}");
    // in the middle of the strip
    let c = corners(p);
    let (mx, my) = (
        c.iter().map(|q| q.0).sum::<f64>() / 4.0,
        c.iter().map(|q| q.1).sum::<f64>() / 4.0,
    );
    assert!(
        (mx - 200.0).abs() < 1.0 && (my - 150.0).abs() < 1.0,
        "center {mx}, {my}"
    );
}

#[test]
fn rotation_is_limited_and_can_be_turned_off() {
    let poly = slab(200.0, 150.0, 260.0, 24.0, -35.0);
    let off = solve(&problem(&poly, json!({"placement": {"area_rotation": 0}})));
    let p = &off["placements"][0];
    assert!(p.get("rotation").is_none(), "{p}");
    assert_ne!(
        p["model"], "internal",
        "the label fits no upright place: {p}"
    );
    // a strip at 70° wide enough for a label at 20°
    let steep = slab(200.0, 150.0, 260.0, 70.0, 70.0);
    let r = solve(&problem(
        &steep,
        json!({"placement": {"area_rotation": 20}}),
    ));
    let p = &r["placements"][0];
    assert_eq!(p["rotation"], 20.0, "{p}");
    assert!(corners(p).into_iter().all(|q| inside(&steep, q)), "{p}");
}

#[test]
fn a_label_that_fits_nowhere_inside_stands_beside_the_pole() {
    let poly = slab(200.0, 150.0, 30.0, 12.0, 0.0);
    let r = solve(&problem(&poly, json!({})));
    let cands = r["candidates"].as_array().unwrap();
    assert!(cands.iter().all(|c| c["model"] != "internal"));
    assert_eq!(r["placements"][0]["model"], "adjacent");
}

#[test]
fn a_turned_label_keeps_its_place_as_a_warm_start() {
    let poly = slab(200.0, 150.0, 260.0, 24.0, -35.0);
    let first = solve(&problem(&poly, json!({})));
    let again = solve(&problem(
        &poly,
        json!({"warm_start": {"placements": first["placements"]}}),
    ));
    let (p, q) = (&first["placements"][0], &again["placements"][0]);
    assert_eq!(p["box"], q["box"]);
    assert_eq!(p["rotation"], q["rotation"]);
    assert_eq!(q["displacement"], 0.0);
    // the warm-start label stays turned where turning is off now
    let kept = solve(&problem(
        &poly,
        json!({"warm_start": {"placements": first["placements"]}, "placement": {"area_rotation": 0}}),
    ));
    assert_eq!(kept["placements"][0]["rotation"], p["rotation"]);
}

#[test]
fn a_turned_label_gives_way_to_marks_and_labels_exactly() {
    // a point right beside the strip's label, inside the label's bounding box: the label
    // stays, since neither the mark nor its label touch the turned box
    let poly = slab(200.0, 150.0, 260.0, 24.0, -35.0);
    let mut p = problem(&poly, json!({}));
    p["items"].as_array_mut().unwrap().push(json!({"id": "pt",
        "anchor": {"type": "point", "x": 222.0, "y": 164.0},
        "label": {"type": "text", "text": "P", "width": 8, "height": 8, "padding": 0}}));
    let r = solve(&p);
    assert_eq!(r["stats"]["placed"], 2, "{}", r["placements"]);
    assert_eq!(r["stats"]["hard_violations"], 0);
    let a = &r["placements"][0];
    assert!(a["rotation"].is_number(), "{a}");
    // the mark's center is not on the turned label
    let c = corners(a);
    let cross = |i: usize, q: (f64, f64)| {
        let (p0, p1) = (c[i], c[(i + 1) % 4]);
        (p1.0 - p0.0) * (q.1 - p0.1) - (p1.1 - p0.1) * (q.0 - p0.0)
    };
    assert!(
        (0..4).any(|i| cross(i, (222.0, 164.0)) < 0.0),
        "the label covers the mark"
    );
}

#[test]
fn area_angle_limits() {
    assert_eq!(area_angle(None, 45.0), None);
    assert_eq!(area_angle(Some(30.0), 45.0), Some(30.0));
    assert_eq!(area_angle(Some(-30.0), 45.0), Some(-30.0));
    // steeper than the limit: the limit
    assert_eq!(area_angle(Some(70.0), 45.0), Some(45.0));
    assert_eq!(area_angle(Some(-70.0), 45.0), Some(-45.0));
    // nearly horizontal: upright
    assert_eq!(area_angle(Some(9.9), 45.0), None);
    assert_eq!(area_angle(Some(-9.9), 45.0), None);
    assert_eq!(area_angle(Some(10.0), 45.0), Some(10.0));
    // vertical reads upwards
    assert_eq!(area_angle(Some(90.0), 90.0), Some(-90.0));
    assert_eq!(area_angle(Some(90.0), 45.0), Some(-45.0));
    // off
    assert_eq!(area_angle(Some(30.0), 0.0), None);
    assert_eq!(area_angle(Some(f64::NAN), 45.0), None);
}
