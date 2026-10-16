//! Runs the `place` cases of `conformance/` (format: `conformance/README.md`) against the
//! native implementation, with an independent re-check of the hard guarantees the
//! runner can verify on its own (label overlaps, canvas bounds, leader crossings).
//! `validate` cases are run by `label-anything-core`'s own test; `text`, `expr`, `math`,
//! `raster` and `svg` cases by their crates.
use serde_json::Value;
use std::path::{Path, PathBuf};

fn conformance_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance")
}

fn load(p: &Path) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{}: {e}", p.display())),
    )
    .unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn placement<'a>(r: &'a Value, id: &str) -> Option<&'a Value> {
    r["placements"].as_array()?.iter().find(|p| p["id"] == id)
}

fn px(v: &Value, em: f64) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => {
            let s = s.trim();
            let (num, mul) = if let Some(n) = s.strip_suffix("px") {
                (n, 1.0)
            } else if let Some(n) = s.strip_suffix("pt") {
                (n, 4.0 / 3.0)
            } else if let Some(n) = s.strip_suffix("em") {
                (n, em)
            } else {
                (s, 1.0)
            };
            num.parse::<f64>().unwrap_or(0.0) * mul
        }
        _ => 0.0,
    }
}

struct BoxR {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

fn box_of(p: &Value) -> Option<BoxR> {
    let b = p.get("box")?;
    let (x, y, w, h) = (
        b["x"].as_f64()?,
        b["y"].as_f64()?,
        b["w"].as_f64()?,
        b["h"].as_f64()?,
    );
    Some(BoxR {
        x0: x,
        y0: y,
        x1: x + w,
        y1: y + h,
    })
}

fn seg_cross(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    let o = |p: [f64; 2], q: [f64; 2], r: [f64; 2]| {
        (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    };
    let (d1, d2, d3, d4) = (o(c, d, a), o(c, d, b), o(a, b, c), o(a, b, d));
    ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9))
        && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))
}

fn leader_segments(p: &Value) -> Vec<([f64; 2], [f64; 2])> {
    let mut out = Vec::new();
    let mut ls: Vec<&Value> = Vec::new();
    if let Some(l) = p.get("leader").filter(|l| !l.is_null()) {
        ls.push(l);
    }
    if let Some(a) = p.get("leaders").and_then(|v| v.as_array()) {
        ls.extend(a.iter());
    }
    for l in ls {
        let pts: Vec<[f64; 2]> = l["points"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|q| Some([q[0].as_f64()?, q[1].as_f64()?]))
            .collect();
        for w in pts.windows(2) {
            out.push((w[0], w[1]));
        }
    }
    out
}

/// Check one case; returns the list of failed expectations.
fn check_place(name: &str, problem: &Value, exp: &Value) -> Vec<String> {
    let mut f = Vec::new();
    let r = match label_anything::place(problem) {
        Ok(r) => r,
        Err(e) => return vec![format!("place failed: {e}")],
    };
    let st = &r["stats"];
    let placements = r["placements"].as_array().cloned().unwrap_or_default();
    let placed: Vec<&Value> = placements.iter().filter(|p| p["placed"] == true).collect();
    let mut num = |key: &str, actual: &Value| {
        if let Some(e) = exp.get(key) {
            if e != actual {
                f.push(format!("{key}: expected {e}, got {actual}"));
            }
        }
    };
    num("hard_violations", &st["hard_violations"]);
    num("leader_crossings", &st["leader_crossings"]);
    num("priority_inversions", &st["priority_inversions"]);
    num("placed", &st["placed"]);
    let n_placed = placed.len() as u64;
    if let Some(m) = exp.get("placed_min").and_then(|v| v.as_u64()) {
        if n_placed < m {
            f.push(format!("placed_min: {n_placed} < {m}"));
        }
    }
    if let Some(m) = exp.get("placed_max").and_then(|v| v.as_u64()) {
        if n_placed > m {
            f.push(format!("placed_max: {n_placed} > {m}"));
        }
    }
    for (key, want) in [("placed_ids", true), ("unplaced_ids", false)] {
        for id in exp
            .get(key)
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            let id = id.as_str().unwrap_or("");
            match placement(&r, id) {
                Some(p) if (p["placed"] == true) == want => {}
                Some(_) => f.push(format!("{key}: {id} has placed = {}", !want)),
                None => f.push(format!("{key}: no placement for {id}")),
            }
        }
    }
    for (key, field) in [
        ("reasons", "reason"),
        ("anchor_side", "anchor_side"),
        ("model", "model"),
    ] {
        if let Some(Value::Object(m)) = exp.get(key) {
            for (id, want) in m {
                let got = placement(&r, id)
                    .map(|p| p[field].clone())
                    .unwrap_or(Value::Null);
                if &got != want {
                    f.push(format!("{key}.{id}: expected {want}, got {got}"));
                }
            }
        }
    }
    if let Some(e) = exp.get("omission_order") {
        if &st["omission_order"] != e {
            f.push(format!(
                "omission_order: expected {e}, got {}",
                st["omission_order"]
            ));
        }
    }
    if let Some(Value::Object(m)) = exp.get("has_leader") {
        for (id, want) in m {
            let got = placement(&r, id)
                .map(|p| !leader_segments(p).is_empty())
                .unwrap_or(false);
            if Some(got) != want.as_bool() {
                f.push(format!("has_leader.{id}: expected {want}, got {got}"));
            }
        }
    }
    if let Some(Value::Object(m)) = exp.get("text_lines") {
        for (id, want) in m {
            let got = placement(&r, id)
                .map(|p| p["text"]["lines"].clone())
                .unwrap_or(Value::Null);
            if &got != want {
                f.push(format!("text_lines.{id}: expected {want}, got {got}"));
            }
        }
    }
    if let Some(Value::Object(m)) = exp.get("box") {
        for (id, want) in m {
            let tol = want.get("tol").and_then(|v| v.as_f64()).unwrap_or(0.01);
            let got = placement(&r, id)
                .and_then(|p| p.get("box"))
                .cloned()
                .unwrap_or(Value::Null);
            for k in ["x", "y", "w", "h"] {
                let (a, b) = (
                    got[k].as_f64().unwrap_or(f64::NAN),
                    want[k].as_f64().unwrap_or(f64::NAN),
                );
                if !((a - b).abs() <= tol) {
                    f.push(format!("box.{id}.{k}: expected {b} ± {tol}, got {a}"));
                }
            }
        }
    }
    // independent re-check: no two placed rectangular labels overlap
    let boxes: Vec<(String, BoxR)> = placed
        .iter()
        .filter_map(|p| Some((p["id"].as_str()?.to_string(), box_of(p)?)))
        .collect();
    let labels_hard = problem
        .pointer("/avoid/label/labels")
        .map(|v| v == "hard")
        .unwrap_or(true);
    if labels_hard {
        for i in 0..boxes.len() {
            for j in i + 1..boxes.len() {
                let (a, b) = (&boxes[i].1, &boxes[j].1);
                let e = 1e-6;
                if a.x0 < b.x1 - e && b.x0 < a.x1 - e && a.y0 < b.y1 - e && b.y0 < a.y1 - e {
                    f.push(format!("labels {} and {} overlap", boxes[i].0, boxes[j].0));
                }
            }
        }
    }
    // independent re-check: no two leaders cross (when crossings are hard, the default)
    let leaders_hard = problem
        .pointer("/avoid/leader/leaders")
        .map(|v| v == "hard")
        .unwrap_or(true);
    if leaders_hard {
        let segs: Vec<(usize, Vec<([f64; 2], [f64; 2])>)> = placed
            .iter()
            .enumerate()
            .map(|(k, p)| (k, leader_segments(p)))
            .collect();
        for i in 0..segs.len() {
            for j in i + 1..segs.len() {
                let cross = segs[i]
                    .1
                    .iter()
                    .any(|&(a, b)| segs[j].1.iter().any(|&(c, d)| seg_cross(a, b, c, d)));
                if cross {
                    f.push(format!(
                        "leaders of {} and {} cross",
                        placed[i]["id"], placed[j]["id"]
                    ));
                }
            }
        }
    }
    if exp.get("inside_canvas") == Some(&Value::Bool(true)) {
        if let Some(c) = problem.get("canvas") {
            let em = problem
                .pointer("/defaults/font/size")
                .and_then(|v| v.as_f64())
                .unwrap_or(12.0);
            let pad = c.get("padding").map(|v| px(v, em)).unwrap_or(0.0);
            let (w, h) = (
                c["width"].as_f64().unwrap_or(0.0),
                c["height"].as_f64().unwrap_or(0.0),
            );
            for (id, b) in &boxes {
                let e = 1e-6;
                if b.x0 < pad - e || b.y0 < pad - e || b.x1 > w - pad + e || b.y1 > h - pad + e {
                    f.push(format!(
                        "inside_canvas: {id} at [{}, {}, {}, {}]",
                        b.x0, b.y0, b.x1, b.y1
                    ));
                }
            }
        }
    }
    if exp.get("prefix") == Some(&Value::Bool(true)) {
        let mut ranked: Vec<(u64, bool)> = placements
            .iter()
            .filter(|p| p["reason"] != "grouped" && p["reason"] != "keep_with")
            .filter_map(|p| Some((p["priority"]["rank"].as_u64()?, p["placed"] == true)))
            .collect();
        ranked.sort();
        if let Some(cut) = ranked.iter().position(|x| !x.1) {
            if ranked[cut..].iter().any(|x| x.1) {
                f.push("prefix: a placed item follows an omitted one in priority order".into());
            }
        }
    }
    if let Some(gap) = exp.get("touch_gap_max").and_then(|v| v.as_f64()) {
        // point anchors with circle marks: adjacent labels touch the mark inflated by offset
        let em = problem
            .pointer("/defaults/font/size")
            .and_then(|v| v.as_f64())
            .unwrap_or(12.0);
        let offset = problem
            .pointer("/placement/offset")
            .map(|v| px(v, em))
            .unwrap_or_else(|| {
                px(
                    &la_core::options::default_of("placement.offset", "rust"),
                    em,
                )
            });
        for it in problem["items"].as_array().into_iter().flatten() {
            let id = it["id"].as_str().unwrap_or("");
            let Some(p) = placement(&r, id).filter(|p| p["model"] == "adjacent") else {
                continue;
            };
            let Some(b) = box_of(p) else { continue };
            let (ax, ay) = (
                it["anchor"]["x"].as_f64().unwrap_or(0.0),
                it["anchor"]["y"].as_f64().unwrap_or(0.0),
            );
            let mark = it["anchor"].get("mark").cloned().unwrap_or_else(|| {
                problem
                    .pointer("/defaults/mark")
                    .cloned()
                    .unwrap_or_else(|| la_core::options::default_of("defaults.mark", "rust"))
            });
            if mark["shape"] != "circle" {
                continue;
            }
            let rr = mark["r"].as_f64().unwrap_or(0.0);
            let dx = (b.x0 - ax).max(ax - b.x1).max(0.0);
            let dy = (b.y0 - ay).max(ay - b.y1).max(0.0);
            let d = (dx * dx + dy * dy).sqrt() - rr - offset;
            if d > gap + 1e-9 || d < -1e-6 {
                f.push(format!("touch_gap_max: {id} gap {d}"));
            }
        }
    }
    if exp.get("deterministic") == Some(&Value::Bool(true)) {
        let r2 = label_anything::place(problem).unwrap();
        if r["placements"] != r2["placements"] {
            f.push("deterministic: two runs differ".into());
        }
    }
    let _ = name;
    f
}

#[test]
fn place_cases() {
    let dir = conformance_dir().join("place");
    let mut entries: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    entries.sort();
    let mut failures = Vec::new();
    let mut n = 0;
    for path in entries
        .into_iter()
        .filter(|p| p.extension().map(|e| e == "json").unwrap_or(false))
    {
        let case = load(&path);
        assert_eq!(case["kind"], "place", "{}", path.display());
        let problem = match (case.get("problem"), case.get("problem_file")) {
            (Some(p), _) => p.clone(),
            (None, Some(f)) => load(&dir.join(f.as_str().unwrap())),
            _ => panic!("{}: no problem", path.display()),
        };
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        let fails = check_place(&name, &problem, &case["expect"]);
        if !fails.is_empty() {
            failures.push(format!("{name}: {}", fails.join("; ")));
        }
        n += 1;
    }
    assert!(n >= 20, "only {n} place cases");
    assert!(
        failures.is_empty(),
        "{} of {n} place cases failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
