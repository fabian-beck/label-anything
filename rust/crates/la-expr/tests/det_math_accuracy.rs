//! Accuracy of `det_math` against the platform functions (Rust `std`, i.e. the system
//! libm). Target: at most 2 ulp over the tested ranges. Run with `--nocapture` to see the
//! measured maxima; `LA_ACCURACY_SAMPLES=<n>` changes the sample count (default 200 000
//! per range).

use label_anything_expr::det_math::{self, Pcg32};

const MAX_ULP: u64 = 2;

fn samples() -> usize {
    std::env::var("LA_ACCURACY_SAMPLES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(200_000)
}

/// Distance in units in the last place (0 for equal values, ±0 count as equal).
fn ulp_diff(a: f64, b: f64) -> u64 {
    if a.is_nan() || b.is_nan() {
        return if a.is_nan() && b.is_nan() {
            0
        } else {
            u64::MAX
        };
    }
    let ord = |x: f64| -> i128 {
        let b = x.to_bits();
        if b >> 63 == 1 {
            -((b & 0x7fff_ffff_ffff_ffff) as i128)
        } else {
            b as i128
        }
    };
    (ord(a) - ord(b)).unsigned_abs() as u64
}

struct Stat {
    name: String,
    max: u64,
    worst: String,
    n: usize,
    off: usize,
}

impl Stat {
    fn new(name: &str) -> Self {
        Stat {
            name: name.to_string(),
            max: 0,
            worst: String::new(),
            n: 0,
            off: 0,
        }
    }
    fn add(&mut self, got: f64, want: f64, what: impl FnOnce() -> String) {
        let d = ulp_diff(got, want);
        self.n += 1;
        if d > 0 {
            self.off += 1;
        }
        if d > self.max {
            self.max = d;
            self.worst = format!("{} got {got:e} want {want:e}", what());
        }
    }
    fn report(&self) {
        eprintln!(
            "{:<34} n={:>8} differ={:>6.3}% max={} ulp  {}",
            self.name,
            self.n,
            100.0 * self.off as f64 / self.n.max(1) as f64,
            self.max,
            self.worst
        );
    }
    fn check(&self) {
        eprintln!(
            "{:<34} n={:>8} differ={:>6.3}% max={} ulp  {}",
            self.name,
            self.n,
            100.0 * self.off as f64 / self.n.max(1) as f64,
            self.max,
            self.worst
        );
        assert!(
            self.max <= MAX_ULP,
            "{}: {} ulp ({})",
            self.name,
            self.max,
            self.worst
        );
    }
}

fn rand_bits(rng: &mut Pcg32) -> f64 {
    let hi = rng.next_u32() as u64;
    let lo = rng.next_u32() as u64;
    f64::from_bits((hi << 32) | lo)
}

/// Log-uniform magnitude in [2^lo, 2^hi).
fn log_uniform(rng: &mut Pcg32, lo: f64, hi: f64) -> f64 {
    let e = lo + (hi - lo) * rng.next_f64();
    let m = 1.0 + rng.next_f64();
    m * 2f64.powf(e.floor()) // test-only use of std powf to build inputs
}

#[test]
fn ln_vs_std() {
    let n = samples();
    let mut rng = Pcg32::new(1);
    let mut all = Stat::new("ln, all positive doubles");
    let mut near1 = Stat::new("ln, [0.5, 2]");
    for _ in 0..n {
        let x = rand_bits(&mut rng).abs();
        if x.is_finite() && x > 0.0 {
            all.add(det_math::ln(x), x.ln(), || format!("ln({x:e})"));
        }
        let y = 0.5 + 1.5 * rng.next_f64();
        near1.add(det_math::ln(y), y.ln(), || format!("ln({y:e})"));
    }
    all.check();
    near1.check();
}

#[test]
fn ln_1p_vs_std() {
    let n = samples();
    let mut rng = Pcg32::new(2);
    let mut st = Stat::new("ln_1p, (-1, 1e300]");
    let mut small = Stat::new("ln_1p, |x| < 1");
    for _ in 0..n {
        let x = log_uniform(&mut rng, -60.0, 997.0);
        st.add(det_math::ln_1p(x), x.ln_1p(), || format!("ln_1p({x:e})"));
        let y = rng.next_f64() * 2.0 - 1.0;
        if y > -1.0 {
            small.add(det_math::ln_1p(y), y.ln_1p(), || format!("ln_1p({y:e})"));
        }
        let t = -log_uniform(&mut rng, -60.0, -0.0001);
        if t > -1.0 {
            small.add(det_math::ln_1p(t), t.ln_1p(), || format!("ln_1p({t:e})"));
        }
    }
    st.check();
    small.check();
}

#[test]
fn exp_vs_std() {
    let n = samples();
    let mut rng = Pcg32::new(3);
    let mut st = Stat::new("exp, [-745, 709.78]");
    let mut small = Stat::new("exp, |x| in [2^-60, 1]");
    for _ in 0..n {
        let x = -745.0 + (709.78 + 745.0) * rng.next_f64();
        st.add(det_math::exp(x), x.exp(), || format!("exp({x:e})"));
        let mut y = log_uniform(&mut rng, -60.0, 0.0);
        if rng.next_u32() & 1 == 1 {
            y = -y;
        }
        small.add(det_math::exp(y), y.exp(), || format!("exp({y:e})"));
    }
    st.check();
    small.check();
}

#[test]
fn pow_vs_std() {
    let n = samples();
    let mut rng = Pcg32::new(4);
    let mut real = Stat::new("pow, x in (2^-40, 2^40), |y| < 50");
    let mut int = Stat::new("pow, |x| < 1000, integer |y| <= 64");
    let mut near1 = Stat::new("pow, x near 1, |y| up to 1e12");
    for _ in 0..n {
        let x = log_uniform(&mut rng, -40.0, 40.0);
        let y = (rng.next_f64() - 0.5) * 100.0;
        let want = x.powf(y);
        if want.is_finite() && want != 0.0 {
            real.add(det_math::pow(x, y), want, || format!("pow({x:e}, {y:e})"));
        }
        let xi = (rng.next_f64() - 0.5) * 2000.0;
        let yi = rng.next_below(129) as f64 - 64.0;
        int.add(det_math::pow(xi, yi), xi.powf(yi), || {
            format!("pow({xi:e}, {yi})")
        });
        let x1 = 1.0 + (rng.next_f64() - 0.5) * 1e-9;
        let y1 = (rng.next_f64() - 0.5) * 2e12;
        let w1 = x1.powf(y1);
        if w1.is_finite() && w1 != 0.0 {
            near1.add(det_math::pow(x1, y1), w1, || format!("pow({x1:e}, {y1:e})"));
        }
    }
    real.check();
    int.check();
    near1.check();
}

/// Reference: the platform sin/cos of the exactly reduced angle, at the same
/// double-double radian argument as det_math (`sin(x) + cos(x)·xx`).
fn ref_sin_cos_deg(deg: f64) -> (f64, f64) {
    let r = deg % 360.0;
    let a = r.abs();
    let (t, q) = if a <= 45.0 {
        (a, 0)
    } else if a < 135.0 {
        (a - 90.0, 1)
    } else if a <= 225.0 {
        (a - 180.0, 2)
    } else if a < 315.0 {
        (a - 270.0, 3)
    } else {
        (a - 360.0, 0)
    };
    // t·π/180 as a double-double using the exact fused product for the error term.
    let c_hi = std::f64::consts::PI / 180.0;
    let c_lo = 2.9486522708701687e-19;
    let x = t * c_hi;
    let xx = t.mul_add(c_hi, -x) + t * c_lo;
    let (s, c) = (x.sin() + x.cos() * xx, x.cos() - x.sin() * xx);
    let (s, c) = match q {
        0 => (s, c),
        1 => (c, -s),
        2 => (-s, -c),
        _ => (-c, s),
    };
    (if r.is_sign_negative() { -s } else { s }, c)
}

#[test]
fn sin_cos_deg_vs_std() {
    let n = samples();
    let mut rng = Pcg32::new(5);
    let mut plain_s = Stat::new("sin_deg, [-45, 45] vs sin(to_radians)");
    let mut plain_c = Stat::new("cos_deg, [-45, 45] vs cos(to_radians)");
    let mut red_s = Stat::new("sin_deg, [-1e6, 1e6] (reduced ref)");
    let mut red_c = Stat::new("cos_deg, [-1e6, 1e6] (reduced ref)");
    for _ in 0..n {
        let d = (rng.next_f64() - 0.5) * 90.0;
        let (s, c) = det_math::sin_cos_deg(d);
        plain_s.add(s, d.to_radians().sin(), || format!("sin_deg({d:e})"));
        plain_c.add(c, d.to_radians().cos(), || format!("cos_deg({d:e})"));
        let e = (rng.next_f64() - 0.5) * 2e6;
        let (s, c) = det_math::sin_cos_deg(e);
        let (ws, wc) = ref_sin_cos_deg(e);
        red_s.add(s, ws, || format!("sin_deg({e:e})"));
        red_c.add(c, wc, || format!("cos_deg({e:e})"));
    }
    plain_s.check();
    plain_c.check();
    red_s.check();
    red_c.check();
}

/// Degrees → radians with a double-double π/180 and a single rounding.
fn to_radians_dd(deg: f64) -> f64 {
    let hi = std::f64::consts::PI / 180.0;
    let lo = 2.9486522708701687e-19;
    let p = deg * hi;
    p + (deg.mul_add(hi, -p) + deg * lo)
}

/// The platform atan2 works in radians; converting its result to degrees with the
/// rounded 180/π costs up to ~2.5 ulp on the platform side (checked with mpmath), so the
/// comparison is done in radians (det_math's degrees converted with one rounding).
#[test]
fn atan2_deg_vs_std() {
    let n = samples();
    let mut rng = Pcg32::new(6);
    let mut st = Stat::new("atan2_deg (in rad), unit square");
    let mut wide = Stat::new("atan2_deg (in rad), magnitudes 2^-500..2^500");
    let mut naive = Stat::new("atan2_deg vs atan2().to_degrees() (info)");
    for _ in 0..n {
        let y = (rng.next_f64() - 0.5) * 2.0;
        let x = (rng.next_f64() - 0.5) * 2.0;
        let got = det_math::atan2_deg(y, x);
        st.add(to_radians_dd(got), y.atan2(x), || {
            format!("atan2_deg({y:e}, {x:e})")
        });
        naive.add(got, y.atan2(x).to_degrees(), || {
            format!("atan2_deg({y:e}, {x:e})")
        });
        let mut yw = log_uniform(&mut rng, -500.0, 500.0);
        let mut xw = log_uniform(&mut rng, -500.0, 500.0);
        if rng.next_u32() & 1 == 1 {
            yw = -yw;
        }
        if rng.next_u32() & 1 == 1 {
            xw = -xw;
        }
        let want = yw.atan2(xw);
        if want.abs() > 1e-290 {
            wide.add(to_radians_dd(det_math::atan2_deg(yw, xw)), want, || {
                format!("atan2_deg({yw:e}, {xw:e})")
            });
        }
    }
    st.check();
    wide.check();
    naive.report();
}

#[test]
fn cbrt_vs_std() {
    let n = samples();
    let mut rng = Pcg32::new(7);
    let mut st = Stat::new("cbrt, all finite doubles");
    for _ in 0..n {
        let x = rand_bits(&mut rng);
        if x.is_finite() {
            st.add(det_math::cbrt(x), x.cbrt(), || format!("cbrt({x:e})"));
        }
    }
    st.check();
}
