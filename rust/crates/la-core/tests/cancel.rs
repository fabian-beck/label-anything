//! Cancellation (spec §10.3a): a cancelled solve stops early but returns a valid result.
use label_anything_core::env::Env;
use label_anything_core::place;
use serde_json::{json, Value};
use std::cell::Cell;

/// Cancels after `after` polls and records progress reports.
struct CancelAfter {
    polls: Cell<usize>,
    after: usize,
    progress: Cell<usize>,
}

impl Env for CancelAfter {
    fn cancelled(&self) -> bool {
        self.polls.set(self.polls.get() + 1);
        self.polls.get() > self.after
    }
    fn progress(&self, _phase: &str, fraction: f64) {
        assert!((0.0..=1.0).contains(&fraction));
        self.progress.set(self.progress.get() + 1);
    }
}

fn crowded() -> Value {
    let items: Vec<Value> = (0..300)
        .map(|i| {
            let (x, y) = (20.0 + (i % 20) as f64 * 18.0, 20.0 + (i / 20) as f64 * 14.0);
            json!({"id": format!("i{i}"), "anchor": {"type": "point", "x": x, "y": y},
                   "label": {"type": "text", "text": format!("Label {i}")}, "priority": (i % 5) as f64})
        })
        .collect();
    json!({"canvas": {"width": 400, "height": 260}, "items": items,
           "solver": {"strategy": "local", "time_budget_ms": 1e5, "max_iterations": 100000}})
}

#[test]
fn cancelled_solve_is_valid_and_reported() {
    let p = crowded();
    let full = place(
        &p,
        &CancelAfter {
            polls: Cell::new(0),
            after: usize::MAX,
            progress: Cell::new(0),
        },
    )
    .unwrap();
    assert_eq!(full["stats"]["cancelled"], false);
    for after in [0usize, 1, 3, 10] {
        let env = CancelAfter {
            polls: Cell::new(0),
            after,
            progress: Cell::new(0),
        };
        let r = place(&p, &env).unwrap();
        let st = &r["stats"];
        assert_eq!(st["cancelled"], true, "after {after}");
        assert_eq!(st["hard_violations"], 0, "after {after}");
        assert!(st["placed"].as_u64().unwrap() <= full["stats"]["placed"].as_u64().unwrap());
        assert!(env.progress.get() > 0);
        // items never reached are reported as budget_exhausted
        let exhausted = r["placements"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|q| q["reason"] == "budget_exhausted")
            .count();
        if after == 0 {
            assert_eq!(st["placed"], 0);
            assert_eq!(exhausted, 300);
        }
    }
}
