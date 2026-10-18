//! The greedy pass's wall-clock guard (ADR 0042) runs from the start of the pass: a slow
//! preparation (host text measurement) does not leave the labels unplaced.
use label_anything_core::env::{Env, FontSpec, TextMetrics};
use label_anything_core::place;
use serde_json::json;
use std::cell::Cell;

/// A clock that advances 5 ms with every host measurement, and only then.
struct SlowMeasure {
    now: Cell<f64>,
}

impl Env for SlowMeasure {
    fn now_ms(&self) -> f64 {
        self.now.get()
    }
    fn measure(&self, _text: &str, _font: &FontSpec) -> Option<TextMetrics> {
        self.now.set(self.now.get() + 5.0);
        None
    }
}

#[test]
fn slow_preparation_does_not_starve_the_greedy_pass() {
    let items: Vec<_> = (0..10)
        .map(|i| {
            json!({"id": format!("i{i}"), "anchor": {"type": "point", "x": 40.0 + i as f64 * 70.0, "y": 100.0},
                   "label": {"type": "text", "text": format!("L{i}")}, "priority": i as f64})
        })
        .collect();
    // guard 10 ms; measuring the ten labels alone takes 50 ms on this clock
    let p = json!({"canvas": {"width": 800, "height": 200}, "items": items,
                   "solver": {"strategy": "greedy", "time_budget_ms": 1}});
    let r = place(
        &p,
        &SlowMeasure {
            now: Cell::new(1.0),
        },
    )
    .unwrap();
    assert_eq!(r["stats"]["placed"], 10);
    assert_eq!(r["stats"]["time_guard_hit"], false);
}

/// A clock that advances `step` ms every time it is read.
struct Ticking {
    now: Cell<f64>,
    step: f64,
}

impl Ticking {
    fn new(step: f64) -> Self {
        Ticking {
            now: Cell::new(1.0),
            step,
        }
    }
}

impl Env for Ticking {
    fn now_ms(&self) -> f64 {
        self.now.set(self.now.get() + self.step);
        self.now.get()
    }
}

/// 200 labels in four rows, each with a free position, every one its own priority band.
fn rows(omission: &str) -> serde_json::Value {
    let items: Vec<_> = (0..200)
        .map(|i| {
            json!({"id": format!("i{i}"),
                   "anchor": {"type": "point", "x": 20.0 + (i % 50) as f64 * 40.0, "y": 50.0 + (i / 50) as f64 * 100.0},
                   "label": {"type": "text", "text": format!("L{i}")}, "priority": (200 - i) as f64})
        })
        .collect();
    // guard 10 ms: it passes after a few bands on this clock
    json!({"canvas": {"width": 2020, "height": 420}, "items": items, "priority": {"omission": omission},
           "solver": {"strategy": "greedy", "time_budget_ms": 1}})
}

#[test]
fn after_the_guard_the_rest_get_level_0() {
    let r = place(&rows("strict"), &Ticking::new(1.0)).unwrap();
    assert_eq!(r["stats"]["time_guard_hit"], true);
    // every label has a free level-0 position: the level-0 pass after the guard places them
    // all (ADR 0048); before, the items after the guard were budget_exhausted
    assert_eq!(r["stats"]["placed"], 200);
}

#[test]
fn after_the_guard_a_prefix_continues_at_level_0() {
    // the prefix checks the guard every 64 items: it passes at the first check, and the
    // guard of the level-0 pass ends the prefix at a later one
    let r = place(&rows("prefix"), &Ticking::new(6.0)).unwrap();
    assert_eq!(r["stats"]["time_guard_hit"], true);
    let placements = r["placements"].as_array().unwrap();
    let placed = r["stats"]["placed"].as_u64().unwrap() as usize;
    // before ADR 0048 the 63 items before the first check were all that was placed
    assert!(placed > 64 && placed < 200, "placed {placed}");
    // still a prefix of the priority order (= input order here), the rest out of time
    assert!(placements[..placed].iter().all(|p| p["placed"] == true));
    assert!(placements[placed..]
        .iter()
        .all(|p| p["reason"] == "budget_exhausted"));
}

#[test]
fn the_level_0_pass_has_its_own_guard() {
    // 1,000 items: the level-0 pass checks its guard every 64 items, one clock reading each,
    // and stops 10 ms after it began; the rest are budget_exhausted
    let items: Vec<_> = (0..1000)
        .map(|i| {
            json!({"id": format!("i{i}"), "anchor": {"type": "point", "x": 20.0 + (i % 50) as f64 * 40.0,
                   "y": 20.0 + (i / 50) as f64 * 30.0},
                   "label": {"type": "text", "text": "L"}, "priority": (1000 - i) as f64})
        })
        .collect();
    let p = json!({"canvas": {"width": 2020, "height": 640}, "items": items,
                   "solver": {"strategy": "greedy", "time_budget_ms": 1}});
    let r = place(&p, &Ticking::new(1.0)).unwrap();
    assert_eq!(r["stats"]["time_guard_hit"], true);
    let placed = r["stats"]["placed"].as_u64().unwrap();
    let exhausted = r["placements"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["reason"] == "budget_exhausted")
        .count();
    assert!(placed > 100 && placed < 1000, "placed {placed}");
    assert!(exhausted > 0);
}
