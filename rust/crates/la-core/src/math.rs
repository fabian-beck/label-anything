//! Deterministic math helpers.
//!
//! All float code in the engine uses only `+ - * /`, `sqrt` and the functions in this
//! module, so that the Rust and TypeScript implementations agree bit for bit
//! (ADR solver/determinism). The transcendental functions are provided by `la_expr::det_math`.

pub use la_expr::det_math::{cbrt, exp, ln, ln_1p, round_half_away, sin_cos_deg};

/// `x.floor()` without a libm call (`f64::floor` is a function call on baseline x86-64,
/// which lacks SSE4.1). Exact for |x| < 2^63; NaN maps to 0.
#[inline]
pub fn floor_fast(x: f64) -> f64 {
    let t = x as i64 as f64;
    if t > x {
        t - 1.0
    } else {
        t
    }
}

/// `x.ceil()` without a libm call (see [`floor_fast`]).
#[inline]
pub fn ceil_fast(x: f64) -> f64 {
    -floor_fast(-x)
}

/// Euclidean length without `hypot` (identical across implementations).
#[inline]
pub fn len2d(x: f64, y: f64) -> f64 {
    (x * x + y * y).sqrt()
}

/// `clamp` that never panics on reversed bounds (returns `lo` then).
#[inline]
pub fn clampf(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

/// Minimum of two floats. A NaN operand is ignored, as in `f64::min`; on ties (`-0`
/// and `+0`) `a` is returned. The TypeScript `minf` is the same function, and the port
/// uses it for `f64::min` too, so both must ignore NaN in either position.
#[inline]
pub fn minf(a: f64, b: f64) -> f64 {
    if b < a || a.is_nan() {
        b
    } else {
        a
    }
}

/// Maximum of two floats. A NaN operand is ignored, as in `f64::max`; on ties `a` is
/// returned.
#[inline]
pub fn maxf(a: f64, b: f64) -> f64 {
    if b > a || a.is_nan() {
        b
    } else {
        a
    }
}

/// Sign as -1, 0, 1 with a tolerance band around zero.
#[inline]
pub fn sign_eps(v: f64, eps: f64) -> f64 {
    if v > eps {
        1.0
    } else if v < -eps {
        -1.0
    } else {
        0.0
    }
}

/// Total order for f64 used in sorts (inputs are finite; NaN sorts last).
#[inline]
pub fn cmp_f64(a: f64, b: f64) -> std::cmp::Ordering {
    a.partial_cmp(&b).unwrap_or_else(|| {
        if a.is_nan() && b.is_nan() {
            std::cmp::Ordering::Equal
        } else if a.is_nan() {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Less
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minf_maxf_ignore_nan() {
        let nan = f64::NAN;
        assert_eq!(minf(nan, 1.0), 1.0);
        assert_eq!(minf(1.0, nan), 1.0);
        assert_eq!(maxf(nan, 1.0), 1.0);
        assert_eq!(maxf(1.0, nan), 1.0);
        assert!(minf(nan, nan).is_nan() && maxf(nan, nan).is_nan());
        assert_eq!(minf(2.0, -3.0), -3.0);
        assert_eq!(maxf(2.0, -3.0), 2.0);
        assert_eq!(minf(f64::NEG_INFINITY, 0.0), f64::NEG_INFINITY);
        // ties keep the first operand
        assert!(minf(-0.0, 0.0).is_sign_negative() && minf(0.0, -0.0).is_sign_positive());
        assert!(maxf(-0.0, 0.0).is_sign_negative() && maxf(0.0, -0.0).is_sign_positive());
    }

    #[test]
    fn cmp_f64_orders_nan_last() {
        use std::cmp::Ordering::*;
        assert_eq!(cmp_f64(1.0, 2.0), Less);
        assert_eq!(cmp_f64(-0.0, 0.0), Equal);
        assert_eq!(cmp_f64(f64::NAN, 1.0), Greater);
        assert_eq!(cmp_f64(1.0, f64::NAN), Less);
        assert_eq!(cmp_f64(f64::NAN, f64::NAN), Equal);
        assert_eq!(cmp_f64(f64::INFINITY, f64::NAN), Less);
    }
}
