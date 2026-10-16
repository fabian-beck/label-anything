/**
 * Effective options: `spec/defaults.md` ← preset ← problem (spec §2.4).
 *
 * Port of `rust/crates/la-core/src/options.rs`. JSON values are plain JavaScript values
 * (`null`, booleans, numbers, strings, arrays, plain objects). An object property whose
 * value is `undefined` counts as absent, as `JSON.stringify` would drop it. Where Rust
 * returns `Option<&Value>`, these functions return `undefined` for "absent", because JSON
 * `null` is a value of its own (`user_sets` tells an explicit `null` from a missing key).
 */
import { DEFAULTS, PRESETS, type PresetData } from "./generated/spec-data.js";
import { Length } from "./units.js";

type JsonObject = Record<string, unknown>;

const hasOwnProperty = Object.prototype.hasOwnProperty;

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Own property `k` of `o` (`undefined` if absent; never reads the prototype chain). */
function own(o: JsonObject, k: string): unknown {
  return hasOwnProperty.call(o, k) ? o[k] : undefined;
}

/** `o[k] = v` that also works for the key `__proto__`. */
function setOwn(o: JsonObject, k: string, v: unknown): void {
  if (k === "__proto__") {
    Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
  } else {
    o[k] = v;
  }
}

/** A deep copy of a JSON value (`Value::clone`). */
function cloneJson(v: unknown): unknown {
  if (Array.isArray(v)) {
    const out = new Array<unknown>(v.length);
    for (let i = 0; i < v.length; i++) out[i] = cloneJson(v[i]);
    return out;
  }
  if (isObject(v)) {
    const out: JsonObject = {};
    for (const k of Object.keys(v)) {
      const x = v[k];
      if (x !== undefined) setOwn(out, k, cloneJson(x));
    }
    return out;
  }
  return v === undefined ? null : v;
}

/** The defaults table as a flat map from dotted key to JSON value. */
export function defaults(): Readonly<Record<string, unknown>> {
  return DEFAULTS;
}

/** A preset by name (`null` if unknown). */
export function preset(name: string): PresetData | null {
  return hasOwnProperty.call(PRESETS, name) ? (PRESETS[name] as PresetData) : null;
}

/** Deep merge: objects merge recursively, everything else in `over` replaces `base`. */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (isObject(base) && isObject(over)) {
    const out = cloneJson(base) as JsonObject;
    for (const k of Object.keys(over)) {
      const v = over[k];
      if (v === undefined) continue;
      const old = own(out, k);
      setOwn(out, k, old !== undefined ? deepMerge(old, v) : cloneJson(v));
    }
    return out;
  }
  return cloneJson(over);
}

/** Look up a dotted path in a JSON value (`undefined` if absent). */
export function lookup(v: unknown, key: string): unknown {
  let cur = v;
  for (const part of key.split(".")) {
    if (!isObject(cur)) return undefined;
    cur = own(cur, part);
    if (cur === undefined) return undefined;
  }
  return cur;
}

/**
 * Top-level problem keys that hold data rather than options. They are never looked up
 * through {@link Opts}, so they are not copied into the merged options.
 */
export const DATA_KEYS: readonly string[] = ["items", "obstacles", "warm_start"];

/** Effective options of one problem. */
export class Opts {
  /**
   * The problem's option sections (without {@link DATA_KEYS}) with the preset's options
   * merged underneath.
   */
  merged: unknown;
  presetName: string;
  preset: PresetData | null;
  /** Which implementation's per-implementation defaults apply ("rust" or "ts"). */
  implementation: "rust" | "ts";

  constructor(problem: unknown) {
    const requested = isObject(problem) ? own(problem, "preset") : undefined;
    let name: string;
    if (typeof requested === "string") {
      name = requested;
    } else {
      const d = own(DEFAULTS as JsonObject, "preset");
      name = typeof d === "string" ? d : "auto";
    }
    const p = preset(name);
    let options: unknown;
    if (isObject(problem)) {
      const m: JsonObject = {};
      for (const k of Object.keys(problem)) {
        const v = problem[k];
        if (v !== undefined && !DATA_KEYS.includes(k)) setOwn(m, k, cloneJson(v));
      }
      options = m;
    } else {
      options = cloneJson(problem);
    }
    const presetOptions = p !== null ? own(p as unknown as JsonObject, "options") : undefined;
    this.merged = presetOptions !== undefined ? deepMerge(presetOptions, options) : options;
    this.presetName = name;
    this.preset = p;
    this.implementation = "ts";
  }

  /** The explicitly given value (problem or preset) at `key` (`undefined` if absent or `null`). */
  given(key: string): unknown {
    const v = lookup(this.merged, key);
    return v === null ? undefined : v;
  }

  /** Whether the *problem itself* (not the preset) sets `key` (an explicit `null` counts). */
  userSets(problem: unknown, key: string): boolean {
    return lookup(problem, key) !== undefined;
  }

  /**
   * Effective value: given value, else the default (resolving per-implementation
   * defaults), else `null`. A given value is returned as stored in {@link merged} (not
   * copied); defaults are fresh copies.
   */
  get(key: string): unknown {
    const v = this.given(key);
    if (v !== undefined) return v;
    return defaultOf(key, this.implementation);
  }

  f64(key: string): number {
    const v = this.get(key);
    return typeof v === "number" ? v : 0;
  }
  bool(key: string): boolean {
    const v = this.get(key);
    return typeof v === "boolean" ? v : false;
  }
  string(key: string): string {
    const v = this.get(key);
    return typeof v === "string" ? v : "";
  }
  length(key: string): Length {
    return Length.fromValue(this.get(key)) ?? Length.Px(0);
  }
  strings(key: string): string[] {
    const v = this.get(key);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  }
  numbers(key: string): number[] {
    const v = this.get(key);
    return Array.isArray(v) ? v.filter((s): s is number => typeof s === "number") : [];
  }

  /** A class-keyed map: the default map overlaid with the given map, per key. */
  map(key: string): Record<string, unknown> {
    const d = defaultOf(key, this.implementation);
    const out: JsonObject = isObject(d) ? d : {};
    const m = this.given(key);
    if (isObject(m)) {
      for (const k of Object.keys(m)) {
        const v = m[k];
        if (v !== undefined) setOwn(out, k, cloneJson(v));
      }
    }
    return out;
  }
}

/**
 * The default for `key` (a fresh copy, `null` if there is none), with per-implementation
 * values (`{"rust": .., "ts": ..}`) resolved.
 */
export function defaultOf(key: string, implementation: string): unknown {
  const v = own(DEFAULTS as JsonObject, key);
  if (v === undefined) return null;
  if (isObject(v) && hasOwnProperty.call(v, "rust") && hasOwnProperty.call(v, "ts")) {
    const x = own(v, implementation);
    return x === undefined ? null : cloneJson(x);
  }
  return cloneJson(v);
}

/**
 * Look up an option of a source object (vector layer, svg or raster source): the
 * object's own value at `key`, else the default at `<prefix>.<key>`.
 */
export function sourceOpt(src: unknown, prefix: string, key: string): unknown {
  const v = lookup(src, key);
  if (v !== undefined && v !== null) return cloneJson(v);
  return defaultOf(`${prefix}.${key}`, "ts");
}
