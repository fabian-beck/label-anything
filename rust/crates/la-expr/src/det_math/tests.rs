//! Unit tests: special values, exact cases and helper invariants. Accuracy against the
//! platform `libm` is tested in `tests/det_math_accuracy.rs`, bit parity with the
//! TypeScript port in `tests/conformance_math.rs`.

use super::*;

fn bits(x: f64) -> u64 {
    x.to_bits()
}

fn same(a: f64, b: f64) -> bool {
    (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits()
}

#[test]
fn constants_have_the_documented_bits() {
    assert_eq!(bits(SQRT2), 0x3ff6a09e667f3bcd);
    assert_eq!(bits(SQRT_HALF), 0.5f64.sqrt().to_bits());
    assert_eq!(bits(SQRT_3_4), 0.75f64.sqrt().to_bits());
    assert_eq!(bits(TWO_M54), 0x3c90000000000000);
    assert_eq!(bits(TWO1023), 0x7fe0000000000000);
    assert_eq!(bits(TWO_M969), 0x0360000000000000);
    assert_eq!(LN2_HI + LN2_LO, std::f64::consts::LN_2);
    assert_eq!(D2R_HI, std::f64::consts::PI / 180.0);
    assert_eq!(R2D_HI, 180.0 / std::f64::consts::PI);
    for k in 1..2048 {
        // k·LN2_HI must be exact: LN2_HI has 32 significant bits.
        let (p, e) = dd::two_prod(k as f64, LN2_HI);
        assert_eq!(e, 0.0, "k = {k}, p = {p}");
    }
}

#[test]
fn error_free_transformations() {
    let (p, e) = dd::two_prod(0.1, 0.3);
    assert_eq!(p, 0.1 * 0.3);
    assert_eq!(e, 0.1f64.mul_add(0.3, -p)); // exact error of the product
    let (s, e) = dd::two_sum(1.0, 1e-30);
    assert_eq!((s, e), (1.0, 1e-30));
    let (s, e) = dd::two_sum(1e-30, 1.0);
    assert_eq!((s, e), (1.0, 1e-30));
}

#[test]
fn rounding_functions_match_std_exactly() {
    let specials = [
        0.0,
        -0.0,
        0.5,
        -0.5,
        0.49999999999999994,
        -0.49999999999999994,
        1.5,
        2.5,
        -2.5,
        4503599627370495.5,
        -4503599627370495.5,
        4503599627370496.0,
        9007199254740993.0,
        1e300,
        f64::MIN_POSITIVE,
        5e-324,
        -5e-324,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::MAX,
    ];
    let mut rng = Pcg32::new(7);
    let mut xs: Vec<f64> = specials.to_vec();
    for _ in 0..200_000 {
        let hi = rng.next_u32() as u64;
        let lo = rng.next_u32() as u64;
        let x = f64::from_bits((hi << 32) | lo);
        if !x.is_nan() {
            xs.push(x);
        }
        let k = rng.next_below(2000) as f64 * 0.25 - 250.0;
        xs.push(k);
        xs.push(k + rng.next_f64() * 0.001);
    }
    for &x in &xs {
        assert!(same(floor(x), x.floor()), "floor({x:e})");
        assert!(same(ceil(x), x.ceil()), "ceil({x:e})");
        assert!(same(trunc(x), x.trunc()), "trunc({x:e})");
        assert!(same(round_half_away(x), x.round()), "round({x:e})");
    }
    assert!(floor(f64::NAN).is_nan() && round_half_away(f64::NAN).is_nan());
}

#[test]
fn ln_special_values() {
    assert_eq!(ln(1.0).to_bits(), 0);
    assert_eq!(ln(0.0), f64::NEG_INFINITY);
    assert_eq!(ln(-0.0), f64::NEG_INFINITY);
    assert!(ln(-1.0).is_nan());
    assert!(ln(f64::NAN).is_nan());
    assert!(ln(f64::NEG_INFINITY).is_nan());
    assert_eq!(ln(f64::INFINITY), f64::INFINITY);
    assert_eq!(ln(std::f64::consts::E), 1.0);
    assert_eq!(ln(2.0), std::f64::consts::LN_2);
    assert_eq!(ln(10.0), std::f64::consts::LN_10);
    assert_eq!(ln(5e-324), -744.4400719213812);
    assert_eq!(ln(f64::MAX), 709.782712893384);
}

#[test]
fn ln_1p_special_values() {
    assert_eq!(ln_1p(0.0).to_bits(), 0);
    assert_eq!(ln_1p(-0.0).to_bits(), (-0.0f64).to_bits());
    assert_eq!(ln_1p(-1.0), f64::NEG_INFINITY);
    assert!(ln_1p(-1.5).is_nan());
    assert!(ln_1p(f64::NAN).is_nan());
    assert_eq!(ln_1p(f64::INFINITY), f64::INFINITY);
    assert_eq!(ln_1p(1e-300), 1e-300);
    assert_eq!(ln_1p(5e-324), 5e-324);
    assert_eq!(ln_1p(1.0), std::f64::consts::LN_2);
    assert_eq!(ln_1p(f64::MAX), 709.782712893384);
}

#[test]
fn exp_special_values() {
    assert_eq!(exp(0.0), 1.0);
    assert_eq!(exp(-0.0), 1.0);
    assert_eq!(exp(1.0), std::f64::consts::E);
    assert_eq!(exp(f64::INFINITY), f64::INFINITY);
    assert_eq!(exp(f64::NEG_INFINITY).to_bits(), 0);
    assert!(exp(f64::NAN).is_nan());
    assert_eq!(exp(709.78), 1.7928227943945155e308);
    assert_eq!(exp(709.8), f64::INFINITY);
    assert_eq!(exp(-745.0), 5e-324);
    assert_eq!(exp(-745.2).to_bits(), 0);
    assert_eq!(exp(-708.0), (-708.0f64).exp());
    assert_eq!(exp(std::f64::consts::LN_2), 2.0);
}

#[test]
fn pow_special_values() {
    let inf = f64::INFINITY;
    let nan = f64::NAN;
    let cases: &[(f64, f64, f64)] = &[
        (nan, 0.0, 1.0),
        (nan, -0.0, 1.0),
        (1.0, nan, 1.0),
        (1.0, inf, 1.0),
        (-1.0, inf, 1.0),
        (-1.0, -inf, 1.0),
        (2.0, nan, nan),
        (nan, 2.0, nan),
        (0.5, inf, 0.0),
        (0.5, -inf, inf),
        (2.0, inf, inf),
        (2.0, -inf, 0.0),
        (-0.5, inf, 0.0),
        (-2.0, -inf, 0.0),
        (0.0, -3.0, inf),
        (-0.0, -3.0, -inf),
        (-0.0, -2.0, inf),
        (-0.0, -0.5, inf),
        (0.0, 3.0, 0.0),
        (-0.0, 3.0, -0.0),
        (-0.0, 2.0, 0.0),
        (-0.0, 0.5, 0.0),
        (inf, -1.0, 0.0),
        (inf, 0.5, inf),
        (-inf, -3.0, -0.0),
        (-inf, -2.0, 0.0),
        (-inf, 3.0, -inf),
        (-inf, 2.0, inf),
        (-inf, 0.5, inf),
        (-2.0, 0.5, nan),
        (-8.0, 1.0 / 3.0, nan),
        (-2.0, 3.0, -8.0),
        (-2.0, -3.0, -0.125),
        (-2.0, 2.0, 4.0),
        (2.0, 10.0, 1024.0),
        (10.0, 22.0, 1e22),
        (3.0, 20.0, 3486784401.0),
        (2.0, -1074.0, 5e-324),
        (2.0, 1024.0, inf),
        (2.0, -1075.0, 0.0),
        (4.0, 0.5, 2.0),
        (2.0, 0.5, std::f64::consts::SQRT_2),
        (-1.0, 1e300, 1.0),
        (-1.0, 3.0, -1.0),
        (-1.0, 9007199254740993.0, 1.0),
        (1e300, 1e300, inf),
        (1e-300, 1e300, 0.0),
    ];
    for &(x, y, want) in cases {
        let got = pow(x, y);
        assert!(
            same(got, want),
            "pow({x:e}, {y:e}) = {got:e}, want {want:e}"
        );
    }
    // Integer powers by exact repeated squaring.
    for i in 1..200 {
        let x = 1.0 + i as f64 / 128.0;
        assert_eq!(pow(x, 2.0), x * x);
        assert_eq!(pow(x, -1.0), 1.0 / x);
        assert_eq!(pow(x, 1.0), x);
    }
}

#[test]
fn sin_cos_deg_exact_values() {
    let h = SQRT_HALF;
    let s3 = SQRT_3_4;
    let cases: &[(f64, f64, f64)] = &[
        (0.0, 0.0, 1.0),
        (30.0, 0.5, s3),
        (45.0, h, h),
        (60.0, s3, 0.5),
        (90.0, 1.0, 0.0),
        (120.0, s3, -0.5),
        (135.0, h, -h),
        (150.0, 0.5, -s3),
        (180.0, 0.0, -1.0),
        (210.0, -0.5, -s3),
        (225.0, -h, -h),
        (270.0, -1.0, 0.0),
        (315.0, -h, h),
        (360.0, 0.0, 1.0),
        (-90.0, -1.0, 0.0),
        (-180.0, -0.0, -1.0),
        (-360.0, -0.0, 1.0),
        (-0.0, -0.0, 1.0),
        (720.0, 0.0, 1.0),
        (
            1e22,
            sin_cos_deg(1e22 % 360.0).0,
            sin_cos_deg(1e22 % 360.0).1,
        ),
    ];
    for &(d, s, c) in cases {
        let (gs, gc) = sin_cos_deg(d);
        assert!(
            same(gs, s) && same(gc, c),
            "sin_cos_deg({d}) = ({gs:e}, {gc:e})"
        );
        assert!(same(sin_deg(d), s) && same(cos_deg(d), c));
    }
    let (s, c) = sin_cos_deg(f64::INFINITY);
    assert!(s.is_nan() && c.is_nan());
    let (s, c) = sin_cos_deg(f64::NAN);
    assert!(s.is_nan() && c.is_nan());
    // Odd/even symmetry holds exactly.
    let mut rng = Pcg32::new(3);
    for _ in 0..10_000 {
        let d = (rng.next_f64() - 0.5) * 2000.0;
        let (s1, c1) = sin_cos_deg(d);
        let (s2, c2) = sin_cos_deg(-d);
        assert!(same(s1, -s2) && same(c1, c2), "symmetry at {d}");
    }
}

#[test]
fn atan2_deg_special_values() {
    let inf = f64::INFINITY;
    let cases: &[(f64, f64, f64)] = &[
        (0.0, 0.0, 0.0),
        (-0.0, 0.0, -0.0),
        (0.0, -0.0, 180.0),
        (-0.0, -0.0, -180.0),
        (0.0, -1.0, 180.0),
        (-0.0, -1.0, -180.0),
        (0.0, 1.0, 0.0),
        (-0.0, 1.0, -0.0),
        (1.0, 0.0, 90.0),
        (1.0, -0.0, 90.0),
        (-1.0, 0.0, -90.0),
        (inf, 1.0, 90.0),
        (-inf, -1.0, -90.0),
        (1.0, inf, 0.0),
        (-1.0, inf, -0.0),
        (1.0, -inf, 180.0),
        (-1.0, -inf, -180.0),
        (inf, inf, 45.0),
        (-inf, inf, -45.0),
        (inf, -inf, 135.0),
        (-inf, -inf, -135.0),
        (1.0, 1.0, 45.0),
        (-3.5, 3.5, -45.0),
        (2.0, -2.0, 135.0),
        (-1e-300, -1e-300, -135.0),
        (f64::MAX, f64::MAX, 45.0),
        (5e-324, 5e-324, 45.0),
        (1.0, 1e308, 5.729577951308232e-307),
    ];
    for &(y, x, want) in cases {
        let got = atan2_deg(y, x);
        assert!(
            same(got, want),
            "atan2_deg({y:e}, {x:e}) = {got:e}, want {want:e}"
        );
    }
    assert!(atan2_deg(f64::NAN, 1.0).is_nan());
    assert!(atan2_deg(1.0, f64::NAN).is_nan());
}

#[test]
fn cbrt_special_values() {
    assert_eq!(cbrt(0.0).to_bits(), 0);
    assert_eq!(cbrt(-0.0).to_bits(), (-0.0f64).to_bits());
    assert_eq!(cbrt(f64::INFINITY), f64::INFINITY);
    assert_eq!(cbrt(f64::NEG_INFINITY), f64::NEG_INFINITY);
    assert!(cbrt(f64::NAN).is_nan());
    for i in 1..2000 {
        let k = i as f64;
        assert_eq!(cbrt(k * k * k), k);
        assert_eq!(cbrt(-(k * k * k)), -k);
    }
    assert_eq!(cbrt(0.125), 0.5);
    assert_eq!(cbrt(5e-324), (5e-324f64).cbrt());
    assert_eq!(cbrt(f64::MAX), f64::MAX.cbrt());
}

#[test]
fn scalbn_and_ilogb() {
    assert_eq!(scalbn(1.0, 1023), TWO1023);
    assert_eq!(scalbn(1.0, 1024), f64::INFINITY);
    assert_eq!(scalbn(1.0, -1074), 5e-324);
    assert_eq!(scalbn(1.0, -1075).to_bits(), 0);
    assert_eq!(scalbn(1.5, -1075), 5e-324);
    assert_eq!(
        scalbn(f64::MAX, -2046),
        scalbn(f64::MAX, -1023) * 2f64.powi(-1023)
    );
    assert_eq!(scalbn(5e-324, 1074), 1.0);
    assert_eq!(ilogb(1.0), 0);
    assert_eq!(ilogb(5e-324), -1074);
    assert_eq!(ilogb(f64::MIN_POSITIVE), -1022);
    assert_eq!(ilogb(f64::MAX), 1023);
    assert_eq!(ilogb(-0.75), -1);
}
