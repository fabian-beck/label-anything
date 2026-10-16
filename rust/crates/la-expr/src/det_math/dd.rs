//! Error-free transformations and double-double ("dd") helpers.
//!
//! Only IEEE-754 `+ − ×` are used (no FMA), so every helper is reproducible bit for bit
//! in any language with correctly rounded binary64 arithmetic. The TypeScript port in
//! `detmath.ts` performs the same operations in the same order.

use super::consts::SPLITTER;

/// Veltkamp split: `a = hi + lo` with `hi`, `lo` of at most 26 significant bits.
/// Requires `|a| < 2^996` (no overflow in `SPLITTER · a`).
#[inline(always)]
fn split(a: f64) -> (f64, f64) {
    let c = SPLITTER * a;
    let hi = c - (c - a);
    (hi, a - hi)
}

/// Dekker's exact product: `a · b = p + e` with `p = fl(a · b)`.
/// Exact unless the split overflows (`|a|, |b| ≥ 2^996`) or `e` underflows.
#[inline(always)]
pub(crate) fn two_prod(a: f64, b: f64) -> (f64, f64) {
    let p = a * b;
    let (ah, al) = split(a);
    let (bh, bl) = split(b);
    let e = (((ah * bh - p) + ah * bl) + al * bh) + al * bl;
    (p, e)
}

/// Knuth's exact sum: `a + b = s + e` with `s = fl(a + b)`, for any `a`, `b`.
#[inline(always)]
pub(crate) fn two_sum(a: f64, b: f64) -> (f64, f64) {
    let s = a + b;
    let bb = s - a;
    let e = (a - (s - bb)) + (b - bb);
    (s, e)
}

/// Dekker's exact sum for `|a| ≥ |b|` (or `a = 0`): `a + b = s + e`.
#[inline(always)]
pub(crate) fn fast_two_sum(a: f64, b: f64) -> (f64, f64) {
    let s = a + b;
    let e = b - (s - a);
    (s, e)
}

/// Double-double product `(ah + al) · (bh + bl)`, relative error about 2^-104.
#[inline(always)]
pub(crate) fn dd_mul(ah: f64, al: f64, bh: f64, bl: f64) -> (f64, f64) {
    let (p, e) = two_prod(ah, bh);
    let e = e + (ah * bl + al * bh);
    fast_two_sum(p, e)
}

/// Double-double reciprocal `1 / (h + l)`, relative error about 2^-104.
#[inline(always)]
pub(crate) fn dd_recip(h: f64, l: f64) -> (f64, f64) {
    let q = 1.0 / h;
    let (p, e) = two_prod(q, h);
    let r = ((1.0 - p) - e) - q * l;
    fast_two_sum(q, r / h)
}

/// `c − (h + l)` as a normalized double-double.
#[inline(always)]
pub(crate) fn dd_rsub(c: f64, h: f64, l: f64) -> (f64, f64) {
    let (s, e) = two_sum(c, -h);
    fast_two_sum(s, e - l)
}
