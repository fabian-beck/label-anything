/**
 * `validate(problem)`: structured errors with JSON pointers (ADR 0003).
 *
 * Port of `rust/crates/la-core/src/validate.rs`. The syntax check interprets the embedded
 * `spec/schema/problem.v1.json` (the keywords of JSON Schema 2020-12 that the schema
 * uses), so the schema stays the single source of truth. Semantic checks (ids,
 * references, expressions, unknown classes, …) follow. Codes, pointers, messages and the
 * order of the issues are identical to Rust's (checked against the Rust reports in
 * `conformance/validate/reports/`).
 *
 * The input is a JSON value: `null`, booleans, numbers, strings, arrays and plain
 * objects. As with `JSON.stringify`, an object property whose value is `undefined` counts
 * as absent and an `undefined` array element as `null`. `"type": "integer"` accepts every
 * number without a fractional part, as in Rust (`f.fract() == 0.0`), so serde_json's
 * integer/float distinction (`1` vs `1.0`), which JavaScript cannot see, never matters.
 *
 * {@link validateStr} parses JSON text exactly like `serde_json::from_str` (see
 * {@link parseJson}), including its error messages and positions.
 */
import { compareCodePoints } from "./expr/index.js";
import { checkExpr } from "./expr-check.js";
import { PRESETS, PROBLEM_SCHEMA } from "./generated/spec-data.js";

/** One validation error or warning. */
export class Issue {
  pointer: string;
  code: string;
  message: string;

  constructor(pointer: string, code: string, message: string) {
    this.pointer = pointer;
    this.code = code;
    this.message = message;
  }
}

/** Result of {@link validate}. */
export interface Report {
  valid: boolean;
  errors: Issue[];
  warnings: Issue[];
}

/** Reserved obstacle classes. */
export const RESERVED_CLASSES: readonly string[] = ["items", "labels", "leaders", "canvas_edge", "ink", "text"];

type JsonObject = Record<string, unknown>;

const hasOwnProperty = Object.prototype.hasOwnProperty;

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `v.get(k)`: the property `k` of a JSON object (`undefined` if absent or not an object). */
function getKey(v: unknown, k: string): unknown {
  return isObject(v) && hasOwnProperty.call(v, k) ? v[k] : undefined;
}

/** `v.pointer("/k1/k2")` for non-numeric tokens. */
function getPath(v: unknown, k1: string, k2: string): unknown {
  return getKey(getKey(v, k1), k2);
}

/** Escape one JSON-pointer reference token (RFC 6901). */
export function ptrToken(s: string): string {
  if (s.indexOf("~") < 0 && s.indexOf("/") < 0) return s;
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Append a token to a pointer. */
export function ptrJoin(base: string, token: string): string {
  return base + "/" + ptrToken(token);
}

/** Validate a problem given as JSON text. */
export function validateStr(text: string): Report {
  let v: unknown;
  try {
    v = parseJson(text);
  } catch (e) {
    if (!(e instanceof JsonError)) throw e;
    return { valid: false, errors: [new Issue("", "parse", `invalid JSON: ${e.message}`)], warnings: [] };
  }
  return validate(v);
}

/** Validate a problem value. */
export function validate(problem: unknown): Report {
  const interp = schemaInterp();
  const errors: Issue[] = [];
  interp.check(interp.root, problem, ROOT, false, false, new Sink(errors));
  const warnings: Issue[] = [];
  semantic(problem, errors, warnings);
  errors.sort(cmpIssue);
  dedupIssues(errors);
  warnings.sort(cmpIssue);
  dedupIssues(warnings);
  return { valid: errors.length === 0, errors, warnings };
}

/** The derived `Ord` of Rust's `Issue`: pointer, code, message, by code points. */
function cmpIssue(a: Issue, b: Issue): number {
  return (
    compareCodePoints(a.pointer, b.pointer) ||
    compareCodePoints(a.code, b.code) ||
    compareCodePoints(a.message, b.message)
  );
}

/** `dedup_by(|a, b| a.pointer == b.pointer && a.code == b.code)`: keeps the first of a run. */
function dedupIssues(v: Issue[]): void {
  let w = 0;
  for (let r = 0; r < v.length; r++) {
    const e = v[r]!;
    if (w > 0) {
      const last = v[w - 1]!;
      if (last.pointer === e.pointer && last.code === e.code) continue;
    }
    v[w++] = e;
  }
  v.length = w;
}

// ---------------------------------------------------------------------------------------
// Schema interpreter
// ---------------------------------------------------------------------------------------

let INTERP: Interp | null = null;

function schemaInterp(): Interp {
  if (INTERP === null) INTERP = new Interp(PROBLEM_SCHEMA);
  return INTERP;
}

/**
 * A lazily materialized JSON pointer (built only when an error is reported): the root
 * (`up === null`, `tok` is the root pointer), an object key (string) or an array index.
 */
interface Path {
  readonly up: Path | null;
  readonly tok: string | number;
}

const ROOT: Path = { up: null, tok: "" };

function keyPath(up: Path, k: string): Path {
  return { up, tok: k };
}

function idxPath(up: Path, i: number): Path {
  return { up, tok: i };
}

function render(path: Path): string {
  const segs: string[] = [];
  let cur = path;
  while (cur.up !== null) {
    segs.push(typeof cur.tok === "number" ? String(cur.tok) : ptrToken(cur.tok));
    cur = cur.up;
  }
  let out = String(cur.tok);
  for (let i = segs.length - 1; i >= 0; i--) out += "/" + segs[i]!;
  return out;
}

function typeName(v: unknown): string {
  switch (typeof v) {
    case "boolean":
      return "boolean";
    case "number":
      // NaN and ±Infinity are no JSON numbers (JSON.stringify writes null)
      return Number.isFinite(v) ? "number" : String(v);
    case "string":
      return "string";
    case "object":
      return v === null ? "null" : Array.isArray(v) ? "array" : "object";
    default:
      return "null";
  }
}

function typeIs(t: string, v: unknown): boolean {
  switch (t) {
    case "integer":
      // `v.as_f64().map(|f| f.fract() == 0.0)`: also true for serde_json floats like 1.0
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    default:
      return typeName(v) === t;
  }
}

/**
 * JSON equality with numbers compared as f64 (`json_eq`). Iterative, so deeply nested
 * data cannot overflow the stack.
 */
function jsonEq(a0: unknown, b0: unknown): boolean {
  const stack: unknown[] = [a0, b0];
  while (stack.length > 0) {
    const b = stack.pop();
    const a = stack.pop();
    if (typeof a === "number" && typeof b === "number") {
      if (a !== b) return false;
    } else if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = a.length - 1; i >= 0; i--) stack.push(a[i], b[i]);
    } else if (isObject(a)) {
      if (!isObject(b)) return false;
      let n = 0;
      for (const k of Object.keys(a)) {
        const x = a[k];
        if (x === undefined) continue;
        n++;
        const y = hasOwnProperty.call(b, k) ? b[k] : undefined;
        if (y === undefined) return false;
        stack.push(x, y);
      }
      let m = 0;
      for (const k of Object.keys(b)) if (b[k] !== undefined) m++;
      if (n !== m) return false;
    } else if ((a === undefined ? null : a) !== (b === undefined ? null : b)) {
      return false;
    }
  }
  return true;
}

/** `Value::to_string()` of the value, cut to 57 code points + "…" if longer than 60 bytes. */
function short(v: unknown): string {
  // Called with strings (the user's value) and with the schema's `const` and `enum`
  // values, which are all strings: `JSON.stringify` escapes strings exactly like
  // serde_json (`\"`, `\\`, `\b \f \n \r \t`, other control characters as `\u00xx`).
  const s = JSON.stringify(v === undefined ? null : v) ?? "null";
  if (utf8Length(s) <= 60) return s;
  let end = 0;
  for (let n = 0; n < 57 && end < s.length; n++) {
    const c = s.charCodeAt(end);
    end += c >= 0xd800 && c < 0xdc00 && end + 1 < s.length && isLowSurrogate(s.charCodeAt(end + 1)) ? 2 : 1;
  }
  return s.slice(0, end) + "…";
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c < 0xe000;
}

/** Length of `s` in UTF-8 bytes (Rust `str::len`). */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && isLowSurrogate(s.charCodeAt(i + 1))) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** `s.chars().count() < m` without counting more than needed. */
function fewerCodePoints(s: string, m: number): boolean {
  if (s.length < m) return true;
  if (s.length >= 2 * m) return false;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && isLowSurrogate(s.charCodeAt(i + 1))) i++;
    if (++n >= m) return false;
  }
  return true;
}

/** `Value::as_u64` of a schema value (the schema writes these as integers). */
function asU64(m: unknown): number | null {
  return typeof m === "number" && Number.isInteger(m) && m >= 0 ? m : null;
}

/** Rust `Display` of an `f64`: shortest round-trip digits, never in exponent notation. */
function fmtF64(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const s = String(x);
  const e = s.indexOf("e");
  if (e < 0) return s;
  let mant = s.slice(0, e);
  const exp = Number(s.slice(e + 1));
  let sign = "";
  if (mant.charCodeAt(0) === 0x2d) {
    sign = "-";
    mant = mant.slice(1);
  }
  const dot = mant.indexOf(".");
  const digits = dot < 0 ? mant : mant.slice(0, dot) + mant.slice(dot + 1);
  const point = (dot < 0 ? mant.length : dot) + exp;
  if (point <= 0) return sign + "0." + "0".repeat(-point) + digits;
  if (point >= digits.length) return sign + digits + "0".repeat(point - digits.length);
  return sign + digits.slice(0, point) + "." + digits.slice(point);
}

const QUICK_FAIL = new Issue("", "", "");

/** Where errors go: collected with pointers, or just "did anything fail" (fail fast). */
class Sink {
  /** The collected issues (`Sink::Collect`), or `null` for `Sink::Quick`. */
  readonly out: Issue[] | null;
  private quickFailed = false;

  constructor(out: Issue[] | null) {
    this.out = out;
  }

  err(ptr: Path, code: string, msg: () => string): void {
    if (this.out !== null) this.out.push(new Issue(render(ptr), code, msg()));
    else this.quickFailed = true;
  }

  push(issue: Issue): void {
    if (this.out !== null) this.out.push(issue);
    else this.quickFailed = true;
  }

  failed(): boolean {
    return this.quickFailed;
  }
}

/** The result of `check` when no property names are collected (never written to). */
const EMPTY: string[] = Object.freeze([]) as unknown as string[];

function extend(into: string[], from: readonly string[]): void {
  for (let i = 0; i < from.length; i++) into.push(from[i]!);
}

class Interp {
  readonly root: unknown;
  private readonly regexes = new Map<string, RegExp | null>();
  private readonly refs = new Map<string, unknown>();

  constructor(root: unknown) {
    this.root = root;
  }

  resolve(r: string): unknown {
    if (this.refs.has(r)) return this.refs.get(r);
    let cur: unknown = undefined;
    if (r.startsWith("#/")) {
      cur = this.root;
      for (const tok of r.slice(2).split("/")) {
        cur = getKey(cur, tok.indexOf("~") >= 0 ? tok.replace(/~1/g, "/").replace(/~0/g, "~") : tok);
        if (cur === undefined) break;
      }
    }
    this.refs.set(r, cur);
    return cur;
  }

  regexMatch(pattern: string, s: string): boolean {
    let re = this.regexes.get(pattern);
    if (re === undefined) {
      try {
        re = new RegExp(pattern, "u");
      } catch {
        re = null;
      }
      this.regexes.set(pattern, re);
    }
    return re === null ? true : re.test(s);
  }

  /** Fail-fast validity of `v` against `s` (no error objects). */
  valid(s: unknown, v: unknown, unit: boolean): boolean {
    const q = new Sink(null);
    this.check(s, v, ROOT, unit, false, q);
    return !q.failed();
  }

  /** Property names evaluated by `s` at `v` (for `unevaluatedProperties`); `v` is valid. */
  evaluatedOf(s: unknown, v: unknown, unit: boolean): readonly string[] {
    return this.check(s, v, ROOT, unit, true, new Sink([]));
  }

  /**
   * Check `v` against schema `s`. When `collect` is set, returns the property names
   * evaluated at this location (for `unevaluatedProperties`). In quick mode returns as
   * soon as anything fails.
   */
  check(s: unknown, v: unknown, ptr: Path, unit: boolean, collect: boolean, sink: Sink): readonly string[] {
    if (s === true) return EMPTY;
    if (s === false) {
      sink.err(ptr, "invalid_value", () => "value not allowed here");
      return EMPTY;
    }
    if (!isObject(s)) return EMPTY;
    const o = s;
    const need = collect || hasOwnProperty.call(o, "unevaluatedProperties");
    // only written when `need` is set
    const evaluated: string[] = need ? [] : EMPTY;
    const r = o["$ref"];
    if (typeof r === "string") {
      const target = this.resolve(r);
      if (target !== undefined) {
        const unit2 = unit || r === "#/$defs/length" || r === "#/$defs/nonNegLength";
        const ev = this.check(target, v, ptr, unit2, need, sink);
        if (sink.failed()) return evaluated;
        if (need) extend(evaluated, ev);
      }
    }
    const t = o["type"];
    if (t !== undefined) {
      let ok = true;
      if (typeof t === "string") {
        ok = typeIs(t, v);
      } else if (Array.isArray(t)) {
        ok = false;
        for (const x of t) {
          if (typeof x === "string" && typeIs(x, v)) {
            ok = true;
            break;
          }
        }
      }
      if (!ok) {
        sink.err(ptr, "type", () => {
          const want =
            typeof t === "string"
              ? t
              : Array.isArray(t)
                ? t.filter((x): x is string => typeof x === "string").join(" or ")
                : "";
          return `expected ${want}, got ${typeName(v)}`;
        });
        return evaluated;
      }
    }
    if (hasOwnProperty.call(o, "const")) {
      const c = o["const"];
      if (!jsonEq(c, v)) {
        sink.err(ptr, "const", () => `must be ${short(c)}`);
        if (sink.failed()) return evaluated;
      }
    }
    const e = o["enum"];
    if (Array.isArray(e)) {
      let found = false;
      for (const x of e) {
        if (jsonEq(x, v)) {
          found = true;
          break;
        }
      }
      if (!found) {
        sink.err(ptr, "enum", () => `must be one of ${e.map((x) => short(x)).join(", ")}`);
        if (sink.failed()) return evaluated;
      }
    }
    if (typeof v === "number") {
      const x = v;
      const min = o["minimum"];
      if (typeof min === "number" && x < min) sink.err(ptr, "range", () => `must be >= ${fmtF64(min)}`);
      const max = o["maximum"];
      if (typeof max === "number" && x > max) sink.err(ptr, "range", () => `must be <= ${fmtF64(max)}`);
      const xmin = o["exclusiveMinimum"];
      if (typeof xmin === "number" && x <= xmin) sink.err(ptr, "range", () => `must be > ${fmtF64(xmin)}`);
      const xmax = o["exclusiveMaximum"];
      if (typeof xmax === "number" && x >= xmax) sink.err(ptr, "range", () => `must be < ${fmtF64(xmax)}`);
    } else if (typeof v === "string") {
      const st = v;
      const m = asU64(o["minLength"]);
      if (m !== null && fewerCodePoints(st, m)) sink.err(ptr, "length", () => `must have at least ${m} characters`);
      const p = o["pattern"];
      if (typeof p === "string" && !this.regexMatch(p, st)) {
        const code = unit ? "unit" : "pattern";
        sink.err(ptr, code, () =>
          unit
            ? `invalid length ${short(v)}: use a number (px) or <number>px|pt|em`
            : `${short(v)} does not match ${p}`,
        );
      }
    } else if (Array.isArray(v)) {
      const a = v;
      const minItems = asU64(o["minItems"]);
      if (minItems !== null && a.length < minItems) sink.err(ptr, "length", () => `must have at least ${minItems} items`);
      const maxItems = asU64(o["maxItems"]);
      if (maxItems !== null && a.length > maxItems) sink.err(ptr, "length", () => `must have at most ${maxItems} items`);
      if (sink.failed()) return evaluated;
      let start = 0;
      const pre = o["prefixItems"];
      if (Array.isArray(pre)) {
        for (let i = 0; i < pre.length; i++) {
          if (i < a.length) {
            this.check(pre[i], a[i], idxPath(ptr, i), unit, false, sink);
            if (sink.failed()) return evaluated;
          }
        }
        start = pre.length;
      }
      const is = o["items"];
      if (is !== undefined) {
        // fast path for the common `[x, y]` point arrays
        const isPoint = getKey(is, "$ref") === "#/$defs/point";
        for (let i = start; i < a.length; i++) {
          const item = a[i];
          if (
            isPoint &&
            Array.isArray(item) &&
            item.length === 2 &&
            typeof item[0] === "number" &&
            typeof item[1] === "number"
          ) {
            continue;
          }
          this.check(is, item, idxPath(ptr, i), unit, false, sink);
          if (sink.failed()) return evaluated;
        }
      }
      if (o["uniqueItems"] === true) {
        outer: for (let i = 0; i < a.length; i++) {
          for (let j = 0; j < i; j++) {
            if (jsonEq(a[i], a[j])) {
              sink.err(idxPath(ptr, i), "unique", () => "duplicate entry");
              break outer;
            }
          }
        }
      }
    } else if (isObject(v)) {
      const m = v;
      const req = o["required"];
      if (Array.isArray(req)) {
        for (const rq of req) {
          if (typeof rq === "string" && getKey(m, rq) === undefined) {
            sink.err(keyPath(ptr, rq), "required", () => `missing required property '${rq}'`);
          }
        }
      }
      if (sink.failed()) return evaluated;
      const keys = Object.keys(m);
      const pv = o["properties"];
      const props = isObject(pv) ? pv : null;
      if (props !== null) {
        for (const k of keys) {
          const val = m[k];
          if (val === undefined || !hasOwnProperty.call(props, k)) continue;
          this.check(props[k], val, keyPath(ptr, k), false, false, sink);
          if (sink.failed()) return evaluated;
          if (need) evaluated.push(k);
        }
      }
      const ap = o["additionalProperties"];
      if (ap !== undefined) {
        for (const k of keys) {
          const val = m[k];
          if (val === undefined) continue;
          if (props !== null && hasOwnProperty.call(props, k)) continue;
          if (ap === false) {
            sink.err(keyPath(ptr, k), "unknown_property", () => `unknown property '${k}'`);
          } else {
            this.check(ap, val, keyPath(ptr, k), false, false, sink);
          }
          if (sink.failed()) return evaluated;
          if (need) evaluated.push(k);
        }
      }
      const pn = o["propertyNames"];
      if (pn !== undefined) {
        for (const k of keys) {
          if (m[k] === undefined) continue;
          this.check(pn, k, keyPath(ptr, k), false, false, sink);
          if (sink.failed()) return evaluated;
        }
      }
      const dr = o["dependentRequired"];
      if (isObject(dr)) {
        for (const k of Object.keys(dr)) {
          if (getKey(m, k) === undefined) continue;
          const deps = dr[k];
          if (!Array.isArray(deps)) continue;
          for (const d of deps) {
            if (typeof d === "string" && getKey(m, d) === undefined) {
              sink.err(keyPath(ptr, d), "required", () => `'${d}' is required when '${k}' is given`);
            }
          }
        }
      }
    }
    if (sink.failed()) return evaluated;
    const all = o["allOf"];
    if (Array.isArray(all)) {
      for (const sub of all) {
        const ev = this.check(sub, v, ptr, unit, need, sink);
        if (sink.failed()) return evaluated;
        if (need) extend(evaluated, ev);
      }
    }
    const any = o["anyOf"];
    if (Array.isArray(any)) {
      const valid: number[] = [];
      for (let k = 0; k < any.length; k++) if (this.valid(any[k], v, unit)) valid.push(k);
      if (valid.length === 0) {
        if (sink.out !== null) {
          const p = render(ptr);
          if (requiredOnly(any)) {
            const first = getKey(any[0], "required");
            const name = Array.isArray(first) && typeof first[0] === "string" ? first[0] : "";
            sink.push(new Issue(ptrJoin(p, name), "required", `one of ${requiredNames(any)} is required`));
          } else {
            const results = any.map((sub) => this.errorsOf(sub, v, ptr, unit));
            for (const issue of bestAlternative(results, p)) sink.push(issue);
          }
        } else {
          sink.push(QUICK_FAIL);
          return evaluated;
        }
      } else if (need) {
        for (const k of valid) extend(evaluated, this.evaluatedOf(any[k], v, unit));
      }
    }
    const one = o["oneOf"];
    if (Array.isArray(one)) {
      const valid: number[] = [];
      for (let k = 0; k < one.length; k++) if (this.valid(one[k], v, unit)) valid.push(k);
      if (valid.length === 1) {
        if (need) extend(evaluated, this.evaluatedOf(one[valid[0]!], v, unit));
      } else if (valid.length === 0) {
        if (sink.out !== null) {
          const p = render(ptr);
          if (requiredOnly(one)) {
            sink.push(new Issue(p, "exclusive", `exactly one of ${requiredNames(one)} is required`));
          } else {
            const results = one.map((sub) => this.errorsOf(sub, v, ptr, unit));
            for (const issue of bestAlternative(results, p)) sink.push(issue);
          }
        } else {
          sink.push(QUICK_FAIL);
          return evaluated;
        }
      } else {
        sink.err(ptr, "exclusive", () =>
          requiredOnly(one)
            ? `only one of ${requiredNames(one)} may be given`
            : "value matches more than one alternative",
        );
        if (sink.failed()) return evaluated;
      }
    }
    const cond = o["if"];
    if (cond !== undefined) {
      if (this.valid(cond, v, unit)) {
        if (need) extend(evaluated, this.evaluatedOf(cond, v, unit));
        const th = o["then"];
        if (th !== undefined) {
          const ev = this.check(th, v, ptr, unit, need, sink);
          if (sink.failed()) return evaluated;
          if (need) extend(evaluated, ev);
        }
      } else {
        const el = o["else"];
        if (el !== undefined) {
          const ev = this.check(el, v, ptr, unit, need, sink);
          if (sink.failed()) return evaluated;
          if (need) extend(evaluated, ev);
        }
      }
    }
    const up = o["unevaluatedProperties"];
    if (up !== undefined && isObject(v)) {
      for (const k of Object.keys(v)) {
        const val = v[k];
        if (val === undefined || evaluated.includes(k)) continue;
        if (up === false) {
          sink.err(keyPath(ptr, k), "unknown_property", () => `unknown property '${k}'`);
        } else {
          this.check(up, val, keyPath(ptr, k), false, false, sink);
        }
        if (sink.failed()) return evaluated;
        evaluated.push(k);
      }
    }
    return evaluated;
  }

  /** All errors of `v` against `s` (reporting path only). */
  errorsOf(s: unknown, v: unknown, ptr: Path, unit: boolean): Issue[] {
    const errs: Issue[] = [];
    this.check(s, v, ptr, unit, false, new Sink(errs));
    return errs;
  }
}

function requiredOnly(alts: unknown[]): boolean {
  return alts.every((a) => isObject(a) && Object.keys(a).length === 1 && hasOwnProperty.call(a, "required"));
}

function requiredNames(alts: unknown[]): string {
  return alts
    .map((a) => {
      const r = getKey(a, "required");
      return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string").join("+") : "";
    })
    .join(" | ");
}

/**
 * Choose the most plausible failed alternative: no type error at the location, no
 * discriminator (`type`/`shape`) mismatch, then the fewest errors; ties → first.
 */
function bestAlternative(results: Issue[][], ptr: string): Issue[] {
  const discType = ptrJoin(ptr, "type");
  const discShape = ptrJoin(ptr, "shape");
  let best: Issue[] | null = null;
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (const errs of results) {
    const rootType = errs.some((e) => e.pointer === ptr && e.code === "type") ? 1 : 0;
    const disc = errs.some(
      (e) => (e.pointer === discType || e.pointer === discShape) && (e.code === "const" || e.code === "enum"),
    )
      ? 1
      : 0;
    const n = errs.length;
    if (best === null || rootType < b0 || (rootType === b0 && (disc < b1 || (disc === b1 && n < b2)))) {
      best = errs;
      b0 = rootType;
      b1 = disc;
      b2 = n;
    }
  }
  return best ?? [];
}

// ---------------------------------------------------------------------------------------
// Semantic checks
// ---------------------------------------------------------------------------------------

function semantic(p: unknown, errors: Issue[], warnings: Issue[]): void {
  if (!isObject(p)) return;
  const root = p;
  const itemsValue = getKey(root, "items");
  const items = Array.isArray(itemsValue) ? itemsValue : null;
  // anchor type "line" is reserved for v2
  if (items !== null) {
    for (let i = 0; i < items.length; i++) {
      if (getPath(items[i], "anchor", "type") === "line") {
        const base = `/items/${i}/anchor`;
        const below = `${base}/`;
        let w = 0;
        for (const e of errors) if (e.pointer !== base && !e.pointer.startsWith(below)) errors[w++] = e;
        errors.length = w;
        errors.push(new Issue(`${base}/type`, "unsupported", "anchor type 'line' is reserved for v2"));
      }
    }
  }
  // ids
  const ids = new Map<string, number>();
  if (items !== null) {
    for (let i = 0; i < items.length; i++) {
      const v = getKey(items[i], "id");
      const [id, ptr] = typeof v === "string" ? [v, `/items/${i}/id`] : [String(i), `/items/${i}`];
      const first = ids.get(id);
      if (first !== undefined) {
        errors.push(new Issue(ptr, "duplicate_id", `id '${id}' is already used by item ${first}`));
      } else {
        ids.set(id, i);
      }
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const kw = getKey(it, "keep_with");
      if (Array.isArray(kw)) {
        for (let j = 0; j < kw.length; j++) {
          const r = kw[j];
          if (typeof r === "string" && !ids.has(r)) {
            errors.push(new Issue(`/items/${i}/keep_with/${j}`, "unknown_ref", `unknown item id '${r}'`));
          }
        }
      }
      // icon/box with shape polygon need polygon points
      const label = getKey(it, "label");
      checkPoly(label, `/items/${i}/label`, errors);
      const parts = getKey(label, "parts");
      if (Array.isArray(parts)) {
        for (let j = 0; j < parts.length; j++) checkPoly(parts[j], `/items/${i}/label/parts/${j}`, errors);
      }
      // area anchors must have a non-degenerate polygon
      if (getPath(it, "anchor", "type") === "area") {
        const poly = getPath(it, "anchor", "polygon");
        if (Array.isArray(poly)) {
          const xs: number[] = [];
          const ys: number[] = [];
          for (const q of poly) {
            if (Array.isArray(q) && typeof q[0] === "number" && typeof q[1] === "number") {
              xs.push(q[0]);
              ys.push(q[1]);
            }
          }
          const n = xs.length;
          let a = 0;
          for (let k = 0; k < n; k++) {
            const x0 = xs[k]!;
            const y0 = ys[k]!;
            const x1 = xs[(k + 1) % n]!;
            const y1 = ys[(k + 1) % n]!;
            a += x0 * y1 - x1 * y0;
          }
          if (n >= 3 && Math.abs(a) < 1e-12) {
            errors.push(new Issue(`/items/${i}/anchor/polygon`, "invalid_value", "area polygon has zero area"));
          }
        }
      }
    }
  }
  // expressions
  const checkExprAt = (ptr: string, v: unknown): void => {
    if (typeof v === "string") {
      const e = checkExpr(v);
      if (e !== null) errors.push(new Issue(ptr, e.code, e.message));
    }
  };
  const pr = getKey(root, "priority");
  if (pr !== undefined) {
    const tiers = getKey(pr, "tiers");
    if (Array.isArray(tiers)) {
      for (let i = 0; i < tiers.length; i++) checkExprAt(`/priority/tiers/${i}/where`, getKey(tiers[i], "where"));
    }
    const terms = getKey(pr, "terms");
    if (Array.isArray(terms)) {
      for (let i = 0; i < terms.length; i++) checkExprAt(`/priority/terms/${i}/expr`, getKey(terms[i], "expr"));
    }
    checkExprAt("/priority/coverage/by", getPath(pr, "coverage", "by"));
  }
  // y_axis "up" needs a canvas height (explicit or from a background)
  if (getKey(root, "y_axis") === "up" && getKey(root, "canvas") === undefined) {
    const hasBg = getPath(p, "obstacles", "raster") !== undefined || getPath(p, "obstacles", "svg") !== undefined;
    if (!hasBg) {
      errors.push(new Issue("/canvas", "required", "y_axis 'up' needs a canvas (or a background) to flip y"));
    }
  }
  // unknown classes in avoid → warnings
  const known = knownClasses(root);
  const av = getKey(root, "avoid");
  if (isObject(av)) {
    for (const section of ["label", "leader", "buffer"]) {
      const m = getKey(av, section);
      if (!isObject(m)) continue;
      for (const k of Object.keys(m)) {
        if (m[k] === undefined) continue;
        if (k === "*" || (section === "label" && k === "own_mark") || (section !== "buffer" && k === "lower_items") || known.has(k)) continue;
        warnings.push(
          new Issue(`/avoid/${section}/${ptrToken(k)}`, "unknown_class", `class '${k}' is not produced by any obstacle source`),
        );
      }
    }
    const rel = getKey(av, "relaxable");
    if (Array.isArray(rel)) {
      for (let i = 0; i < rel.length; i++) {
        const k = rel[i];
        if (typeof k === "string" && !known.has(k)) {
          warnings.push(new Issue(`/avoid/relaxable/${i}`, "unknown_class", `class '${k}' is not produced by any obstacle source`));
        }
      }
    }
  }
}

function checkPoly(lab: unknown, base: string, errors: Issue[]): void {
  if (getKey(lab, "shape") === "polygon" && getKey(lab, "polygon") === undefined) {
    errors.push(new Issue(`${base}/polygon`, "required", "shape 'polygon' needs 'polygon' points"));
  }
}

/** `Some(Value::Array(a))` → its elements, `Some(v @ Value::Object(_))` → `[v]`, else none. */
function oneOrMany(v: unknown): unknown[] {
  return Array.isArray(v) ? v : isObject(v) ? [v] : [];
}

/** Classes produced by the problem's obstacle sources, plus reserved classes. */
function knownClasses(root: JsonObject): Set<string> {
  const k = new Set<string>(RESERVED_CLASSES);
  const pv = getKey(root, "preset");
  const preset = typeof pv === "string" ? pv : "auto";
  const obs = getKey(root, "obstacles");
  if (obs !== undefined) {
    const layers = getKey(obs, "vector");
    if (Array.isArray(layers)) {
      for (const l of layers) {
        const c = getKey(l, "class");
        if (typeof c === "string") k.add(c);
      }
    }
    for (const s of oneOrMany(getKey(obs, "svg"))) {
      const rules = getKey(s, "classes");
      if (Array.isArray(rules)) {
        for (const r of rules) {
          const c = getKey(r, "class");
          if (typeof c === "string") k.add(c);
        }
      } else if (hasOwnProperty.call(PRESETS, preset)) {
        for (const r of PRESETS[preset]!.svg_classes) {
          const c = getKey(r, "class");
          if (typeof c === "string") k.add(c);
        }
      }
      const c = getKey(s, "default_class");
      if (typeof c === "string") k.add(c);
    }
    for (const r of oneOrMany(getKey(obs, "raster"))) {
      const c = getKey(r, "class");
      if (typeof c === "string") k.add(c);
      const cm = getKey(r, "classmap");
      if (isObject(cm)) {
        for (const key of Object.keys(cm)) {
          const x = cm[key];
          if (typeof x === "string") k.add(x);
        }
      }
    }
  }
  k.delete("ignore");
  return k;
}

// ---------------------------------------------------------------------------------------
// JSON text: `serde_json::from_str::<Value>`, errors included
// ---------------------------------------------------------------------------------------

/**
 * A syntax error of {@link parseJson}. `message` is serde_json's: the error text plus
 * ` at line L column C` (1-based line; column in UTF-8 bytes, as serde_json counts).
 */
export class JsonError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(reason: string, line: number, column: number) {
    super(`${reason} at line ${line} column ${column}`);
    this.name = "JsonError";
    this.line = line;
    this.column = column;
  }
}

const EOF_LIST = "EOF while parsing a list";
const EOF_OBJECT = "EOF while parsing an object";
const EOF_STRING = "EOF while parsing a string";
const EOF_VALUE = "EOF while parsing a value";
const EXPECTED_COLON = "expected `:`";
const EXPECTED_LIST_COMMA_OR_END = "expected `,` or `]`";
const EXPECTED_OBJECT_COMMA_OR_END = "expected `,` or `}`";
const EXPECTED_IDENT = "expected ident";
const EXPECTED_VALUE = "expected value";
const INVALID_ESCAPE = "invalid escape";
const INVALID_NUMBER = "invalid number";
const NUMBER_OUT_OF_RANGE = "number out of range";
const CONTROL_CHARACTER = "control character (\\u0000-\\u001F) found while parsing a string";
const KEY_MUST_BE_A_STRING = "key must be a string";
const LONE_LEADING_SURROGATE = "lone leading surrogate in hex escape";
const TRAILING_COMMA = "trailing comma";
const TRAILING_CHARACTERS = "trailing characters";
const UNEXPECTED_END_OF_HEX_ESCAPE = "unexpected end of hex escape";
const RECURSION_LIMIT_EXCEEDED = "recursion limit exceeded";

/**
 * Parse JSON text like `serde_json::from_str::<serde_json::Value>` with the workspace's
 * features (`preserve_order`, `float_roundtrip`): the same accepted language, the same
 * values (numbers correctly rounded; a later duplicate key replaces the value in place),
 * the 128-level nesting limit, and the same first error with the same position. Throws
 * {@link JsonError}. Text with lone surrogates (impossible in a Rust `&str`) is read as
 * its UTF-8 encoding with U+FFFD replacements.
 */
export function parseJson(text: string): unknown {
  const r = new JsonReader(text);
  const v = r.parseValue();
  // Deserializer::end
  if (r.parseWhitespace() >= 0) throw r.peekError(TRAILING_CHARACTERS);
  return v;
}

/** The exactly representable powers of ten. */
const POW10 = [1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];

function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}

function hexValue(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  return -1;
}

let UTF8_DECODER: TextDecoder | null = null;

/** A port of serde_json's `Deserializer<StrRead>` for `Value` (`de.rs`, `read.rs`). */
class JsonReader {
  private readonly text: string;
  private readonly bytes: Uint8Array;
  /** Byte offsets equal UTF-16 offsets (ASCII text): strings are sliced from `text`. */
  private readonly ascii: boolean;
  private index = 0;
  private remainingDepth = 128;

  constructor(text: string) {
    this.text = text;
    this.bytes = new TextEncoder().encode(text);
    this.ascii = this.bytes.length === text.length;
  }

  private peekByte(): number {
    return this.index < this.bytes.length ? this.bytes[this.index]! : -1;
  }

  /** `peek_or_null`. */
  private peekOrNull(): number {
    return this.index < this.bytes.length ? this.bytes[this.index]! : 0;
  }

  private nextByte(): number {
    return this.index < this.bytes.length ? this.bytes[this.index++]! : -1;
  }

  private positionError(reason: string, i: number): JsonError {
    let startOfLine = 0;
    for (let k = i - 1; k >= 0; k--) {
      if (this.bytes[k] === 0x0a) {
        startOfLine = k + 1;
        break;
      }
    }
    let line = 1;
    for (let k = 0; k < startOfLine; k++) if (this.bytes[k] === 0x0a) line++;
    return new JsonError(reason, line, i - startOfLine);
  }

  /** Error caused by a byte from `next` (`Deserializer::error`, `read::error`). */
  error(reason: string): JsonError {
    return this.positionError(reason, this.index);
  }

  /** Error caused by a byte from `peek` (`Deserializer::peek_error`). */
  peekError(reason: string): JsonError {
    return this.positionError(reason, Math.min(this.bytes.length, this.index + 1));
  }

  /** The first non-whitespace byte, not consumed (-1 at the end). */
  parseWhitespace(): number {
    for (;;) {
      const b = this.peekByte();
      if (b === 0x20 || b === 0x0a || b === 0x09 || b === 0x0d) this.index++;
      else return b;
    }
  }

  /** `deserialize_any` with serde_json's `ValueVisitor`. */
  parseValue(): unknown {
    const peek = this.parseWhitespace();
    if (peek < 0) throw this.peekError(EOF_VALUE);
    switch (peek) {
      case 0x6e: // n
        this.index++;
        this.parseIdent("ull");
        return null;
      case 0x74: // t
        this.index++;
        this.parseIdent("rue");
        return true;
      case 0x66: // f
        this.index++;
        this.parseIdent("alse");
        return false;
      case 0x2d: // -
        this.index++;
        return this.parseNumber(this.index - 1, false);
      case 0x22: // "
        this.index++;
        return this.parseStr();
      case 0x5b: {
        // [
        if (--this.remainingDepth === 0) throw this.peekError(RECURSION_LIMIT_EXCEEDED);
        this.index++;
        const seq = this.parseSeq();
        this.remainingDepth++;
        this.index++; // end_seq: the `]` that ended the sequence
        return seq;
      }
      case 0x7b: {
        // {
        if (--this.remainingDepth === 0) throw this.peekError(RECURSION_LIMIT_EXCEEDED);
        this.index++;
        const map = this.parseMap();
        this.remainingDepth++;
        this.index++; // end_map: the `}` that ended the map
        return map;
      }
      default:
        if (isDigit(peek)) return this.parseNumber(this.index, true);
        throw this.peekError(EXPECTED_VALUE);
    }
  }

  private parseIdent(ident: string): void {
    for (let i = 0; i < ident.length; i++) {
      const next = this.nextByte();
      if (next < 0) throw this.error(EOF_VALUE);
      if (next !== ident.charCodeAt(i)) throw this.error(EXPECTED_IDENT);
    }
  }

  /**
   * `parse_integer` and the decimal/exponent paths. With `float_roundtrip` the value is
   * the correctly rounded value of the literal (= `Number(literal)`); errors and their
   * positions follow serde_json, including the early `number out of range` when the
   * exponent overflows `i32` (`parse_exponent_overflow`).
   */
  private parseNumber(start: number, positive: boolean): number {
    const bytes = this.bytes;
    const n = bytes.length;
    let i = this.index;
    if (i >= n) throw this.error(EOF_VALUE);
    const first = bytes[i++]!;
    this.index = i;
    // fast path: up to 15 digits (an exact mantissa) and a power of ten up to 10^22
    let mant = 0;
    let digits = 0;
    let frac = 0;
    let zero: boolean;
    if (first === 0x30) {
      // There can be only one leading '0'.
      if (i < n && isDigit(bytes[i]!)) throw this.peekError(INVALID_NUMBER);
      zero = true;
    } else if (first >= 0x31 && first <= 0x39) {
      mant = first - 0x30;
      digits = 1;
      while (i < n && isDigit(bytes[i]!)) {
        if (++digits <= 15) mant = mant * 10 + (bytes[i]! - 0x30);
        i++;
      }
      this.index = i;
      zero = false;
    } else {
      throw this.error(INVALID_NUMBER);
    }
    let p = i < n ? bytes[i]! : 0;
    if (p === 0x2e) {
      // .
      i++;
      const begin = i;
      while (i < n && isDigit(bytes[i]!)) {
        const d = bytes[i]! - 0x30;
        if (d !== 0) zero = false;
        if (++digits <= 15) mant = mant * 10 + d;
        i++;
      }
      frac = i - begin;
      this.index = i;
      // Error if there is not at least one digit after the decimal point.
      if (frac === 0) throw this.peekError(i < n ? INVALID_NUMBER : EOF_VALUE);
      p = i < n ? bytes[i]! : 0;
    }
    let exp10 = 0;
    if (p === 0x65 || p === 0x45) {
      // e E
      this.index = ++i;
      let positiveExp = true;
      const sign = i < n ? bytes[i]! : 0;
      if (sign === 0x2b) {
        this.index = ++i;
      } else if (sign === 0x2d) {
        this.index = ++i;
        positiveExp = false;
      }
      const next = this.nextByte();
      if (next < 0) throw this.error(EOF_VALUE);
      if (!isDigit(next)) throw this.error(INVALID_NUMBER);
      let exp = next - 0x30;
      while (isDigit(this.peekOrNull())) {
        const digit = bytes[this.index++]! - 0x30;
        if (exp >= 214748364 && (exp > 214748364 || digit > 7)) {
          // parse_exponent_overflow: error instead of +/- infinity
          if (!zero && positiveExp) throw this.error(NUMBER_OUT_OF_RANGE);
          while (isDigit(this.peekOrNull())) this.index++;
          return positive ? 0 : -0;
        }
        exp = exp * 10 + digit;
      }
      exp10 = positiveExp ? exp : -exp;
    }
    if (digits <= 15) {
      const e = exp10 - frac;
      if (e >= -22 && e <= 22) {
        // one correctly rounded operation on exact operands
        const x = e >= 0 ? mant * POW10[e]! : mant / POW10[-e]!;
        return positive ? x : -x;
      }
    }
    const x = Number(this.slice(start, this.index));
    if (!Number.isFinite(x)) throw this.error(NUMBER_OUT_OF_RANGE);
    return x;
  }

  private slice(a: number, b: number): string {
    if (a === b) return "";
    if (this.ascii) return this.text.slice(a, b);
    // ignoreBOM: keep a U+FEFF at the start of a string (the default drops it)
    if (UTF8_DECODER === null) UTF8_DECODER = new TextDecoder("utf-8", { ignoreBOM: true });
    return UTF8_DECODER.decode(this.bytes.subarray(a, b));
  }

  /** `SliceRead::parse_str_bytes` with validation (after the opening quote). */
  private parseStr(): string {
    const bytes = this.bytes;
    const n = bytes.length;
    let start = this.index;
    let scratch = "";
    for (;;) {
      // skip_to_escape
      let i = this.index;
      while (i < n) {
        const b = bytes[i]!;
        if (b === 0x22 || b === 0x5c || b < 0x20) break;
        i++;
      }
      this.index = i;
      if (i === n) throw this.error(EOF_STRING);
      const b = bytes[i]!;
      if (b === 0x22) {
        const s = this.slice(start, i);
        this.index = i + 1;
        return scratch.length === 0 ? s : scratch + s;
      }
      if (b === 0x5c) {
        scratch += this.slice(start, i);
        this.index = i + 1;
        scratch += this.parseEscape();
        start = this.index;
      } else {
        this.index = i + 1;
        throw this.error(CONTROL_CHARACTER);
      }
    }
  }

  /** `parse_escape` (after the backslash). */
  private parseEscape(): string {
    const ch = this.nextByte();
    if (ch < 0) throw this.error(EOF_STRING);
    switch (ch) {
      case 0x22:
        return '"';
      case 0x5c:
        return "\\";
      case 0x2f:
        return "/";
      case 0x62:
        return "\b";
      case 0x66:
        return "\f";
      case 0x6e:
        return "\n";
      case 0x72:
        return "\r";
      case 0x74:
        return "\t";
      case 0x75:
        return this.parseUnicodeEscape();
      default:
        throw this.error(INVALID_ESCAPE);
    }
  }

  /** `parse_unicode_escape` with validation (after `\u`). */
  private parseUnicodeEscape(): string {
    const n = this.decodeHexEscape();
    if (n >= 0xdc00 && n <= 0xdfff) throw this.error(LONE_LEADING_SURROGATE);
    if (n < 0xd800 || n > 0xdbff) return String.fromCharCode(n);
    // n is a leading surrogate, we now expect a trailing surrogate.
    if (this.peekOrEof() !== 0x5c) {
      this.index++;
      throw this.error(UNEXPECTED_END_OF_HEX_ESCAPE);
    }
    this.index++;
    if (this.peekOrEof() !== 0x75) {
      this.index++;
      throw this.error(UNEXPECTED_END_OF_HEX_ESCAPE);
    }
    this.index++;
    const n2 = this.decodeHexEscape();
    if (n2 < 0xdc00 || n2 > 0xdfff) throw this.error(LONE_LEADING_SURROGATE);
    return String.fromCharCode(n, n2);
  }

  private peekOrEof(): number {
    const b = this.peekByte();
    if (b < 0) throw this.error(EOF_STRING);
    return b;
  }

  private decodeHexEscape(): number {
    if (this.bytes.length - this.index < 4) {
      this.index = this.bytes.length;
      throw this.error(EOF_STRING);
    }
    const i = this.index;
    const a = hexValue(this.bytes[i]!);
    const b = hexValue(this.bytes[i + 1]!);
    const c = hexValue(this.bytes[i + 2]!);
    const d = hexValue(this.bytes[i + 3]!);
    this.index = i + 4;
    if (a < 0 || b < 0 || c < 0 || d < 0) throw this.error(INVALID_ESCAPE);
    return (a << 12) | (b << 8) | (c << 4) | d;
  }

  /** `visit_seq` over `SeqAccess` (after `[`; stops before the closing `]`). */
  private parseSeq(): unknown[] {
    const out: unknown[] = [];
    let first = true;
    for (;;) {
      // has_next_element
      const peek = this.parseWhitespace();
      if (peek < 0) throw this.peekError(EOF_LIST);
      if (peek === 0x5d) return out;
      if (first) {
        first = false;
      } else if (peek === 0x2c) {
        this.index++;
        const next = this.parseWhitespace();
        if (next === 0x5d) throw this.peekError(TRAILING_COMMA);
        if (next < 0) throw this.peekError(EOF_VALUE);
      } else {
        throw this.peekError(EXPECTED_LIST_COMMA_OR_END);
      }
      out.push(this.parseValue());
    }
  }

  /** `visit_map` over `MapAccess` (after `{`; stops before the closing `}`). */
  private parseMap(): JsonObject {
    const out: JsonObject = {};
    let first = true;
    for (;;) {
      // has_next_key
      const peek = this.parseWhitespace();
      if (peek < 0) throw this.peekError(EOF_OBJECT);
      if (peek === 0x7d) return out;
      if (first) {
        first = false;
        if (peek !== 0x22) throw this.peekError(KEY_MUST_BE_A_STRING);
      } else if (peek === 0x2c) {
        this.index++;
        const next = this.parseWhitespace();
        if (next === 0x7d) throw this.peekError(TRAILING_COMMA);
        if (next < 0) throw this.peekError(EOF_VALUE);
        if (next !== 0x22) throw this.peekError(KEY_MUST_BE_A_STRING);
      } else {
        throw this.peekError(EXPECTED_OBJECT_COMMA_OR_END);
      }
      // MapKey: the opening quote, then the string
      this.index++;
      const key = this.parseStr();
      // parse_object_colon
      const colon = this.parseWhitespace();
      if (colon < 0) throw this.peekError(EOF_OBJECT);
      if (colon !== 0x3a) throw this.peekError(EXPECTED_COLON);
      this.index++;
      const value = this.parseValue();
      if (key === "__proto__") {
        Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
      } else {
        out[key] = value;
      }
    }
  }
}
