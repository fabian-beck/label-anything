//! Generates `conformance/math/*.json` from the Rust `det_math` implementation.
//!
//! ```sh
//! cargo run -p label-anything-expr --example gen_math_vectors            # writes ../conformance/math
//! cargo run -p label-anything-expr --example gen_math_vectors -- <dir>   # writes <dir>
//! cargo run -p label-anything-expr --release --example gen_math_vectors -- --dump <dir> <n>
//! ```
//!
//! `--dump` writes `<n>` extra random samples per function as plain text (`in… out…` hex
//! per line) for `conformance/math/check_accuracy.py --dump <dir>`.
//!
//! All inputs are produced deterministically from `Pcg32` and exact bit manipulation, so
//! re-running the generator reproduces the files byte for byte.

use label_anything_expr::det_math::{self, Pcg32};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn hex(x: f64) -> String {
    if x.is_nan() {
        "0x7ff8000000000000".to_string()
    } else {
        format!("0x{:016x}", x.to_bits())
    }
}

const INF: f64 = f64::INFINITY;
const NAN: f64 = f64::NAN;

fn next_up(x: f64) -> f64 {
    if x >= 0.0 {
        f64::from_bits(x.to_bits() + 1)
    } else {
        f64::from_bits(x.to_bits() - 1)
    }
}

fn next_down(x: f64) -> f64 {
    -next_up(-x)
}

/// 2^e for -1074 <= e <= 1023, built from bits.
fn pow2(e: i32) -> f64 {
    if e >= -1022 {
        f64::from_bits(((e + 1023) as u64) << 52)
    } else {
        f64::from_bits(1u64 << (e + 1074))
    }
}

struct Gen {
    rng: Pcg32,
}

impl Gen {
    fn new(seed: u64) -> Self {
        Gen {
            rng: Pcg32::new(seed),
        }
    }
    fn bits(&mut self) -> f64 {
        let hi = self.rng.next_u32() as u64;
        let lo = self.rng.next_u32() as u64;
        f64::from_bits((hi << 32) | lo)
    }
    fn finite_bits(&mut self) -> f64 {
        loop {
            let x = self.bits();
            if x.is_finite() {
                return x;
            }
        }
    }
    fn uniform(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.rng.next_f64()
    }
    /// Positive value with uniformly random binary exponent in [lo, hi] and random mantissa.
    fn log_uniform(&mut self, lo: i32, hi: i32) -> f64 {
        let e = lo + self.rng.next_below((hi - lo + 1) as u32) as i32;
        let mant = ((self.rng.next_u32() as u64) << 20) ^ (self.rng.next_u32() as u64);
        let m = f64::from_bits((1023u64 << 52) | (mant & 0x000f_ffff_ffff_ffff));
        m * pow2(e)
    }
    fn sign(&mut self, x: f64) -> f64 {
        if self.rng.next_u32() & 1 == 1 {
            -x
        } else {
            x
        }
    }
    /// `log_uniform` with a random sign.
    fn slog(&mut self, lo: i32, hi: i32) -> f64 {
        let t = self.log_uniform(lo, hi);
        self.sign(t)
    }
}

struct Table {
    function: &'static str,
    inputs: usize,
    outputs: usize,
    description: String,
    rows: Vec<Vec<f64>>,
}

impl Table {
    fn to_json(&self) -> String {
        let mut s = String::new();
        s.push_str("{\n");
        let _ = writeln!(s, "  \"kind\": \"math\",");
        let _ = writeln!(s, "  \"function\": \"{}\",", self.function);
        let _ = writeln!(s, "  \"inputs\": {},", self.inputs);
        let _ = writeln!(s, "  \"outputs\": {},", self.outputs);
        let _ = writeln!(s, "  \"description\": \"{}\",", self.description);
        let _ = writeln!(
            s,
            "  \"generated_by\": \"rust/crates/la-expr/examples/gen_math_vectors.rs\","
        );
        s.push_str("  \"vectors\": [\n");
        for (i, row) in self.rows.iter().enumerate() {
            let cells: Vec<String> = row.iter().map(|&v| format!("\"{}\"", hex(v))).collect();
            let comma = if i + 1 < self.rows.len() { "," } else { "" };
            let _ = writeln!(s, "    [{}]{}", cells.join(", "), comma);
        }
        s.push_str("  ]\n}\n");
        s
    }
}

fn unary(function: &'static str, description: &str, xs: Vec<f64>, f: impl Fn(f64) -> f64) -> Table {
    let rows = xs.into_iter().map(|x| vec![x, f(x)]).collect();
    Table {
        function,
        inputs: 1,
        outputs: 1,
        description: description.to_string(),
        rows,
    }
}

fn ln_inputs(g: &mut Gen) -> Vec<f64> {
    let mut v = vec![
        0.0,
        -0.0,
        -1.0,
        -5e-324,
        1.0,
        2.0,
        0.5,
        std::f64::consts::E,
        10.0,
        0.1,
        3.0,
        7.0,
        f64::MIN_POSITIVE,
        next_down(f64::MIN_POSITIVE),
        5e-324,
        1e-310,
        f64::MAX,
        INF,
        -INF,
        NAN,
        std::f64::consts::SQRT_2,
        next_up(std::f64::consts::SQRT_2),
        next_down(std::f64::consts::SQRT_2),
        std::f64::consts::FRAC_1_SQRT_2,
        next_down(std::f64::consts::FRAC_1_SQRT_2),
        next_up(1.0),
        next_down(1.0),
        1.0 + pow2(-30),
        1.0 - pow2(-30),
        1e-300,
        1e300,
        123456789.0,
    ];
    // Every reduction bucket j/64 (j = 45..=91), at its centre and near both edges,
    // at three binary scales.
    for j in 45..=91 {
        for f in [-0.49, 0.0, 0.49] {
            let m = (j as f64 + f) / 64.0;
            for s in [1.0, pow2(10), pow2(-1000)] {
                v.push(m * s);
            }
        }
    }
    for _ in 0..300 {
        v.push(g.finite_bits().abs());
    }
    for _ in 0..200 {
        v.push(g.uniform(0.5, 2.0));
    }
    for _ in 0..100 {
        let t = g.log_uniform(-60, -2);
        v.push(1.0 + g.sign(t));
    }
    v
}

fn ln_1p_inputs(g: &mut Gen) -> Vec<f64> {
    let mut v = vec![
        -1.0,
        next_up(-1.0),
        -0.9999999,
        -0.5,
        std::f64::consts::FRAC_1_SQRT_2 - 1.0,
        -0.25,
        -1e-5,
        -pow2(-54),
        -pow2(-55),
        next_down(-pow2(-54)),
        -0.0,
        0.0,
        pow2(-55),
        pow2(-54),
        next_down(pow2(-54)),
        pow2(-53),
        1e-300,
        5e-324,
        -5e-324,
        1e-10,
        1e-5,
        0.25,
        std::f64::consts::SQRT_2 - 1.0,
        0.5,
        1.0,
        2.0,
        10.0,
        1e10,
        9007199254740992.0,
        1e300,
        f64::MAX,
        INF,
        -INF,
        NAN,
        -2.0,
        next_down(-1.0),
    ];
    for _ in 0..300 {
        v.push(g.log_uniform(-70, 1000));
    }
    for _ in 0..300 {
        v.push(-g.log_uniform(-70, -1));
    }
    for _ in 0..300 {
        v.push(g.uniform(-1.0, 1.0));
    }
    for _ in 0..50 {
        v.push(-1.0 + g.log_uniform(-53, -2));
    }
    v
}

fn exp_inputs(g: &mut Gen) -> Vec<f64> {
    let ln2 = std::f64::consts::LN_2;
    let mut v = vec![
        0.0,
        -0.0,
        pow2(-60),
        -pow2(-60),
        pow2(-54),
        -pow2(-54),
        next_down(pow2(-54)),
        1.0,
        -1.0,
        0.5,
        ln2,
        -ln2,
        ln2 / 2.0,
        -ln2 / 2.0,
        10.0,
        -10.0,
        100.0,
        700.0,
        709.0,
        709.78,
        709.782712893384,
        next_up(709.782712893384),
        709.79,
        710.0,
        -700.0,
        -708.3964185322641,
        -708.4,
        -720.0,
        -744.44,
        -745.0,
        -745.13,
        -745.1332191019411,
        -745.14,
        -746.0,
        INF,
        -INF,
        NAN,
        1e-300,
        -1e-300,
        f64::MAX,
        -f64::MAX,
    ];
    for _ in 0..500 {
        v.push(g.uniform(-750.0, 715.0));
    }
    for _ in 0..300 {
        let t = g.log_uniform(-70, 0);
        v.push(g.sign(t));
    }
    for _ in 0..150 {
        let k = g.rng.next_below(4000) as f64 - 2000.0;
        let t = g.log_uniform(-60, -20);
        v.push(k * ln2 * 0.5 + g.sign(t));
    }
    v
}

fn pow_table(g: &mut Gen) -> Table {
    let xs = [
        0.0, -0.0, 1.0, -1.0, 2.0, -2.0, 0.5, -0.5, 3.0, -3.0, INF, -INF, NAN,
    ];
    let ys = [
        0.0,
        -0.0,
        1.0,
        -1.0,
        2.0,
        -2.0,
        3.0,
        -3.0,
        0.5,
        -0.5,
        1.0 / 3.0,
        INF,
        -INF,
        NAN,
        1e300,
        -1e300,
        9007199254740992.0,
        9007199254740991.0,
    ];
    let mut pairs = Vec::new();
    for &x in &xs {
        for &y in &ys {
            pairs.push((x, y));
        }
    }
    for (x, y) in [
        (2.0, 1023.0),
        (2.0, 1024.0),
        (2.0, -1022.0),
        (2.0, -1074.0),
        (2.0, -1075.0),
        (0.5, 1074.0),
        (10.0, 308.0),
        (10.0, 309.0),
        (10.0, -323.0),
        (10.0, -324.0),
        (10.0, 22.0),
        (10.0, 23.0),
        (3.0, 20.0),
        (7.0, 0.5),
        (2.0, 0.5),
        (1.0000000000000002, 4503599627370496.0),
        (0.9999999999999999, 9007199254740992.0),
        (1.0000001, 1073741825.0),
        (1.0000001, -2147483649.0),
        (-1.0000001, 1073741825.0),
        (-0.9999999, 1073741823.0),
        (5e-324, 0.5),
        (5e-324, -0.5),
        (5e-324, 1.0),
        (f64::MAX, 0.5),
        (f64::MAX, -1.0),
        (f64::MIN_POSITIVE, -1.0),
        (1e300, 1.5),
        (1e-300, -1.5),
    ] {
        pairs.push((x, y));
    }
    for _ in 0..300 {
        let x = g.uniform(-100.0, 100.0);
        let y = g.rng.next_below(81) as f64 - 40.0;
        pairs.push((x, y));
    }
    for _ in 0..400 {
        let x = g.log_uniform(-100, 100);
        let y = g.uniform(-30.0, 30.0);
        pairs.push((x, y));
    }
    for _ in 0..150 {
        let t = g.log_uniform(-50, -10);
        let x = 1.0 + g.sign(t);
        let y = g.slog(0, 45);
        pairs.push((x, y));
    }
    let rows = pairs
        .into_iter()
        .map(|(x, y)| vec![x, y, det_math::pow(x, y)])
        .collect();
    Table {
        function: "pow",
        inputs: 2,
        outputs: 1,
        description: "pow(x, y): [x, y, result]".to_string(),
        rows,
    }
}

fn sin_cos_inputs(g: &mut Gen) -> Vec<f64> {
    let mut v = Vec::new();
    for k in -48..=48 {
        v.push(k as f64 * 15.0);
    }
    v.extend_from_slice(&[
        -0.0,
        1e300,
        -1e300,
        1e22,
        9007199254740992.0,
        360.0 * 1099511627776.0 + 45.0,
        1e-300,
        5e-324,
        -5e-324,
        next_down(45.0),
        next_up(45.0),
        next_down(90.0),
        next_up(90.0),
        next_down(135.0),
        next_down(315.0),
        next_down(360.0),
        0.1,
        1.0,
        -1.0,
        44.5,
        f64::MAX,
        -f64::MAX,
        INF,
        -INF,
        NAN,
    ]);
    for _ in 0..300 {
        v.push(g.uniform(-45.0, 45.0));
    }
    for _ in 0..300 {
        v.push(g.uniform(-720.0, 720.0));
    }
    for _ in 0..150 {
        let t = g.log_uniform(-80, 70);
        v.push(g.sign(t));
    }
    v
}

fn atan2_table(g: &mut Gen) -> Table {
    let specials = [
        0.0,
        -0.0,
        1.0,
        -1.0,
        INF,
        -INF,
        NAN,
        5e-324,
        -5e-324,
        f64::MAX,
        -f64::MAX,
    ];
    let mut pairs = Vec::new();
    for &y in &specials {
        for &x in &specials {
            pairs.push((y, x));
        }
    }
    for _ in 0..300 {
        pairs.push((g.uniform(-1.0, 1.0), g.uniform(-1.0, 1.0)));
    }
    for _ in 0..200 {
        let y = g.slog(-600, 600);
        let x = g.slog(-600, 600);
        pairs.push((y, x));
    }
    // Ratios at the reduction bucket edges (2j+1)/16 and at the centres j/8.
    for j in 0..9 {
        for q in [(2 * j + 1) as f64 / 16.0, j as f64 / 8.0] {
            for _ in 0..3 {
                let s = g.log_uniform(-20, 20);
                let x = g.sign(s);
                let y = g.sign(q * s);
                pairs.push((y, x));
                pairs.push((x, y));
            }
        }
    }
    for _ in 0..20 {
        let s = g.log_uniform(-1074, 1023);
        pairs.push((g.sign(s), g.sign(s)));
    }
    for _ in 0..20 {
        let y = g.log_uniform(-1074, -200);
        let x = g.log_uniform(800, 1023);
        pairs.push((g.sign(y), g.sign(x)));
    }
    let rows = pairs
        .into_iter()
        .map(|(y, x)| vec![y, x, det_math::atan2_deg(y, x)])
        .collect();
    Table {
        function: "atan2_deg",
        inputs: 2,
        outputs: 1,
        description: "atan2_deg(y, x) in degrees: [y, x, result]".to_string(),
        rows,
    }
}

fn cbrt_inputs(g: &mut Gen) -> Vec<f64> {
    let mut v = vec![
        0.0,
        -0.0,
        1.0,
        -1.0,
        8.0,
        -8.0,
        27.0,
        -27.0,
        0.125,
        2.0,
        3.0,
        f64::MIN_POSITIVE,
        5e-324,
        -5e-324,
        f64::MAX,
        -f64::MAX,
        INF,
        -INF,
        NAN,
        1e-300,
        1e300,
    ];
    for k in 1..=100 {
        let k = k as f64;
        v.push(k * k * k);
    }
    for k in 1..=20 {
        let k = k as f64 * 1.5;
        v.push(-(k * k * k));
    }
    for _ in 0..400 {
        v.push(g.finite_bits());
    }
    for _ in 0..100 {
        v.push(g.uniform(1.0, 8.0));
    }
    v
}

fn rounding_inputs(g: &mut Gen) -> Vec<f64> {
    let mut v = vec![
        0.0,
        -0.0,
        0.5,
        -0.5,
        0.49999999999999994,
        -0.49999999999999994,
        0.5000000000000001,
        1.0,
        -1.0,
        1.5,
        -1.5,
        2.5,
        -2.5,
        3.5,
        4503599627370496.0,
        4503599627370495.5,
        -4503599627370495.5,
        4503599627370497.0,
        9007199254740992.0,
        1e300,
        -1e300,
        5e-324,
        -5e-324,
        f64::MIN_POSITIVE,
        f64::MAX,
        INF,
        -INF,
        NAN,
        0.1,
        -0.1,
        0.9999999999999999,
        -0.9999999999999999,
        123.456,
        -123.456,
    ];
    for _ in 0..200 {
        v.push(g.rng.next_below(8001) as f64 * 0.25 - 1000.0);
    }
    for _ in 0..200 {
        v.push(g.uniform(-1000.0, 1000.0));
    }
    for _ in 0..100 {
        v.push(g.finite_bits());
    }
    v
}

fn all_tables() -> Vec<Table> {
    let mut tables = vec![
        unary(
            "ln",
            "ln(x): [x, result]",
            ln_inputs(&mut Gen::new(101)),
            det_math::ln,
        ),
        unary(
            "ln_1p",
            "ln_1p(x) = ln(1 + x): [x, result]",
            ln_1p_inputs(&mut Gen::new(102)),
            det_math::ln_1p,
        ),
        unary(
            "exp",
            "exp(x): [x, result]",
            exp_inputs(&mut Gen::new(103)),
            det_math::exp,
        ),
        pow_table(&mut Gen::new(104)),
    ];
    let xs = sin_cos_inputs(&mut Gen::new(105));
    tables.push(Table {
        function: "sin_cos_deg",
        inputs: 1,
        outputs: 2,
        description: "sin_cos_deg(deg): [deg, sin, cos]".to_string(),
        rows: xs
            .into_iter()
            .map(|d| {
                let (s, c) = det_math::sin_cos_deg(d);
                vec![d, s, c]
            })
            .collect(),
    });
    tables.push(atan2_table(&mut Gen::new(106)));
    tables.push(unary(
        "cbrt",
        "cbrt(x): [x, result]",
        cbrt_inputs(&mut Gen::new(107)),
        det_math::cbrt,
    ));
    let r = rounding_inputs(&mut Gen::new(108));
    tables.push(unary(
        "floor",
        "floor(x): [x, result]",
        r.clone(),
        det_math::floor,
    ));
    tables.push(unary(
        "ceil",
        "ceil(x): [x, result]",
        r.clone(),
        det_math::ceil,
    ));
    tables.push(unary(
        "trunc",
        "trunc(x): [x, result]",
        r.clone(),
        det_math::trunc,
    ));
    tables.push(unary(
        "round_half_away",
        "round_half_away(x): [x, result]",
        r,
        det_math::round_half_away,
    ));
    tables
}

fn pcg_json() -> String {
    let mut s = String::new();
    s.push_str("{\n  \"kind\": \"math\",\n  \"function\": \"pcg32\",\n");
    s.push_str(
        "  \"description\": \"PCG32 (XSH-RR 64/32): first 1000 next_u32 outputs per seed, \
         next_below and next_f64 sequences, shuffles of [0, 1, ..., len-1]\",\n",
    );
    s.push_str("  \"generated_by\": \"rust/crates/la-expr/examples/gen_math_vectors.rs\",\n");
    s.push_str("  \"streams\": [\n");
    let seeds: [u64; 4] = [0, 1, 42, 4294967295];
    for (i, &seed) in seeds.iter().enumerate() {
        let mut rng = Pcg32::new(seed);
        let _ = writeln!(
            s,
            "    {{\n      \"seed\": \"0x{seed:016x}\",\n      \"next_u32\": ["
        );
        for line in 0..100 {
            let vals: Vec<String> = (0..10)
                .map(|_| format!("\"0x{:08x}\"", rng.next_u32()))
                .collect();
            let comma = if line < 99 { "," } else { "" };
            let _ = writeln!(s, "        {}{}", vals.join(", "), comma);
        }
        let comma = if i + 1 < seeds.len() { "," } else { "" };
        let _ = writeln!(s, "      ]\n    }}{comma}");
    }
    s.push_str("  ],\n  \"next_below\": [\n");
    let below: [(u64, u32); 9] = [
        (42, 1),
        (42, 2),
        (42, 3),
        (42, 10),
        (42, 1000),
        (7, 2147483649),
        (7, 4294967295),
        (18446744073709551615, 6),
        (0, 0),
    ];
    for (i, &(seed, n)) in below.iter().enumerate() {
        let mut rng = Pcg32::new(seed);
        let vals: Vec<String> = (0..64).map(|_| rng.next_below(n).to_string()).collect();
        let comma = if i + 1 < below.len() { "," } else { "" };
        let _ = writeln!(
            s,
            "    {{ \"seed\": \"0x{seed:016x}\", \"n\": {n}, \"values\": [{}] }}{comma}",
            vals.join(", ")
        );
    }
    s.push_str("  ],\n  \"next_f64\": [\n");
    for (i, &seed) in [42u64, 9007199254740993].iter().enumerate() {
        let mut rng = Pcg32::new(seed);
        let vals: Vec<String> = (0..32)
            .map(|_| format!("\"{}\"", hex(rng.next_f64())))
            .collect();
        let comma = if i == 0 { "," } else { "" };
        let _ = writeln!(
            s,
            "    {{ \"seed\": \"0x{seed:016x}\", \"values\": [{}] }}{comma}",
            vals.join(", ")
        );
    }
    s.push_str("  ],\n  \"shuffle\": [\n");
    let shuffles: [(u64, usize); 6] = [(0, 0), (0, 1), (0, 2), (42, 10), (42, 52), (1, 100)];
    for (i, &(seed, len)) in shuffles.iter().enumerate() {
        let mut rng = Pcg32::new(seed);
        let mut v: Vec<usize> = (0..len).collect();
        rng.shuffle(&mut v);
        let after = rng.next_u32();
        let vals: Vec<String> = v.iter().map(|x| x.to_string()).collect();
        let comma = if i + 1 < shuffles.len() { "," } else { "" };
        let _ = writeln!(
            s,
            "    {{ \"seed\": \"0x{seed:016x}\", \"len\": {len}, \"result\": [{}], \
             \"next_u32_after\": \"0x{after:08x}\" }}{comma}",
            vals.join(", ")
        );
    }
    s.push_str("  ]\n}\n");
    s
}

fn dump(dir: &Path, n: usize) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let mut g = Gen::new(9001);
    let w = |name: &str, rows: Vec<Vec<f64>>| -> std::io::Result<()> {
        let mut s = String::new();
        for row in rows {
            let cells: Vec<String> = row.iter().map(|&v| hex(v)).collect();
            let _ = writeln!(s, "{}", cells.join(" "));
        }
        std::fs::write(dir.join(format!("{name}.txt")), s)
    };
    let mut rows = Vec::new();
    for _ in 0..n {
        let x = if g.rng.next_u32() & 1 == 0 {
            g.finite_bits().abs()
        } else {
            g.uniform(0.5, 2.0)
        };
        rows.push(vec![x, det_math::ln(x)]);
    }
    w("ln", rows)?;
    let mut rows = Vec::new();
    for _ in 0..n {
        let x = match g.rng.next_below(3) {
            0 => g.log_uniform(-70, 1000),
            1 => -g.log_uniform(-70, -1),
            _ => g.uniform(-1.0, 1.0),
        };
        rows.push(vec![x, det_math::ln_1p(x)]);
    }
    w("ln_1p", rows)?;
    let mut rows = Vec::new();
    for _ in 0..n {
        let x = if g.rng.next_u32() & 1 == 0 {
            g.uniform(-745.0, 709.7)
        } else {
            let t = g.log_uniform(-60, 0);
            g.sign(t)
        };
        rows.push(vec![x, det_math::exp(x)]);
    }
    w("exp", rows)?;
    let mut rows = Vec::new();
    for _ in 0..n {
        let (x, y) = match g.rng.next_below(3) {
            0 => (g.log_uniform(-40, 40), g.uniform(-50.0, 50.0)),
            1 => (
                g.uniform(-1000.0, 1000.0),
                g.rng.next_below(129) as f64 - 64.0,
            ),
            _ => {
                let t = g.log_uniform(-40, -10);
                (1.0 + g.sign(t), g.slog(0, 40))
            }
        };
        let r = det_math::pow(x, y);
        if r.is_finite() && r != 0.0 && r.abs() >= f64::MIN_POSITIVE {
            rows.push(vec![x, y, r]);
        }
    }
    w("pow", rows)?;
    let mut rows = Vec::new();
    for _ in 0..n {
        let d = if g.rng.next_u32() & 1 == 0 {
            g.uniform(-45.0, 45.0)
        } else {
            g.uniform(-1e6, 1e6)
        };
        let (s, c) = det_math::sin_cos_deg(d);
        rows.push(vec![d, s, c]);
    }
    w("sin_cos_deg", rows)?;
    let mut rows = Vec::new();
    for _ in 0..n {
        let (y, x) = if g.rng.next_u32() & 1 == 0 {
            (g.uniform(-1.0, 1.0), g.uniform(-1.0, 1.0))
        } else {
            let y = g.slog(-300, 300);
            (y, g.slog(-300, 300))
        };
        let r = det_math::atan2_deg(y, x);
        if r.abs() >= 1e-290 {
            rows.push(vec![y, x, r]);
        }
    }
    w("atan2_deg", rows)?;
    let mut rows = Vec::new();
    for _ in 0..n {
        let x = g.finite_bits();
        rows.push(vec![x, det_math::cbrt(x)]);
    }
    w("cbrt", rows)?;
    Ok(())
}

fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--dump") {
        let dir = PathBuf::from(args.get(1).expect("--dump <dir> <n>"));
        let n: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(100_000);
        return dump(&dir, n);
    }
    let out = match args.first() {
        Some(d) => PathBuf::from(d),
        None => Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance/math"),
    };
    std::fs::create_dir_all(&out)?;
    for t in all_tables() {
        assert!(
            t.rows.len() >= 500,
            "{}: only {} vectors",
            t.function,
            t.rows.len()
        );
        std::fs::write(out.join(format!("{}.json", t.function)), t.to_json())?;
        println!("{:<16} {:>5} vectors", t.function, t.rows.len());
    }
    std::fs::write(out.join("pcg32.json"), pcg_json())?;
    println!("pcg32            4 x 1000 outputs");
    Ok(())
}
