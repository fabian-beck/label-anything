//! Property test: random problems (several priority bands, obstacles, leaders, composite
//! labels, groups) must always solve with 0 hard violations, 0 priority inversions and 0
//! leader crossings, deterministically. The solver's own verification would *repair* a
//! violation (and report it), so any non-zero count here is a solver bug.
use label_anything_core::env::BasicEnv;
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

const WORDS: [&str; 12] = [
    "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa",
    "org.example.Name", "A much longer label",
];

fn problem(seed: u64) -> Value {
    let mut r = Rng(seed);
    let (w, h) = (r.range(200.0, 500.0), r.range(150.0, 400.0));
    let n = 5 + r.below(40) as usize;
    let clustered = r.below(2) == 0;
    let (cx, cy) = (w * 0.5, h * 0.5);
    let mut items = Vec::new();
    for i in 0..n {
        let (x, y) = if clustered {
            (cx + r.range(-60.0, 60.0), cy + r.range(-45.0, 45.0))
        } else {
            (r.range(0.0, w), r.range(0.0, h))
        };
        let text = WORDS[r.below(WORDS.len() as u64) as usize];
        let label = match r.below(6) {
            0 => json!({"type": "composite", "gap": 2, "parts": [
                {"type": "icon", "width": 9, "height": 9, "shape": "circle"},
                {"type": "text", "text": text}]}),
            1 => json!({"type": "text", "text": text, "wrap": {"max_width": 40, "max_lines": 2}}),
            2 => json!({"type": "box", "width": r.range(8.0, 40.0), "height": r.range(6.0, 20.0)}),
            _ => json!({"type": "text", "text": text}),
        };
        let mut item = json!({
            "id": format!("i{i}"),
            "anchor": {"type": "point", "x": x, "y": y},
            "label": label,
            // few distinct scores: several items per priority band
            "priority": r.below(4) as f64,
        });
        if r.below(10) == 0 {
            item["required"] = json!(true);
        }
        if r.below(12) == 0 {
            item["tier"] = json!(1);
        }
        items.push(item);
    }
    let mut obstacles = json!({"vector": [
        {"class": "points", "points": (0..r.below(200)).map(|_| json!([r.range(0.0, w), r.range(0.0, h)])).collect::<Vec<_>>(), "r": 1.5},
        {"class": "walls", "rects": (0..r.below(4)).map(|_| json!([r.range(0.0, w), r.range(0.0, h), r.range(5.0, 60.0), r.range(5.0, 60.0)])).collect::<Vec<_>>()}
    ]});
    if r.below(3) == 0 {
        obstacles["vector"].as_array_mut().unwrap().push(json!({"class": "lines",
            "polylines": [[[0.0, r.range(0.0, h)], [w, r.range(0.0, h)]]], "width": 1.5}));
    }
    let models = match r.below(4) {
        0 => json!(["adjacent", "slider"]),
        1 => json!(["adjacent", "slider", "distant"]),
        2 => json!(["adjacent", "slider", "boundary"]),
        _ => json!(["adjacent", "slider", "distant", "boundary"]),
    };
    let style = ["straight", "angles", "orthogonal", "elbow", "curved"][r.below(5) as usize];
    let omission = ["strict", "strict", "prefix", "weighted"][r.below(4) as usize];
    let strategy = ["greedy", "local", "auto"][r.below(3) as usize];
    json!({
        "canvas": {"width": w, "height": h, "padding": 2},
        "items": items,
        "obstacles": obstacles,
        "avoid": {"label": {"walls": "hard", "points": 0.3, "lines": 1.0}},
        "placement": {"models": models},
        "leaders": {"style": style},
        "priority": {"omission": omission},
        "solver": {"strategy": strategy, "time_budget_ms": 200, "max_iterations": 3000}
    })
}

#[test]
fn random_problems_keep_the_guarantees() {
    let n: u64 = std::env::var("LA_RANDOM_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(150);
    let mut failures = Vec::new();
    for seed in 0..n {
        let p = problem(seed);
        let r = place(&p, &BasicEnv).unwrap_or_else(|e| panic!("seed {seed}: {e}"));
        let st = &r["stats"];
        for k in ["hard_violations", "priority_inversions", "leader_crossings"] {
            if st[k] != 0 {
                failures.push(format!("seed {seed}: {k} = {}", st[k]));
            }
        }
        let r2 = place(&p, &BasicEnv).unwrap();
        if r["placements"] != r2["placements"] {
            failures.push(format!("seed {seed}: not deterministic"));
        }
    }
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
}
