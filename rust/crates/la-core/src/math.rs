//! Deterministic math helpers.
//!
//! All float code in the engine uses only `+ - * /`, `sqrt` and the functions in this
//! module, so that the Rust and TypeScript implementations agree bit for bit (ADR 0007).
//! The transcendental functions are provided by `la_expr::det_math`.

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

/// Minimum of two floats (no NaN handling needed: inputs are finite).
#[inline]
pub fn minf(a: f64, b: f64) -> f64 {
    if b < a {
        b
    } else {
        a
    }
}

/// Maximum of two floats.
#[inline]
pub fn maxf(a: f64, b: f64) -> f64 {
    if b > a {
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
