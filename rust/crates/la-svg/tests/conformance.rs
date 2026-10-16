//! Runs the language-neutral cases in `conformance/svg/*.json` (format: conformance/svg/README.md).

use std::collections::BTreeMap;
use std::path::PathBuf;

use label_anything_svg::{
    classify, element_geometry, outline, parse, select, ClassRule, Geometry, ParseOptions,
    Primitive,
};
use serde_json::Value;

fn repo_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// Area covered by `rings` under the fill rule: exact scanline integration with events at
/// all vertex ordinates and edge intersections (the covered width is linear in between).
fn fill_area(rings: &[Vec<[f64; 2]>], even_odd: bool) -> f64 {
    let mut edges: Vec<[f64; 4]> = Vec::new();
    for r in rings {
        for k in 0..r.len() {
            let a = r[k];
            let b = r[(k + 1) % r.len()];
            if a[1] != b[1] {
                edges.push([a[0], a[1], b[0], b[1]]);
            }
        }
    }
    let mut ys: Vec<f64> = edges.iter().flat_map(|e| [e[1], e[3]]).collect();
    for i in 0..edges.len() {
        for j in i + 1..edges.len() {
            let (p, q) = (edges[i], edges[j]);
            let d = (p[2] - p[0]) * (q[3] - q[1]) - (p[3] - p[1]) * (q[2] - q[0]);
            if d == 0.0 {
                continue;
            }
            let t = ((q[0] - p[0]) * (q[3] - q[1]) - (q[1] - p[1]) * (q[2] - q[0])) / d;
            let u = ((q[0] - p[0]) * (p[3] - p[1]) - (q[1] - p[1]) * (p[2] - p[0])) / d;
            if t > 0.0 && t < 1.0 && u > 0.0 && u < 1.0 {
                ys.push(p[1] + t * (p[3] - p[1]));
            }
        }
    }
    ys.sort_by(|a, b| a.partial_cmp(b).unwrap());
    ys.dedup();
    let mut area = 0.0;
    for w in ys.windows(2) {
        let (ya, yb) = (w[0], w[1]);
        let ym = (ya + yb) / 2.0;
        let mut xs: Vec<(f64, i32)> = Vec::new();
        for e in &edges {
            let (lo, hi) = if e[1] < e[3] {
                (e[1], e[3])
            } else {
                (e[3], e[1])
            };
            if ym > lo && ym < hi {
                let x = e[0] + (ym - e[1]) * (e[2] - e[0]) / (e[3] - e[1]);
                xs.push((x, if e[3] > e[1] { 1 } else { -1 }));
            }
        }
        xs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let mut wind = 0;
        let mut len = 0.0;
        for k in 0..xs.len() {
            let inside = if even_odd { wind % 2 != 0 } else { wind != 0 };
            if inside && k > 0 {
                len += xs[k].0 - xs[k - 1].0;
            }
            wind += xs[k].1;
        }
        area += len * (yb - ya);
    }
    area
}

fn polyline_length(points: &[[f64; 2]], closed: bool) -> f64 {
    let mut l = 0.0;
    for k in 1..points.len() {
        l += ((points[k][0] - points[k - 1][0]).powi(2)
            + (points[k][1] - points[k - 1][1]).powi(2))
        .sqrt();
    }
    if closed && points.len() > 1 {
        let (a, b) = (points[0], points[points.len() - 1]);
        l += ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt();
    }
    l
}

#[derive(Default, Debug)]
struct Summary {
    count: usize,
    polygons: usize,
    polylines: usize,
    rects: usize,
    fill_area: f64,
    stroke_length: f64,
    widths: Option<(f64, f64)>,
    bbox: Option<[f64; 4]>,
    vertices: usize,
}

impl Summary {
    fn extend(&mut self, p: [f64; 2]) {
        self.bbox = Some(match self.bbox {
            None => [p[0], p[1], p[0], p[1]],
            Some(b) => [
                b[0].min(p[0]),
                b[1].min(p[1]),
                b[2].max(p[0]),
                b[3].max(p[1]),
            ],
        });
    }

    fn add(&mut self, g: &Geometry) {
        self.count += 1;
        match g {
            Geometry::Polygon { rings, even_odd } => {
                self.polygons += 1;
                self.fill_area += fill_area(rings, *even_odd);
                for p in rings.iter().flatten() {
                    self.vertices += 1;
                    self.extend(*p);
                }
            }
            Geometry::Polyline {
                points,
                width,
                closed,
            } => {
                self.polylines += 1;
                self.stroke_length += polyline_length(points, *closed);
                self.widths = Some(match self.widths {
                    None => (*width, *width),
                    Some((a, b)) => (a.min(*width), b.max(*width)),
                });
                for p in points {
                    self.vertices += 1;
                    self.extend(*p);
                }
            }
            Geometry::Rect { x, y, w, h } => {
                self.rects += 1;
                self.extend([*x, *y]);
                self.extend([x + w, y + h]);
            }
        }
    }
}

fn summarize<'a>(geoms: impl IntoIterator<Item = &'a Geometry>) -> Summary {
    let mut s = Summary::default();
    for g in geoms {
        s.add(g);
    }
    s
}

struct Tol {
    area: f64,
    length: f64,
    bbox: f64,
}

fn num(v: &Value) -> f64 {
    v.as_f64()
        .unwrap_or_else(|| panic!("number expected, got {v}"))
}

fn check_summary(what: &str, s: &Summary, e: &Value, tol: &Tol, errs: &mut Vec<String>) {
    let close = |a: f64, b: f64, rel: f64, abs: f64| (a - b).abs() <= (rel * b.abs()).max(abs);
    for (key, actual) in [
        ("count", s.count),
        ("polygons", s.polygons),
        ("polylines", s.polylines),
        ("rects", s.rects),
        ("vertices", s.vertices),
    ] {
        if let Some(v) = e.get(key) {
            if v.as_u64() != Some(actual as u64) {
                errs.push(format!("{what}: {key} = {actual}, expected {v}"));
            }
        }
    }
    if let Some(v) = e.get("fill_area") {
        if !close(s.fill_area, num(v), tol.area, 0.5) {
            errs.push(format!("{what}: fill_area = {}, expected {v}", s.fill_area));
        }
    }
    if let Some(v) = e.get("stroke_length") {
        if !close(s.stroke_length, num(v), tol.length, 0.05) {
            errs.push(format!(
                "{what}: stroke_length = {}, expected {v}",
                s.stroke_length
            ));
        }
    }
    if let Some(v) = e.get("stroke_width") {
        let (lo, hi) = (num(&v[0]), num(&v[1]));
        match s.widths {
            Some((a, b)) if close(a, lo, 0.01, 1e-6) && close(b, hi, 0.01, 1e-6) => {}
            w => errs.push(format!("{what}: stroke_width = {w:?}, expected {v}")),
        }
    }
    if let Some(v) = e.get("bbox") {
        check_bbox(
            what,
            s.bbox.map(|b| [b[0], b[1], b[2] - b[0], b[3] - b[1]]),
            v,
            tol.bbox,
            errs,
        );
    }
}

fn check_bbox(what: &str, actual: Option<[f64; 4]>, e: &Value, tol: f64, errs: &mut Vec<String>) {
    match (actual, e.as_array()) {
        (None, None) if e.is_null() => {}
        (Some(a), Some(want)) if want.len() == 4 => {
            if (0..4).any(|k| (a[k] - num(&want[k])).abs() > tol) {
                errs.push(format!("{what}: bbox = {a:?}, expected {e}"));
            }
        }
        (a, _) => errs.push(format!("{what}: bbox = {a:?}, expected {e}")),
    }
}

fn geometries<'a>(prims: impl IntoIterator<Item = &'a Primitive>) -> Vec<&'a Geometry> {
    prims.into_iter().map(|p| &p.geometry).collect()
}

fn run_case(case: &Value) -> Result<(), Vec<String>> {
    let mut errs = Vec::new();
    let svg = match &case["svg"] {
        Value::String(s) => s.clone(),
        Value::Array(lines) => lines
            .iter()
            .map(|l| l.as_str().expect("svg line"))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return Err(vec!["missing 'svg'".into()]),
    };
    let mut opts = ParseOptions::default();
    if let Some(c) = case.get("canvas") {
        opts.canvas = Some((num(&c["width"]), num(&c["height"])));
    }
    if let Some(t) = case.get("tolerance") {
        opts.tolerance = num(t);
    }
    let expect = &case["expect"];
    let tol = Tol {
        area: expect.pointer("/tol/area").map_or(0.01, num),
        length: expect.pointer("/tol/length").map_or(0.01, num),
        bbox: expect.pointer("/tol/bbox").map_or(0.5, num),
    };
    let scene = match parse(&svg, &opts) {
        Ok(s) => s,
        Err(e) => {
            if expect.get("error").and_then(Value::as_str) == Some(e.code.as_str()) {
                return Ok(());
            }
            return Err(vec![format!("parse failed: {e}")]);
        }
    };
    if let Some(code) = expect.get("error") {
        return Err(vec![format!("expected error {code}, parse succeeded")]);
    }

    let rules: Vec<ClassRule> = match (case.get("classes"), case.get("preset")) {
        (Some(c), _) => c.as_array().expect("classes").iter().map(rule).collect(),
        (None, Some(p)) => {
            let path = repo_dir()
                .join("spec/presets")
                .join(format!("{}.json", p.as_str().expect("preset")));
            let preset: Value =
                serde_json::from_str(&std::fs::read_to_string(&path).expect("preset file"))
                    .expect("preset json");
            preset["svg_classes"]
                .as_array()
                .expect("svg_classes")
                .iter()
                .map(rule)
                .collect()
        }
        (None, None) => Vec::new(),
    };
    let default_class = case
        .get("default_class")
        .and_then(Value::as_str)
        .unwrap_or("ink");

    for (key, actual) in [
        ("width", scene.width),
        ("height", scene.height),
        ("canvas_width", scene.canvas_width),
        ("canvas_height", scene.canvas_height),
    ] {
        if let Some(v) = expect.get(key) {
            if (actual - num(v)).abs() > 1e-6 * num(v).abs().max(1.0) {
                errs.push(format!("{key} = {actual}, expected {v}"));
            }
        }
    }
    if let Some(v) = expect.get("element_count") {
        if v.as_u64() != Some(scene.elements.len() as u64) {
            errs.push(format!(
                "element_count = {}, expected {v}",
                scene.elements.len()
            ));
        }
    }
    if let Some(v) = expect.get("warnings") {
        let mut want: Vec<String> = v
            .as_array()
            .expect("warnings")
            .iter()
            .map(|w| w.as_str().unwrap().to_string())
            .collect();
        let mut got: Vec<String> = scene
            .warnings
            .iter()
            .map(|w| w.code.as_str().to_string())
            .collect();
        want.sort();
        got.sort();
        if want != got {
            errs.push(format!("warnings = {got:?}, expected {want:?}"));
        }
    }

    match classify(&scene, &rules, default_class) {
        Err(e) => {
            if expect.get("classify_error").and_then(Value::as_str) != Some(e.code.as_str()) {
                errs.push(format!("classify failed: {e}"));
            }
        }
        Ok(classified) => {
            if let Some(code) = expect.get("classify_error") {
                errs.push(format!("expected classify error {code}"));
            }
            let mut by_class: BTreeMap<&str, Vec<&Geometry>> = BTreeMap::new();
            for c in &classified {
                by_class
                    .entry(c.class)
                    .or_default()
                    .push(&c.primitive.geometry);
            }
            if let Some(classes) = expect.get("classes").and_then(Value::as_object) {
                for (name, e) in classes {
                    let s = summarize(by_class.get(name.as_str()).cloned().unwrap_or_default());
                    check_summary(&format!("class {name}"), &s, e, &tol, &mut errs);
                }
                if expect
                    .get("exact_classes")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
                {
                    for name in by_class.keys() {
                        if !classes.contains_key(*name) {
                            errs.push(format!(
                                "unexpected class {name} ({} primitives)",
                                by_class[name].len()
                            ));
                        }
                    }
                }
            }
        }
    }

    if let Some(els) = expect.get("elements").and_then(Value::as_object) {
        for (id, e) in els {
            let Some(i) = scene.element_by_id(id) else {
                errs.push(format!("element #{id} not found"));
                continue;
            };
            let el = &scene.elements[i];
            for (key, actual) in [
                ("drawn", el.drawn),
                ("filled", el.filled),
                ("stroked", el.stroked),
            ] {
                if let Some(v) = e.get(key) {
                    if v.as_bool() != Some(actual) {
                        errs.push(format!("#{id}: {key} = {actual}, expected {v}"));
                    }
                }
            }
            if let Some(v) = e.get("tag") {
                if v.as_str() != Some(el.tag.as_str()) {
                    errs.push(format!("#{id}: tag = {}, expected {v}", el.tag));
                }
            }
            if let Some(v) = e.get("bbox") {
                check_bbox(
                    &format!("#{id}"),
                    el.bbox.map(|b| [b.x, b.y, b.w, b.h]),
                    v,
                    tol.bbox,
                    &mut errs,
                );
            }
        }
    }

    if let Some(list) = expect.get("select").and_then(Value::as_array) {
        for e in list {
            let sel = e["selector"].as_str().expect("selector");
            match select(&scene, sel) {
                Err(err) => {
                    if e.get("error").and_then(Value::as_str) != Some(err.code.as_str()) {
                        errs.push(format!("select {sel:?}: {err}"));
                    }
                }
                Ok(prims) => {
                    if e.get("error").is_some() {
                        errs.push(format!("select {sel:?}: expected an error"));
                    }
                    let s = summarize(geometries(prims.iter().copied()));
                    check_summary(&format!("select {sel:?}"), &s, e, &tol, &mut errs);
                    if let Some(o) = e.get("outline") {
                        let out = outline(prims.iter().copied());
                        check_summary(
                            &format!("outline of {sel:?}"),
                            &summarize(&out),
                            o,
                            &tol,
                            &mut errs,
                        );
                    }
                }
            }
        }
    }

    if let Some(list) = expect.get("geometry").and_then(Value::as_array) {
        for e in list {
            let id = e["id"].as_str().expect("id");
            match element_geometry(&scene, id) {
                None => {
                    if !e.get("missing").and_then(Value::as_bool).unwrap_or(false) {
                        errs.push(format!("geometry #{id}: no such element"));
                    }
                }
                Some(prims) => {
                    let s = summarize(geometries(prims));
                    check_summary(&format!("geometry #{id}"), &s, e, &tol, &mut errs);
                    if let Some(o) = e.get("outline") {
                        let out = outline(prims);
                        check_summary(
                            &format!("outline #{id}"),
                            &summarize(&out),
                            o,
                            &tol,
                            &mut errs,
                        );
                    }
                }
            }
        }
    }

    if errs.is_empty() {
        Ok(())
    } else {
        Err(errs)
    }
}

fn rule(v: &Value) -> ClassRule {
    ClassRule::new(
        v["selector"].as_str().expect("selector"),
        v["class"].as_str().expect("class"),
    )
}

#[test]
fn svg_conformance() {
    let dir = repo_dir().join("conformance/svg");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    let mut failures = Vec::new();
    let mut ran = 0;
    for f in &files {
        let case: Value = serde_json::from_str(&std::fs::read_to_string(f).unwrap())
            .unwrap_or_else(|e| panic!("{}: {e}", f.display()));
        if case["kind"] != "svg" {
            continue;
        }
        ran += 1;
        if let Err(errs) = run_case(&case) {
            failures.push(format!(
                "{}:\n  {}",
                f.file_name().unwrap().to_string_lossy(),
                errs.join("\n  ")
            ));
        }
    }
    assert!(
        ran > 0,
        "no svg conformance cases found in {}",
        dir.display()
    );
    assert!(
        failures.is_empty(),
        "{} of {ran} cases failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn fill_area_reference() {
    let sq = vec![vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]]];
    assert!((fill_area(&sq, false) - 100.0).abs() < 1e-9);
    // Donut: same orientation → non-zero fills the hole, even-odd does not.
    let mut donut = sq.clone();
    donut.push(vec![[2.0, 2.0], [8.0, 2.0], [8.0, 8.0], [2.0, 8.0]]);
    assert!((fill_area(&donut, false) - 100.0).abs() < 1e-9);
    assert!((fill_area(&donut, true) - 64.0).abs() < 1e-9);
    // Opposite orientation → both rules leave the hole.
    let mut donut2 = sq.clone();
    donut2.push(vec![[2.0, 2.0], [2.0, 8.0], [8.0, 8.0], [8.0, 2.0]]);
    assert!((fill_area(&donut2, false) - 64.0).abs() < 1e-9);
    // Self-intersecting bow tie: two triangles of area 25 each.
    let bow = vec![vec![[0.0, 0.0], [10.0, 10.0], [10.0, 0.0], [0.0, 10.0]]];
    assert!((fill_area(&bow, false) - 50.0).abs() < 1e-9);
    assert!((fill_area(&bow, true) - 50.0).abs() < 1e-9);
}
