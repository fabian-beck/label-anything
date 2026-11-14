/** Small helpers: problem merging (the engine's merge rule), dotted paths, random numbers, rings, warm starts. */
import type { LabelResult } from "@label-anything/core";

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
/** Rounded to two decimals: coordinates as they go into a problem. */
export const round2 = (v: number): number => Math.round(v * 100) / 100;
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

type Ring = readonly (readonly [number, number])[];

/** Signed area of a ring (shoelace formula). */
export function ringArea(r: Ring): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j]![0] * r[i]![1] - r[i]![0] * r[j]![1];
  return s / 2;
}

/** Whether `p` is inside a ring (even-odd rule). */
export function inRing(p: readonly [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** What `warm_start` needs of a placement: the box, where it was placed for, its leader. */
export function warmPlacement(p: LabelResult["placements"][number]): Obj {
  const out: Obj = { id: p.id, placed: p.placed };
  if (p.placed && p.box) {
    out.box = p.box;
    if (p.anchor) out.anchor = p.anchor;
    if (p.leader) out.leader = { points: p.leader.points, style: p.leader.style };
  }
  return out;
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
