/**
 * Accessors for JSON values with the semantics of `serde_json::Value` (`as_f64`,
 * `as_u64`, `get`, …) and Rust's number parsing and formatting.
 *
 * JSON values are plain JavaScript values. JavaScript cannot tell `3` from `3.0`, so
 * {@link asU64} accepts any non-negative integral number (serde_json rejects a JSON
 * float such as `3.0` there).
 *
 * @module
 */

/** A JSON object. */
export type JsonObject = Record<string, unknown>;

const hasOwnProperty = Object.prototype.hasOwnProperty;

/** `v.is_object()`. */
export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `v.get(k)` for objects: the own property `k` (`undefined` if absent or if `v` is not an
 * object; JSON `null` is returned as `null`).
 */
export function get(v: unknown, k: string): unknown {
  if (!isObject(v) || !hasOwnProperty.call(v, k)) return undefined;
  return v[k];
}

/** `v.get(i)` for arrays. */
export function at(v: unknown, i: number): unknown {
  return Array.isArray(v) && i < v.length ? v[i] : undefined;
}

/** `v.as_f64()`. */
export function asF64(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/** `v.as_u64()`: a non-negative integral number. */
export function asU64(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/** `v.as_i64()`: an integral number in the i64 range. */
export function asI64(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= -9223372036854775808 && v < 9223372036854775808
    ? v
    : null;
}

/** `v.as_str()`. */
export function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** `v.as_bool()`. */
export function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** `v.as_array()`. */
export function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

/** `v.as_array()` as an iterable of its elements (empty for non-arrays). */
export function items(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? v : EMPTY;
}

const EMPTY: readonly unknown[] = [];

/** `Value::eq` (structural equality; numbers compare by value). */
export function jsonEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEq(a[i], b[i])) return false;
    return true;
  }
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!hasOwnProperty.call(b, k) || !jsonEq(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/** The grammar of Rust's `f64::from_str` (without `inf`/`nan`, handled separately). */
const RUST_FLOAT = /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/;
const RUST_SPECIAL = /^([+-]?)(inf|infinity|nan)$/i;

/** Rust's `s.parse::<f64>().ok()`. */
export function parseRustF64(s: string): number | null {
  if (RUST_FLOAT.test(s)) return Number(s);
  const m = RUST_SPECIAL.exec(s);
  if (m === null) return null;
  if (m[2]!.toLowerCase() === "nan") return NaN;
  return m[1] === "-" ? -Infinity : Infinity;
}

const TWO64 = BigInt(2) ** BigInt(64);

/** Rust's `s.parse::<u64>().ok()` as a bigint. */
export function parseRustU64(s: string): bigint | null {
  if (!/^\+?[0-9]+$/.test(s)) return null;
  const v = BigInt(s.startsWith("+") ? s.slice(1) : s);
  return v < TWO64 ? v : null;
}

/**
 * Rust's `Display` of an `f64` (`format!("{x}")`): the shortest representation that
 * round-trips, in plain decimal notation (never an exponent), `NaN`, `inf`, `-inf`.
 */
export function fmtF64(x: number): string {
  if (x !== x) return "NaN";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const s = String(x);
  const e = s.indexOf("e");
  if (e < 0) return s;
  // d.ddde±k → plain decimal
  const neg = s.startsWith("-");
  const mant = s.slice(neg ? 1 : 0, e);
  const exp = Number(s.slice(e + 1));
  const dot = mant.indexOf(".");
  const digits = dot < 0 ? mant : mant.slice(0, dot) + mant.slice(dot + 1);
  const point = (dot < 0 ? mant.length : dot) + exp; // position of the decimal point
  let out: string;
  if (point <= 0) out = "0." + "0".repeat(-point) + digits;
  else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
  else out = digits.slice(0, point) + "." + digits.slice(point);
  return neg ? "-" + out : out;
}

const F64_VIEW = new DataView(new ArrayBuffer(8));

/**
 * Rust's `format!("{x:.digits$}")` of an `f64`: the exact binary value rounded to
 * `digits` decimals, ties to even (JavaScript's `toFixed` rounds ties up), with a `-` for
 * every negative value including `-0`.
 */
export function fmtFixed(x: number, digits: number): string {
  if (x !== x) return "NaN";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  F64_VIEW.setFloat64(0, x);
  const hi = F64_VIEW.getUint32(0);
  const lo = F64_VIEW.getUint32(4);
  const neg = hi >>> 31 === 1;
  const bexp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << BigInt(32)) | BigInt(lo);
  let exp: number;
  if (bexp === 0) exp = -1074;
  else {
    mant |= BigInt(1) << BigInt(52);
    exp = bexp - 1075;
  }
  // |x| = mant · 2^exp = num / 10^k
  let num: bigint;
  let k: number;
  if (exp >= 0) {
    num = mant << BigInt(exp);
    k = 0;
  } else {
    k = -exp;
    num = mant * BigInt(5) ** BigInt(k);
  }
  // scaled = |x| · 10^digits, rounded half to even
  let scaled: bigint;
  if (k <= digits) scaled = num * BigInt(10) ** BigInt(digits - k);
  else {
    const div = BigInt(10) ** BigInt(k - digits);
    const q = num / div;
    const twice = (num % div) * BigInt(2);
    scaled = twice > div || (twice === div && q % BigInt(2) === BigInt(1)) ? q + BigInt(1) : q;
  }
  let s = scaled.toString();
  if (digits > 0) {
    if (s.length <= digits) s = "0".repeat(digits - s.length + 1) + s;
    s = s.slice(0, s.length - digits) + "." + s.slice(s.length - digits);
  }
  return neg ? "-" + s : s;
}
