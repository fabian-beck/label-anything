//! Property tests of the brief (§9) on random problems:
//!
//! * `prefix` omission: the placed set is a prefix of the total priority order;
//! * monotonicity: raising a placed item's priority never gets it omitted;
//! * shape fidelity: adjacent and slider labels touch the inflated true shape of their
//!   mark (gap within 0.5 px of `placement.offset`) for circles, ellipses, rotated
//!   rounded rects and concave polygons;
//! * leaders start on the true boundary, `leaders.anchor_gap` outside along the ray from
//!   the mark's reference point (spec §7), and end at their port;
//! * label boxes stay inside the canvas less its padding.
use label_anything_core::env::BasicEnv;
use label_anything_core::geom::shape::Shape;
use label_anything_core::geom::{Rect, P};
use label_anything_core::place;
use serde_json::{json, Value};

/// Small deterministic generator (SplitMix64).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn f(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.f()
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn cases(default: u64) -> u64 {
    std::env::var("LA_PROPERTY_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

const WORDS: [&str; 8] = [
    "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta",
];

/// Point items with explicit, distinct priorities in a crowded canvas.
fn crowded(seed: u64, omission: &str, strategy: &str) -> Value {
    let mut r = Rng(seed);
    let (w, h) = (r.range(160.0, 320.0), r.range(120.0, 240.0));
    let n = 10 + r.below(40) as usize;
    let items: Vec<Value> = (0..n)
        .map(|i| {
            json!({
                "id": format!("i{i}"),
                "anchor": {"type": "point", "x": r.range(5.0, w - 5.0), "y": r.range(5.0, h - 5.0)},
                "label": {"type": "text", "text": WORDS[r.below(8) as usize]},
                "priority": r.range(0.0, 100.0),
            })
        })
        .collect();
    let models = if r.below(2) == 0 {
        json!(["adjacent", "slider"])
    } else {
        json!(["adjacent", "slider", "distant"])
    };
    json!({
        "canvas": {"width": w, "height": h, "padding": 2},
        "items": items,
        "obstacles": {"vector": [{"class": "points", "r": 1.5,
            "points": (0..r.below(100)).map(|_| json!([r.range(0.0, w), r.range(0.0, h)])).collect::<Vec<_>>()}]},
        "avoid": {"label": {"points": 0.3}},
        "placement": {"models": models},
        "priority": {"omission": omission},
        "solver": {"strategy": strategy, "time_budget_ms": 1e7, "max_iterations": 2000}
    })
}

fn placements(r: &Value) -> &Vec<Value> {
    r["placements"].as_array().unwrap()
}

fn rank(p: &Value) -> u64 {
    p["priority"]["rank"].as_u64().unwrap()
}

#[test]
fn prefix_mode_places_a_prefix_of_the_priority_order() {
    for seed in 0..cases(60) {
        let p = crowded(seed, "prefix", ["greedy", "local"][seed as usize % 2]);
        let r = place(&p, &BasicEnv).unwrap();
        let mut placed: Vec<u64> = placements(&r)
            .iter()
            .filter(|q| q["placed"] == true)
            .map(rank)
            .collect();
        placed.sort_unstable();
        let expect: Vec<u64> = (0..placed.len() as u64).collect();
        assert_eq!(placed, expect, "seed {seed}: placed ranks are not a prefix");
        for q in placements(&r).iter().filter(|q| q["placed"] == false) {
            if rank(q) > placed.len() as u64 {
                assert_eq!(q["reason"], "omitted_by_priority", "seed {seed}");
            }
        }
    }
}

#[test]
fn raising_a_placed_items_priority_keeps_it_placed() {
    for seed in 0..cases(60) {
        let omission = ["strict", "prefix"][seed as usize % 2];
        let strategy = ["greedy", "local"][(seed / 2) as usize % 2];
        let mut p = crowded(seed, omission, strategy);
        let r = place(&p, &BasicEnv).unwrap();
        let placed: Vec<&Value> = placements(&r)
            .iter()
            .filter(|q| q["placed"] == true)
            .collect();
        if placed.is_empty() {
            continue;
        }
        // raise the lowest-ranked placed item above everything
        let low = placed.iter().max_by_key(|q| rank(q)).unwrap();
        let id = low["id"].as_str().unwrap().to_string();
        let items = p["items"].as_array_mut().unwrap();
        let top = items
            .iter()
            .map(|it| it["priority"].as_f64().unwrap())
            .fold(f64::MIN, f64::max);
        let it = items.iter_mut().find(|it| it["id"] == id.as_str()).unwrap();
        it["priority"] = json!(top + 1.0);
        let r2 = place(&p, &BasicEnv).unwrap();
        let q = placements(&r2)
            .iter()
            .find(|q| q["id"] == id.as_str())
            .unwrap();
        assert_eq!(
            q["placed"], true,
            "seed {seed} ({omission}, {strategy}): {id} was omitted after raising its priority"
        );
        assert_eq!(rank(q), 0, "seed {seed}");
    }
}

/// A random mark (JSON) and the same shape built directly.
fn random_mark(r: &mut Rng, at: P) -> (Value, Shape) {
    match r.below(4) {
        0 => {
            let rad = r.range(1.0, 14.0);
            (json!({"shape": "circle", "r": rad}), Shape::circle(at, rad))
        }
        1 => {
            let (rx, ry, rot) = (r.range(2.0, 16.0), r.range(2.0, 12.0), r.range(0.0, 180.0));
            (
                json!({"shape": "ellipse", "rx": rx, "ry": ry, "rotation": rot}),
                Shape::ellipse(at, rx, ry, rot),
            )
        }
        2 => {
            let (w, h, rot) = (r.range(3.0, 30.0), r.range(3.0, 20.0), r.range(0.0, 90.0));
            let cr = r.range(0.0, w.min(h) * 0.5);
            (
                json!({"shape": "rect", "w": w, "h": h, "corner_radius": cr, "rotation": rot}),
                Shape::rect(at, w, h, cr, rot),
            )
        }
        _ => {
            // concave: a star (or an L when the inner radius is small)
            let k = 3 + r.below(4) as usize;
            let (ro, ri) = (r.range(6.0, 16.0), r.range(2.0, 6.0));
            let phase = r.range(0.0, 1.0);
            let pts: Vec<[f64; 2]> = (0..2 * k)
                .map(|j| {
                    let a = (j as f64 + phase) * std::f64::consts::PI / k as f64;
                    let rad = if j % 2 == 0 { ro } else { ri };
                    [rad * a.cos(), rad * a.sin()]
                })
                .collect();
            let ring: Vec<P> = pts.iter().map(|q| at + P::new(q[0], q[1])).collect();
            (
                json!({"shape": "polygon", "relative": true, "points": pts}),
                Shape::polygon(vec![ring], false, at),
            )
        }
    }
}

#[test]
fn adjacent_labels_touch_the_inflated_true_shape() {
    let mut checked = 0;
    for seed in 0..cases(80) {
        let mut r = Rng(1000 + seed);
        let offset = r.range(0.0, 4.0);
        // a sparse grid, so that most labels sit next to their marks
        let mut items = Vec::new();
        let mut shapes = Vec::new();
        for gy in 0..3 {
            for gx in 0..3 {
                let at = P::new(70.0 + 130.0 * gx as f64, 50.0 + 100.0 * gy as f64);
                let (mark, shape) = random_mark(&mut r, at);
                items.push(json!({
                    "id": format!("m{}", items.len()),
                    "anchor": {"type": "point", "x": at.x, "y": at.y, "mark": mark},
                    "label": {"type": "text", "text": WORDS[r.below(8) as usize]},
                }));
                shapes.push(shape);
            }
        }
        let p = json!({
            "canvas": {"width": 400, "height": 300},
            "items": items,
            "placement": {"models": ["adjacent", "slider"], "offset": offset, "internal": "never"},
            "solver": {"time_budget_ms": 1e7, "max_iterations": 500}
        });
        let res = place(&p, &BasicEnv).unwrap();
        for (k, q) in placements(&res).iter().enumerate() {
            if q["placed"] != true || !matches!(q["model"].as_str(), Some("adjacent" | "slider")) {
                continue;
            }
            let b = &q["box"];
            let rect = Rect::xywh(
                b["x"].as_f64().unwrap(),
                b["y"].as_f64().unwrap(),
                b["w"].as_f64().unwrap(),
                b["h"].as_f64().unwrap(),
            );
            let gap = shapes[k].dist_rect(&rect);
            assert!(
                gap >= offset - 0.5 && gap <= offset + 0.5,
                "seed {seed}, item {k}: gap {gap:.3} px to the mark, offset {offset:.3} ({})",
                items[k]["anchor"]["mark"]
            );
            checked += 1;
        }
    }
    assert!(checked > 100, "only {checked} labels checked");
}

#[test]
fn leaders_start_at_the_anchor_gap_and_end_at_the_port() {
    let mut checked = 0;
    for seed in 0..cases(60) {
        let mut r = Rng(5000 + seed);
        let gap = r.range(0.0, 3.0);
        let mut items = Vec::new();
        let mut shapes = Vec::new();
        let mut ats = Vec::new();
        // crowded marks around the center, so that many labels need leaders
        for _ in 0..(12 + r.below(12)) {
            let at = P::new(r.range(150.0, 250.0), r.range(110.0, 190.0));
            let (mark, shape) = random_mark(&mut r, at);
            items.push(json!({
                "id": format!("m{}", items.len()),
                "anchor": {"type": "point", "x": at.x, "y": at.y, "mark": mark},
                "label": {"type": "text", "text": WORDS[r.below(8) as usize]},
            }));
            shapes.push(shape);
            ats.push(at);
        }
        let style = ["straight", "angles", "orthogonal", "elbow", "curved"][r.below(5) as usize];
        let p = json!({
            "canvas": {"width": 400, "height": 300, "padding": 3},
            "items": items,
            "avoid": {"label": {"items": "ignore", "own_mark": "hard"}},
            "placement": {"models": ["distant"], "internal": "never"},
            "leaders": {"style": style, "anchor_gap": gap},
            "solver": {"time_budget_ms": 1e7, "max_iterations": 500}
        });
        let res = place(&p, &BasicEnv).unwrap();
        assert_eq!(res["stats"]["hard_violations"], 0, "seed {seed}");
        for (k, q) in placements(&res).iter().enumerate() {
            if q["placed"] != true {
                continue;
            }
            let b = &q["box"];
            let (x, y, w, h) = (
                b["x"].as_f64().unwrap(),
                b["y"].as_f64().unwrap(),
                b["w"].as_f64().unwrap(),
                b["h"].as_f64().unwrap(),
            );
            assert!(
                x >= 3.0 - 1e-9
                    && y >= 3.0 - 1e-9
                    && x + w <= 397.0 + 1e-9
                    && y + h <= 297.0 + 1e-9,
                "seed {seed}, item {k}: box outside the canvas padding"
            );
            let Some(l) = q["leader"].as_object() else {
                continue;
            };
            let pts = l["points"].as_array().unwrap();
            let pt = |v: &Value| P::new(v[0].as_f64().unwrap(), v[1].as_f64().unwrap());
            let first = pt(&pts[0]);
            let last = pt(pts.last().unwrap());
            let port = pt(&l["port"]);
            assert!(
                last.dist(port) < 1e-9,
                "seed {seed}, item {k}: leader does not end at its port"
            );
            // spec §7: on the true boundary toward the port (along the ray from the
            // mark's reference point), `anchor_gap` outside
            let v = first - ats[k];
            let len = v.dist(P::new(0.0, 0.0));
            assert!(
                len > 1e-9,
                "seed {seed}, item {k}: leader starts at the anchor"
            );
            let on_boundary = first - v * (gap / len);
            let d = shapes[k].signed_distance(on_boundary);
            assert!(
                d.abs() <= 0.5 && shapes[k].signed_distance(first) >= -0.5,
                "seed {seed}, item {k} ({style}): leader start {gap:.3} px back along its ray is {d:.3} px from the boundary"
            );
            checked += 1;
        }
    }
    assert!(checked > 50, "only {checked} leaders checked");
}
