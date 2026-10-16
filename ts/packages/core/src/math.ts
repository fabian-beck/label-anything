/**
 * Deterministic math helpers (port of `rust/crates/la-core/src/math.rs`).
 *
 * All float code in the engine uses only `+ − × ÷`, `Math.sqrt` and the functions in
 * this module, so that the Rust and TypeScript implementations agree bit for bit
 * (ADR 0007). The transcendental functions come from `detmath.ts`. The helpers below
 * the Rust ones are the conversions of `docs/dev/porting.md`.
 *
 * @module
 */

export { cbrt, exp, ln, ln1p, roundHalfAway, sinCosDeg } from "./detmath.js";

/** Euclidean length without `hypot` (identical across implementations). */
export function len2d(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** `clamp` that never throws on reversed bounds (returns `lo` then). */
export function clampf(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * Minimum of two floats; a NaN operand is ignored as in Rust's `f64::min` (unlike
 * `Math.min`), and on ties (`-0`, `+0`) `a` is returned. Use it for Rust `minf` and
 * `f64::min` alike.
 */
export function minf(a: number, b: number): number {
  return b < a || a !== a ? b : a;
}

/** Maximum of two floats; a NaN operand is ignored as in Rust's `f64::max`. */
export function maxf(a: number, b: number): number {
  return b > a || a !== a ? b : a;
}

/** Sign as -1, 0, 1 with a tolerance band around zero. */
export function signEps(v: number, eps: number): number {
  if (v > eps) return 1;
  if (v < -eps) return -1;
  return 0;
}

/**
 * Comparator of Rust's `cmp_f64`: numeric order (`-0` equals `+0`), NaN sorts last
 * (two NaNs are equal). Returns -1, 0 or 1.
 */
export function cmpF64(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  if (a === b) return 0;
  const an = a !== a;
  const bn = b !== b;
  if (an && bn) return 0;
  return an ? 1 : -1;
}

/**
 * Comparator of Rust string order (UTF-8 bytes, i.e. Unicode code points), which
 * differs from JavaScript's UTF-16 code unit order above U+FFFF. Returns -1, 0 or 1.
 */
export function cmpStr(a: string, b: string): number {
  const n = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    // Surrogates (code points >= U+10000) must sort after U+E000..U+FFFF.
    if (x >= 0xd800 && y >= 0xd800) {
      x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
      y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
    }
    return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** `usize::MAX as f64` (= 2^64): the saturation value of {@link toIndex}. */
export const USIZE_MAX = 18446744073709551616;

/**
 * Rust's `x as usize`: truncation toward zero, saturating (NaN and negative values give
 * 0, values ≥ 2^64 give {@link USIZE_MAX}).
 */
export function toIndex(x: number): number {
  if (!(x > 0)) return 0;
  if (x >= USIZE_MAX) return USIZE_MAX;
  return Math.trunc(x);
}
