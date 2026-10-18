/** Small helpers: problem merging (the engine's merge rule), dotted paths, random numbers. */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Obj = Record<string, unknown>;

export function isObject(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `b` merged into `a` as the engine merges presets and problems: objects recursively,
 * arrays and scalars replace. `undefined` in `b` leaves `a`'s value. Neither input changes.
 */
export function merge<T>(a: T, b: unknown): T {
  if (b === undefined) return a;
  if (!isObject(a) || !isObject(b)) return b as T;
  const out: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v);
  return out as T;
}

export function mergeAll<T>(...parts: unknown[]): T {
  return parts.reduce<unknown>((acc, p) => merge(acc, p), {}) as T;
}

/** The value at a dotted path (`"leaders.style"`), or `undefined`. */
export function getPath(o: unknown, path: string): unknown {
  let cur: unknown = o;
  for (const k of path.split(".")) {
    if (!isObject(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** A copy of `o` with `value` at `path` (`undefined` deletes it, and empty parents). */
export function setPath<T extends Obj>(o: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  const out: Obj = { ...o };
  if (rest.length === 0) {
    if (value === undefined) delete out[head!];
    else out[head!] = value;
    return out as T;
  }
  const child = setPath(isObject(out[head!]) ? (out[head!] as Obj) : {}, rest.join("."), value);
  if (Object.keys(child).length === 0) delete out[head!];
  else out[head!] = child;
  return out as T;
}

/** Deep structural equality of JSON-like values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ka = Object.keys(a as Obj);
  const kb = Object.keys(b as Obj);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Obj)[k], (b as Obj)[k]));
}

/** Seeded random numbers in [0, 1) (mulberry32). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal from a uniform source (Box–Muller). */
export function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** `"0.2em"` → 0.2; numbers pass through; anything else → `fallback`. */
export function emValue(v: unknown, fallback: number): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const m = /^(-?[0-9.]+)em$/.exec(v);
    if (m) return Number(m[1]);
  }
  return fallback;
}

/** Thousands separators and a few significant digits. */
export function fmt(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return "–";
  if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString("en-US");
  return v.toFixed(digits).replace(/\.0+$/, "");
}

/** Compact large numbers: 1.4 B, 38 M, 920 k. */
export function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(a >= 1e10 ? 0 : 1)} B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)} M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)} k`;
  return String(Math.round(v));
}

/** Base64url of UTF-8 text (for the share link) and back. */
export function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Syllable names ("Kavori", "Telmas"): readable labels of varying length for generated data. */
export function nameGen(r: () => number): () => string {
  const on = ["b", "c", "d", "f", "g", "h", "k", "l", "m", "n", "p", "r", "s", "t", "v", "z", "br", "dr", "gl", "kr", "st", "th", "tr"];
  const nu = ["a", "e", "i", "o", "u", "a", "e", "o", "ai", "ea", "io"];
  const co = ["", "", "", "n", "r", "s", "l", "x", "m"];
  const used = new Set<string>();
  return () => {
    for (let attempt = 0; ; attempt++) {
      const n = 2 + Math.floor(r() * (r() < 0.25 ? 3 : 2));
      let w = "";
      for (let i = 0; i < n; i++) w += on[Math.floor(r() * on.length)]! + nu[Math.floor(r() * nu.length)]!;
      w += co[Math.floor(r() * co.length)]!;
      w = w[0]!.toUpperCase() + w.slice(1);
      if (!used.has(w) || attempt > 20) {
        used.add(w);
        return w;
      }
    }
  };
}
