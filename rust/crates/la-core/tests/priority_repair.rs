//! The priority repair moves one label aside (ADR priority/repair): an omitted item gets a label
//! when the one more important label in its way can move to another of its positions.
use label_anything_core::env::BasicEnv;
use label_anything_core::place;
use serde_json::{json, Value};

/// "B" (more important) prefers its right side, where it blocks the only position of "H",
/// above its mark; without the lookahead and the search, the greedy pass leaves "H" out.
fn problem(extra: &[Value]) -> Value {
    let item = |id: &str, x: f64, y: f64, w: f64, priority: f64, order: &[&str]| {
        json!({"id": id, "anchor": {"type": "point", "x": x, "y": y}, "priority": priority,
               "label": {"type": "text", "text": id, "width": w, "height": 10, "padding": 0},
               "placement": {"position_order": order}})
    };
    let mut items = vec![
        item("B", 50.0, 50.0, 40.0, 2.0, &["right", "left"]),
        item("H", 100.0, 50.0, 30.0, 1.0, &["top"]),
    ];
    items.extend(extra.iter().cloned());
    json!({"version": "1", "canvas": {"width": 200, "height": 100}, "preset": "none",
           "items": items, "placement": {"models": ["adjacent"]},
           "weights": {"lookahead": 0, "starve": 0}, "degrade": ["omit"],
           "solver": {"strategy": "greedy"}})
}

/// A less important item whose only label comes 2 px close to the left position of "B".
fn lower(id: &str, y: f64, priority: f64, side: &str) -> Value {
    let x = if side == "bottom" { 20.0 } else { 30.0 };
    json!({"id": id, "anchor": {"type": "point", "x": x, "y": y}, "priority": priority,
           "label": {"type": "text", "text": id, "width": 30, "height": 10, "padding": 0},
           "placement": {"position_order": [side]}})
}

fn sides(r: &Value) -> Vec<(String, Option<String>)> {
    r["placements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let side = p["anchor_side"].as_str().map(str::to_string);
            (p["id"].as_str().unwrap().to_string(), side)
        })
        .collect()
}

fn s(id: &str, side: Option<&str>) -> (String, Option<String>) {
    (id.to_string(), side.map(str::to_string))
}

#[test]
fn a_more_important_label_moves_aside() {
    let r = place(&problem(&[]), &BasicEnv).unwrap();
    assert_eq!(sides(&r), vec![s("B", Some("left")), s("H", Some("top"))]);
    assert_eq!(r["stats"]["priority_inversions"], 0);
}

#[test]
fn one_less_important_label_gives_way() {
    let r = place(&problem(&[lower("L1", 30.0, 0.0, "bottom")]), &BasicEnv).unwrap();
    assert_eq!(
        sides(&r),
        vec![s("B", Some("left")), s("H", Some("top")), s("L1", None)]
    );
    assert_eq!(r["placements"][2]["reason"], "omitted_by_priority");
}

#[test]
fn two_less_important_labels_do_not() {
    let p = problem(&[
        lower("L1", 30.0, 0.0, "bottom"),
        lower("L2", 70.0, -1.0, "top"),
    ]);
    let r = place(&p, &BasicEnv).unwrap();
    assert_eq!(
        sides(&r),
        vec![
            s("B", Some("right")),
            s("H", None),
            s("L1", Some("bottom")),
            s("L2", Some("top"))
        ]
    );
}

#[test]
fn the_moved_label_may_take_a_pruned_position() {
    // a costly shade on the left position: the pruning drops it (`prune_factor` 1)
    let mut p = problem(&[]);
    p["obstacles"] = json!({"vector": [{"class": "shade", "rects": [[7, 45, 40, 10]]}]});
    p["avoid"] = json!({"label": {"shade": 5}});
    p["placement"]["prune_factor"] = json!(1);
    let r = place(&p, &BasicEnv).unwrap();
    assert_eq!(sides(&r), vec![s("B", Some("left")), s("H", Some("top"))]);
    assert_eq!(r["stats"]["candidates"], 3);
}

#[test]
fn a_place_moved_from_serves_an_item_visited_before() {
    // "E" (between "B" and "H") is visited first: its cheap position below is taken by "F",
    // which cannot move, and the one above, under a costly shade, was pruned and is in
    // the way of "B" on the right. Once "B" moves aside for "H", the pass without moves
    // finds that position free.
    let item = |id: &str, x: f64, y: f64, priority: f64, order: &[&str]| {
        json!({"id": id, "anchor": {"type": "point", "x": x, "y": y}, "priority": priority,
               "label": {"type": "text", "text": id, "width": 30, "height": 10, "padding": 0},
               "placement": {"position_order": order}})
    };
    let mut p = problem(&[]);
    let items = p["items"].as_array_mut().unwrap();
    items.insert(1, item("F", 75.0, 95.0, 3.5, &["top"]));
    items.insert(2, item("E", 75.0, 70.0, 3.0, &["bottom", "top"]));
    p["canvas"]["height"] = json!(120);
    p["obstacles"] = json!({"vector": [{"class": "shade", "rects": [[60, 57, 30, 10]]}]});
    p["avoid"] = json!({"label": {"shade": 5}});
    p["placement"]["prune_factor"] = json!(1);
    let r = place(&p, &BasicEnv).unwrap();
    assert_eq!(
        sides(&r),
        vec![
            s("B", Some("left")),
            s("F", Some("top")),
            s("E", Some("top")),
            s("H", Some("top"))
        ]
    );
    assert_eq!(r["stats"]["priority_inversions"], 0);
}
