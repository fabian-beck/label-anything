//! Problem JSON → validate + place: a result or structured errors, never a panic.
#![no_main]
use libfuzzer_sys::fuzz_target;
use serde_json::{json, Value};

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    let Ok(mut v) = serde_json::from_str::<Value>(text) else {
        return;
    };
    // budgets and sizes are not under test: keep every run short
    if let Some(o) = v.as_object_mut() {
        let solver = o.entry("solver").or_insert(json!({}));
        if let Some(s) = solver.as_object_mut() {
            s.insert("time_budget_ms".into(), json!(20));
            s.insert("max_iterations".into(), json!(500));
            s.insert("strategy".into(), json!("greedy"));
        }
    }
    let _ = label_anything::validate(&v);
    let _ = label_anything::place(&v);
});
