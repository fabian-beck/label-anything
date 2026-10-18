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
