//! Stable sorting with one copy of the standard library's sort per element type.
//!
//! A `slice::sort_by` call site with its own comparator closure gets its own copy of the
//! sort (about 8 KB in WebAssembly, where the copies were a sixth of the module's code),
//! so WebAssembly builds pass the comparator as a trait object. Native builds call
//! `slice::sort_by` directly. Both run the same stable sort: the results are identical.

use std::cmp::Ordering;

/// `v.sort_by(cmp)` (stable).
#[inline]
pub fn sort_by<T, F: FnMut(&T, &T) -> Ordering>(v: &mut [T], mut cmp: F) {
    #[cfg(target_arch = "wasm32")]
    sort_dyn(v, &mut cmp);
    #[cfg(not(target_arch = "wasm32"))]
    v.sort_by(&mut cmp);
}

/// `v.sort_by_key(key)` (stable).
#[inline]
pub fn sort_by_key<T, K: Ord, F: FnMut(&T) -> K>(v: &mut [T], mut key: F) {
    sort_by(v, |a, b| key(a).cmp(&key(b)));
}

#[cfg(target_arch = "wasm32")]
#[inline(never)]
fn sort_dyn<T>(v: &mut [T], cmp: &mut dyn FnMut(&T, &T) -> Ordering) {
    v.sort_by(|a, b| cmp(a, b));
}
