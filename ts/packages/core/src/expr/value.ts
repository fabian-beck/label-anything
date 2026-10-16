/**
 * Values of the expression language and the helpers shared with la-core
 * (port of rust/crates/la-expr/src/value.rs and the value parts of eval.rs).
 *
 * @module
 */

/** A value: JSON data. Numbers are finite (evaluation turns NaN/±Infinity into null). */
export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };

const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Reads a JS value as a language value: `undefined`, functions, symbols, bigints and
 * non-finite numbers become null (attrs are expected to be JSON data, as from JSON.parse).
 */
export function norm(v: unknown): Value {
  switch (typeof v) {
    case "number":
      return Number.isFinite(v) ? (v as number) : null;
    case "string":
    case "boolean":
      return v as Value;
    case "object":
      return v as Value;
    default:
      return null;
  }
}

/** True for a JSON object (not null, not a list). */
export function isObject(v: Value): v is { [key: string]: Value } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Own member `key` of an object (missing → null). */
export function member(o: { [key: string]: Value }, key: string): Value {
  return hasOwn.call(o, key) ? norm(o[key]) : null;
}

/**
 * Truthiness: false, null, 0, -0, NaN, "" and [] are falsy; everything else (every
 * object, also {}) is truthy.
 */
export function truthy(v: Value): boolean {
  switch (typeof v) {
    case "boolean":
      return v;
    case "number":
      return v !== 0 && v === v;
    case "string":
      return v.length > 0;
    case "object":
      return v === null ? false : Array.isArray(v) ? v.length > 0 : true;
    default:
      return false;
  }
}

/** Value of a priority term: numbers as is, booleans as 1/0, anything else → null (missing). */
export function termNumber(v: Value): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

/**
 * Structural equality used by `==`, `!=`, `in`, `contains` and coverage grouping:
 * numbers numerically (-0 == 0), strings by code points, booleans and null by identity,
 * lists elementwise, objects by equal key sets with equal values. Different types are
 * unequal. Iterative, so arbitrarily deep data cannot overflow the stack.
 */
export function valuesEqual(a: Value, b: Value): boolean {
  const stack: unknown[] = [a, b];
  while (stack.length > 0) {
    const y = norm(stack.pop());
    const x = norm(stack.pop());
    if (x === y) continue;
    if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) return false;
    const xl = Array.isArray(x);
    if (xl !== Array.isArray(y)) return false;
    if (xl) {
      const xa = x as Value[];
      const ya = y as Value[];
      if (xa.length !== ya.length) return false;
      for (let i = 0; i < xa.length; i++) stack.push(xa[i], ya[i]);
    } else {
      const xo = x as { [key: string]: Value };
      const yo = y as { [key: string]: Value };
      const keys = Object.keys(xo);
      if (keys.length !== Object.keys(yo).length) return false;
      for (const k of keys) {
        if (!hasOwn.call(yo, k)) return false;
        stack.push(xo[k], yo[k]);
      }
    }
  }
  return true;
}

/**
 * Compares two strings by Unicode code points (not UTF-16 code units, which order
 * U+E000…U+FFFF after the supplementary planes). Returns < 0, 0 or > 0.
 */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return fixup(x) - fixup(y);
  }
  return a.length - b.length;
}

/** Maps UTF-16 code units so that their order is code-point order (surrogates last). */
function fixup(c: number): number {
  return c >= 0xd800 ? (c >= 0xe000 ? c - 0x800 : c + 0x2000) : c;
}

/** Number of code points of a string (a surrogate pair counts once). */
export function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) i++;
    }
    n++;
  }
  return n;
}
