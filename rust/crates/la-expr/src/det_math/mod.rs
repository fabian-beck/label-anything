//! Deterministic math shared bit for bit by the Rust and TypeScript implementations.
//!
//! Every function here is built from IEEE-754 binary64 `+ − × ÷` and `sqrt` (all
//! correctly rounded), exact operations (comparisons, sign changes, `%`/fmod, power-of-two
//! scaling through the exponent bits) and constant tables, evaluated in a fixed order.
//! No platform `libm` function is called, so results are identical on every platform and
//! in `ts/packages/core/src/detmath.ts`, which is a line-by-line port. Conformance vectors
//! with the exact output bits live in `conformance/math/`.
//!
//! Accuracy (measured against correctly rounded mpmath references on the conformance
//! inputs and on millions of random inputs against the platform functions; see
//! `conformance/math/README.md`):
//!
//! | function | max error vs. exact | method |
//! |---|---|---|
//! | [`ln`], [`ln_1p`] | 0.5000 | 47-entry table of ln(j/64) + atanh series, double-double |
//! | [`exp`] | 0.515 | Cody–Waite reduction, `1 + hi + r²/2` exact, Taylor tail |
//! | [`pow`] | 0.514 | `exp(y·ln x)` in double-double; integer `y` by double-double repeated squaring |
//! | [`sin_cos_deg`] | 0.533 | exact reduction in degrees, double-double radians, Taylor kernels |
//! | [`atan2_deg`] | 0.5004 | 9-point table of atan(j/8)° + Taylor series, double-double |
//! | [`cbrt`] | 0.5000 | cubic start, two Newton steps, exact-residual correction |
//! | [`floor`], [`ceil`], [`trunc`], [`round_half_away`] | exact | |
//!
//! NaN results are always the canonical quiet NaN (`f64::NAN`); conformance compares NaN
//! results by "is NaN" because some platforms canonicalize NaN payloads.

mod consts;
mod dd;
mod pcg;

pub use pcg::Pcg32;

use consts::*;
use dd::{dd_mul, dd_recip, dd_rsub, fast_two_sum, two_prod, two_sum};

/// Integer exponents up to this magnitude use exact repeated squaring in [`pow`].
const POWI_MAX: f64 = 1073741824.0; // 2^30

#[inline(always)]
fn hi_word(x: f64) -> u32 {
    (x.to_bits() >> 32) as u32
}

#[inline(always)]
fn lo_word(x: f64) -> u32 {
    x.to_bits() as u32
}

#[inline(always)]
fn from_words(hi: u32, lo: u32) -> f64 {
    f64::from_bits(((hi as u64) << 32) | lo as u64)
}

/// `c[0] + x·(c[1] + x·(… + x·c[n−1]))`, innermost first (the TS port loops identically).
#[inline(always)]
fn horner(x: f64, c: &[f64]) -> f64 {
    let Some((&last, rest)) = c.split_last() else {
        return 0.0;
    };
    let mut acc = last;
    for &k in rest.iter().rev() {
        acc = k + x * acc;
    }
    acc
}

/// Unbiased binary exponent of a finite, non-zero `x` (subnormals included).
#[inline]
fn ilogb(x: f64) -> i32 {
    let e = ((hi_word(x) >> 20) & 0x7ff) as i32;
    if e == 0 {
        (((hi_word(x * TWO54) >> 20) & 0x7ff) as i32) - 1077
    } else {
        e - 1023
    }
}

/// `x · 2^n` with a single rounding (only when the result is subnormal).
fn scalbn(x: f64, n: i32) -> f64 {
    let mut y = x;
    let mut n = n;
    if n > 1023 {
        y *= TWO1023;
        n -= 1023;
        if n > 1023 {
            y *= TWO1023;
            n -= 1023;
            if n > 1023 {
                n = 1023;
            }
        }
    } else if n < -1022 {
        // Keep the final factor ≥ 2^-1022 so that rounding happens only once.
        y *= TWO_M969;
        n += 969;
        if n < -1022 {
            y *= TWO_M969;
            n += 969;
            if n < -1022 {
                n = -1022;
            }
        }
    }
    y * from_words(((0x3ff + n) as u32) << 20, 0)
}

// ------------------------------------------------------------------------------------
// Rounding
// ------------------------------------------------------------------------------------

/// Rounds toward zero. Exact; `trunc(-0.5) = -0`.
pub fn trunc(x: f64) -> f64 {
    let ax = x.abs();
    if ax.is_nan() || ax >= TWO52 {
        // Already an integer, ±inf or NaN.
        return if x.is_nan() { f64::NAN } else { x };
    }
    let mut r = (ax + TWO52) - TWO52; // nearest integer (ties to even)
    if r > ax {
        r -= 1.0;
    }
    if x.is_sign_negative() {
        -r
    } else {
        r
    }
}

/// Largest integer ≤ `x`. Exact; `floor(-0) = -0`.
pub fn floor(x: f64) -> f64 {
    let t = trunc(x);
    if t > x {
        t - 1.0
    } else {
        t
    }
}

/// Smallest integer ≥ `x`. Exact; `ceil(-0.5) = -0`.
pub fn ceil(x: f64) -> f64 {
    let t = trunc(x);
    if t < x {
        t + 1.0
    } else {
        t
    }
}

/// Nearest integer, halves rounded away from zero (C `round`, not JS `Math.round`).
/// Exact; `round_half_away(0.49999999999999994) = 0`, `round_half_away(-2.5) = -3`,
/// `round_half_away(-0.4) = -0`.
pub fn round_half_away(x: f64) -> f64 {
    let ax = x.abs();
    if ax.is_nan() || ax >= TWO52 {
        return if x.is_nan() { f64::NAN } else { x };
    }
    let t = trunc(ax);
    let r = if ax - t >= 0.5 { t + 1.0 } else { t };
    if x.is_sign_negative() {
        -r
    } else {
        r
    }
}

/// IEEE-754 square root (correctly rounded; listed for completeness).
#[inline]
pub fn sqrt(x: f64) -> f64 {
    x.sqrt()
}

// ------------------------------------------------------------------------------------
// Logarithms
// ------------------------------------------------------------------------------------

/// `ln(x)` as a normalized double-double for finite `x > 0`; relative error < 2^-74.
fn ln_dd(x: f64) -> (f64, f64) {
    let mut x = x;
    let mut k: i32 = 0;
    if x < f64::MIN_POSITIVE {
        x *= TWO54;
        k = -54;
    }
    let hx = hi_word(x);
    k += ((hx >> 20) as i32) - 1023;
    // x = 2^k · m, m in [sqrt(1/2), sqrt(2))
    let mut m = from_words((hx & 0x000f_ffff) | 0x3ff0_0000, lo_word(x));
    if m > SQRT2 {
        m *= 0.5;
        k += 1;
    }
    // m = c · (1 + s) / (1 - s) with c = j/64 nearest to m, |s| < 2^-7.4
    let j = (m * 64.0 + 0.5) as usize;
    let c = j as f64 * 0.015625;
    let d = m - c; // exact (Sterbenz)
    let (ah, al) = two_sum(m, c);
    let sh = d / ah;
    let (p, pe) = two_prod(sh, ah);
    let sl = (((d - p) - pe) - sh * al) / ah;
    // ln(m/c) = 2·atanh(s) = 2s + 2s³/3 + 2s⁵/5 + …
    let z = sh * sh;
    let tail = sh * z * horner(z, &LN_POLY);
    let kf = k as f64;
    let i = j - LN_TAB_J0;
    let (h1, e1) = two_sum(kf * LN2_HI, LN_TAB_HI[i]);
    let (h2, e2) = two_sum(h1, 2.0 * sh);
    let lo = (e1 + e2) + (((kf * LN2_LO + LN_TAB_LO[i]) + 2.0 * sl) + tail);
    fast_two_sum(h2, lo)
}

/// Natural logarithm.
///
/// `ln(+inf) = +inf`, `ln(±0) = -inf`, `ln(x < 0) = NaN`, `ln(NaN) = NaN`.
/// Max error 0.5000 ulp (measured; nearly correctly rounded).
pub fn ln(x: f64) -> f64 {
    if x > 0.0 {
        if x == f64::INFINITY {
            return x;
        }
        return ln_dd(x).0;
    }
    if x == 0.0 {
        f64::NEG_INFINITY
    } else {
        f64::NAN
    }
}

/// `ln(1 + x)`, accurate also for tiny `x`.
///
/// `ln_1p(-1) = -inf`, `ln_1p(x < -1) = NaN`, `ln_1p(+inf) = +inf`, `ln_1p(±0) = ±0`.
/// Max error 0.5000 ulp (measured).
pub fn ln_1p(x: f64) -> f64 {
    if x > -1.0 {
        if x == f64::INFINITY {
            return x;
        }
        let ax = x.abs();
        if ax < TWO_M54 {
            return x;
        }
        if ax < TWO_M20 {
            // x − x²/2 + x³/3 − x⁴/4 (+ O(2^-80·x)): one rounding of x + tiny.
            return x + x * x * horner(x, &LN1P_POLY);
        }
        // 1 + x = u + c exactly; ln(1 + x) = ln(u) + ln(1 + c/u) ≈ ln(u) + c/u.
        let (u, c) = two_sum(1.0, x);
        let (h, l) = ln_dd(u);
        return h + (l + c / u);
    }
    if x == -1.0 {
        f64::NEG_INFINITY
    } else {
        f64::NAN
    }
}

// ------------------------------------------------------------------------------------
// Exponential and power
// ------------------------------------------------------------------------------------

/// `e^(x + xt)` for `EXP_UNDERFLOW ≤ x ≤ EXP_OVERFLOW` and a tail `|xt| ≤ 2^-40 |x|`.
fn exp_core(x: f64, xt: f64) -> f64 {
    if x.abs() < TWO_M54 {
        return 1.0 + x;
    }
    // x + xt = k·ln2 + (hi − lo), |hi − lo| ≤ ln2/2 (+ rounding)
    let k = floor(x * INV_LN2 + 0.5);
    let hi = x - k * LN2_HI; // exact
    let lo = k * LN2_LO - xt;
    let (r, rl) = two_sum(hi, -lo); // r + rl = hi − lo exactly
                                    // e^r = (1 + hi) − lo + r²/2 + r³·(1/3! + r/4! + … + r^12/15!)
    let (q, qe) = two_prod(r, r);
    let qe = qe + 2.0 * r * rl; // q + qe = (r + rl)²
    let (s, se) = fast_two_sum(1.0, hi);
    let (s2, s2e) = fast_two_sum(s, 0.5 * q);
    let p = r * q * horner(r, &EXP_POLY);
    let y = s2 + (((se + s2e) + (0.5 * qe - lo)) + p);
    scalbn(y, k as i32)
}

/// `e^x`. Overflow gives `+inf`, underflow `+0` (gradual underflow for subnormal
/// results); `exp(-inf) = +0`, `exp(+inf) = +inf`, `exp(NaN) = NaN`.
/// Max error 0.515 ulp (measured).
pub fn exp(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    if x > EXP_OVERFLOW {
        return f64::INFINITY;
    }
    if x < EXP_UNDERFLOW {
        return 0.0;
    }
    exp_core(x, 0.0)
}

/// Keeps a double-double mantissa in `[1, 2)`, moving powers of two into `e` (exact).
#[inline]
fn renorm(h: &mut f64, l: &mut f64, e: &mut i64) {
    while *h >= 2.0 {
        *h *= 0.5;
        *l *= 0.5;
        *e += 1;
    }
    while *h < 1.0 {
        *h *= 2.0;
        *l *= 2.0;
        *e -= 1;
    }
}

/// `ax^n` for finite `ax > 0` and `1 ≤ |n| ≤ 2^30` by repeated squaring in
/// double-double with a separate integer exponent (no intermediate overflow).
fn powi(ax: f64, n: i64) -> f64 {
    let e = ilogb(ax);
    let (mut bh, mut bl, mut be) = (scalbn(ax, -e), 0.0, e as i64);
    let (mut rh, mut rl, mut re) = (1.0, 0.0, 0i64);
    let mut k = n.unsigned_abs();
    loop {
        if k & 1 == 1 {
            let (h, l) = dd_mul(rh, rl, bh, bl);
            rh = h;
            rl = l;
            re += be;
            renorm(&mut rh, &mut rl, &mut re);
        }
        k >>= 1;
        if k == 0 {
            break;
        }
        let (h, l) = dd_mul(bh, bl, bh, bl);
        bh = h;
        bl = l;
        be *= 2;
        renorm(&mut bh, &mut bl, &mut be);
    }
    if n < 0 {
        let (h, l) = dd_recip(rh, rl);
        rh = h;
        rl = l;
        re = -re;
        renorm(&mut rh, &mut rl, &mut re);
    }
    if re > 2100 {
        return f64::INFINITY;
    }
    if re < -2200 {
        return 0.0;
    }
    scalbn(rh + rl, re as i32)
}

/// `ax^y = e^(y·ln ax)` for finite `ax > 0`, finite `y`, in double-double.
fn pow_pos(ax: f64, y: f64) -> f64 {
    let (lh, ll) = ln_dd(ax);
    let t = y * lh;
    if t > EXP_OVERFLOW {
        return f64::INFINITY;
    }
    if t < EXP_UNDERFLOW {
        return 0.0;
    }
    let (p, pe) = two_prod(y, lh);
    let (th, tl) = fast_two_sum(p, pe + y * ll);
    exp_core(th, tl)
}

/// `x^y` with the special cases of C99 Annex F / IEEE 754 `pow`:
///
/// * `pow(x, ±0) = 1` for any `x` (even NaN); `pow(1, y) = 1` for any `y` (even NaN);
/// * otherwise NaN if `x` or `y` is NaN;
/// * `pow(-1, ±inf) = 1`; `pow(x, +inf)` = `+inf` for `|x| > 1`, `+0` for `|x| < 1`;
///   `pow(x, -inf)` = `+0` for `|x| > 1`, `+inf` for `|x| < 1`;
/// * `pow(±0, y)`: `y` odd integer < 0 → `±inf`; other `y < 0` → `+inf`;
///   `y` odd integer > 0 → `±0`; other `y > 0` → `+0`;
/// * `pow(-inf, y)`: `y` odd integer → `-0` (y < 0) / `-inf` (y > 0); other → `+0` / `+inf`;
///   `pow(+inf, y)` = `+0` for `y < 0`, `+inf` for `y > 0`;
/// * finite `x < 0` and finite non-integer `y` → NaN.
///
/// Integer `y` with `|y| ≤ 2^30` is computed by double-double repeated squaring (so
/// negative bases work and `pow(x, 2) = x·x`); all other cases as `e^(y·ln|x|)` with
/// the logarithm and the product in double-double, the sign taken from the parity of
/// `y`. Max error 0.514 ulp (measured); results in the subnormal
/// range may be off by one more ulp (double rounding).
pub fn pow(x: f64, y: f64) -> f64 {
    if y == 0.0 || x == 1.0 {
        return 1.0;
    }
    if x.is_nan() || y.is_nan() {
        return f64::NAN;
    }
    let ax = x.abs();
    if y.is_infinite() {
        if ax == 1.0 {
            return 1.0;
        }
        return if (ax > 1.0) == (y > 0.0) {
            f64::INFINITY
        } else {
            0.0
        };
    }
    let y_int = floor(y) == y;
    let y_odd = y_int && y.abs() < TWO53 && floor(y * 0.5) != y * 0.5;
    let neg = x.is_sign_negative() && y_odd;
    if ax == 0.0 || ax == f64::INFINITY {
        let r = if (ax == 0.0) == (y < 0.0) {
            f64::INFINITY
        } else {
            0.0
        };
        return if neg { -r } else { r };
    }
    if x < 0.0 && !y_int {
        return f64::NAN;
    }
    let r = if y_int && y.abs() <= POWI_MAX {
        powi(ax, y as i64)
    } else {
        pow_pos(ax, y)
    };
    if neg {
        -r
    } else {
        r
    }
}

/// Cube root. `cbrt(±0) = ±0`, `cbrt(±inf) = ±inf`, `cbrt(NaN) = NaN`; odd:
/// `cbrt(-x) = -cbrt(x)`. Max error 0.5000 ulp (measured; exact for exact cubes).
pub fn cbrt(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    if x == 0.0 || x.is_infinite() {
        return x;
    }
    let ax = x.abs();
    let e = ilogb(ax);
    let m = scalbn(ax, -e); // [1, 2), exact
    let q = e.div_euclid(3);
    let r = e - 3 * q;
    let t0 = horner(m, &CBRT_POLY);
    let (u, mut t) = match r {
        0 => (m, t0),
        1 => (2.0 * m, t0 * CBRT2),
        _ => (4.0 * m, t0 * CBRT4),
    };
    // Newton: relative error 1e-4 → 1e-8 → 1e-16
    t = (2.0 * t + u / (t * t)) / 3.0;
    t = (2.0 * t + u / (t * t)) / 3.0;
    // One more Newton step with the residual t³ − u computed exactly.
    let (t2, t2e) = two_prod(t, t);
    let (t3, t3e) = two_prod(t2, t);
    let res = (t3 - u) + (t3e + t2e * t);
    t -= res / (3.0 * t2);
    let v = scalbn(t, q);
    if x < 0.0 {
        -v
    } else {
        v
    }
}

// ------------------------------------------------------------------------------------
// Trigonometry in degrees
// ------------------------------------------------------------------------------------

/// `(sin t°, cos t°)` for `|t| ≤ 45`.
fn sc_kernel(t: f64) -> (f64, f64) {
    let at = t.abs();
    if at == 45.0 {
        return (if t < 0.0 { -SQRT_HALF } else { SQRT_HALF }, SQRT_HALF);
    }
    if at == 30.0 {
        return (if t < 0.0 { -0.5 } else { 0.5 }, SQRT_3_4);
    }
    // x + xx = t·π/180 (double-double), |x| ≤ π/4
    let (p, pe) = two_prod(t, D2R_HI);
    let (x, xx) = fast_two_sum(p, pe + t * D2R_LO);
    let (z, ze) = two_prod(x, x);
    // sin(x + xx) = x − x³/6 + x⁵·SIN_POLY(x²) + xx·(1 − x²/2)
    let (v, ve) = two_prod(z, x);
    let ve = ve + ze * x;
    let q = v / 6.0;
    let (p6, p6e) = two_prod(q, 6.0);
    let ql = (((v - p6) - p6e) + ve) / 6.0;
    let rs = horner(z, &SIN_POLY);
    let (s1, s1e) = fast_two_sum(x, -q);
    let s = s1 + (s1e + ((v * z * rs - ql) + xx * (1.0 - 0.5 * z)));
    // cos(x + xx) = 1 − (z + ze)/2 + z²·COS_POLY(z) + z·ze/12 − sin(x)·xx
    let hz = 0.5 * z;
    let w = 1.0 - hz;
    let rc = horner(z, &COS_POLY);
    let c = w + ((((1.0 - w) - hz) - 0.5 * ze) + ((z * z) * rc + (z * ze * COS_C1X2 - s1 * xx)));
    (s, c)
}

/// `(sin deg°, cos deg°)` for an angle in degrees.
///
/// The angle is reduced exactly in degrees (`deg % 360`, then to `[-45°, 45°]`), and
/// only then converted to radians with the double-double constant π/180. Results are
/// exact at multiples of 30° and 45°: `sin_cos_deg(90) = (1, 0)`,
/// `sin_cos_deg(45) = (√½, √½)` with `√½ = sqrt(0.5)`, `sin_cos_deg(30) = (0.5, sqrt(0.75))`.
/// Zeros: `cos` is never `-0`; `sin(±0) = ±0` and `sin(k·180°)` is `+0` for `k > 0` and
/// `-0` for `k < 0` (as IEEE `sinPi`). Non-finite input gives `(NaN, NaN)`.
/// Max error 0.533 ulp (measured).
pub fn sin_cos_deg(deg: f64) -> (f64, f64) {
    if !deg.is_finite() {
        return (f64::NAN, f64::NAN);
    }
    let r = deg % 360.0; // exact, sign of deg
    let a = r.abs();
    let (s, c) = if a <= 45.0 {
        sc_kernel(a)
    } else if a < 135.0 {
        let (s, c) = sc_kernel(a - 90.0);
        (c, -s)
    } else if a <= 225.0 {
        let (s, c) = sc_kernel(a - 180.0);
        (-s, -c)
    } else if a < 315.0 {
        let (s, c) = sc_kernel(a - 270.0);
        (-c, s)
    } else {
        sc_kernel(a - 360.0)
    };
    let s = if s == 0.0 { 0.0 } else { s };
    let c = if c == 0.0 { 0.0 } else { c };
    (if r.is_sign_negative() { -s } else { s }, c)
}

/// `sin(deg°)`, identical to `sin_cos_deg(deg).0`.
#[inline]
pub fn sin_deg(deg: f64) -> f64 {
    sin_cos_deg(deg).0
}

/// `cos(deg°)`, identical to `sin_cos_deg(deg).1`.
#[inline]
pub fn cos_deg(deg: f64) -> f64 {
    sin_cos_deg(deg).1
}

/// `atan(n/d)` in degrees as a double-double, for finite `0 < n < d`.
fn atan_ratio_deg(n: f64, d: f64) -> (f64, f64) {
    let ed = ilogb(d);
    let en = ilogb(n);
    if ed - en > 900 {
        // q = n/d < 2^-899, atan(q) = q to full precision: q·180/π with both mantissas
        // scaled to [1, 2) so that nothing is lost before the final scaling.
        let n1 = scalbn(n, -en);
        let d1 = scalbn(d, -ed);
        let q = n1 / d1;
        let (p, pe) = two_prod(q, d1);
        let ql = ((n1 - p) - pe) / d1;
        let (rp, rpe) = two_prod(q, R2D_HI);
        let v = rp + (rpe + (q * R2D_LO + ql * R2D_HI));
        return (scalbn(v, en - ed), 0.0);
    }
    let n1 = scalbn(n, -ed); // exact
    let d1 = scalbn(d, -ed); // [1, 2)
    let q = n1 / d1;
    let (p, pe) = two_prod(q, d1);
    let ql = ((n1 - p) - pe) / d1; // q + ql = n/d
                                   // atan(q) = atan(c) + atan(w), c = j/8, w = (q − c)/(1 + q·c), |w| ≤ 1/16
    let j = (q * 8.0 + 0.5) as usize;
    let c = j as f64 * 0.125;
    let (cp, cpe) = two_prod(q, c);
    let (dh, dl) = two_sum(1.0, cp);
    let dl = dl + (cpe + ql * c);
    let num = q - c; // exact
    let wh = num / dh;
    let (p3, p3e) = two_prod(wh, dh);
    let wl = ((((num - p3) - p3e) + ql) - wh * dl) / dh;
    let zz = wh * wh;
    let poly = wh * zz * horner(zz, &ATAN_POLY);
    let t = wl + poly;
    // degrees: (wh + t)·(R2D_HI + R2D_LO) + atan(c)°
    let (rp, rpe) = two_prod(wh, R2D_HI);
    let rlo = rpe + (wh * R2D_LO + t * R2D_HI);
    let (s, se) = two_sum(ATAN_TAB_HI[j], rp);
    fast_two_sum(s, se + (ATAN_TAB_LO[j] + rlo))
}

/// Angle of the vector `(x, y)` in degrees, in `[-180, 180]`, with the special cases of
/// C99 `atan2` (signed zeros, infinities): `atan2_deg(±0, +0) = ±0`,
/// `atan2_deg(±0, -0) = ±180`, `atan2_deg(±0, x<0) = ±180`, `atan2_deg(y>0, ±0) = 90`,
/// `atan2_deg(±inf, +inf) = ±45`, `atan2_deg(±inf, -inf) = ±135`, NaN in → NaN out.
/// Exact for `|y| = |x|` (±45°, ±135°) and on the axes. Max error 0.5004 ulp
/// (results below 1e-269° may be off by one more ulp).
pub fn atan2_deg(y: f64, x: f64) -> f64 {
    if x.is_nan() || y.is_nan() {
        return f64::NAN;
    }
    let nx = x.is_sign_negative();
    let ay = y.abs();
    let ax = x.abs();
    let mag = if ay == 0.0 {
        if nx {
            180.0
        } else {
            0.0
        }
    } else if ax == 0.0 || (ay == f64::INFINITY && ax < f64::INFINITY) {
        90.0
    } else if ax == f64::INFINITY {
        match (ay == f64::INFINITY, nx) {
            (true, false) => 45.0,
            (true, true) => 135.0,
            (false, false) => 0.0,
            (false, true) => 180.0,
        }
    } else {
        let (h, l) = if ay == ax {
            (45.0, 0.0)
        } else if ay < ax {
            atan_ratio_deg(ay, ax)
        } else {
            let (h, l) = atan_ratio_deg(ax, ay);
            dd_rsub(90.0, h, l)
        };
        let (h, l) = if nx { dd_rsub(180.0, h, l) } else { (h, l) };
        h + l
    };
    if y.is_sign_negative() {
        -mag
    } else {
        mag
    }
}

#[cfg(test)]
mod tests;
