// Port of `mutated_problems_never_panic` (rust/crates/label-anything/tests/fuzz_smoke.rs):
// deterministic mutation fuzzing of problem JSON. Every input must give a result or a
// structured error: `validate` returns a report, `place` returns a result or throws a
// `PlaceError`; any other exception (a TypeError, a RangeError from an impossible
// allocation, a stack overflow) is a bug. Seeds are the conformance problems, half of
// them mutated structurally (mostly well-formed problems), the rest byte-level mutations;
// the generator has a fixed seed, so failures reproduce. LA_FUZZ_CASES sets the number
// of mutated inputs (default 300; the Rust test runs 1500), LA_FUZZ_SEED (default 0)
// offsets the generator seeds to explore other mutations.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PlaceError } from "../src/api.js";
import { BasicEnv } from "../src/env.js";
import { placeWith, validate } from "../src/place.js";

const MASK = (BigInt(1) << BigInt(64)) - BigInt(1);

/** SplitMix64, as in the Rust test. */
class Rng {
  private s: bigint;
  constructor(seed: number) {
    this.s = BigInt(seed);
  }
  next(): bigint {
    this.s = (this.s + BigInt("0x9E3779B97F4A7C15")) & MASK;
    let z = this.s;
    z = ((z ^ (z >> BigInt(30))) * BigInt("0xBF58476D1CE4E5B9")) & MASK;
    z = ((z ^ (z >> BigInt(27))) * BigInt("0x94D049BB133111EB")) & MASK;
    return z ^ (z >> BigInt(31));
  }
  below(n: number): number {
    return n === 0 ? 0 : Number(this.next() % BigInt(n));
  }
  byte(): number {
    return Number(this.next() & BigInt(0xff));
  }
}

const enc = new TextEncoder();
const INTERESTING = [
  "0",
  "-0",
  "1e308",
  "-1e308",
  "1e-320",
  "4294967296",
  "-1",
  "null",
  "true",
  '""',
  "[]",
  "{}",
  '"\\u0000é😀"',
  "9007199254740993",
].map((t) => enc.encode(t));

/** One random byte-level mutation (bit flips, deletions, duplications, splices, tokens). */
function mutate(rng: Rng, data: Uint8Array, other: Uint8Array): Uint8Array {
  let v = Array.from(data);
  for (let m = 1 + rng.below(4); m > 0; m--) {
    const n = v.length;
    const op = rng.below(7);
    if (op === 0 && n > 0) {
      const i = rng.below(n);
      v[i] = v[i]! ^ (1 << rng.below(8));
    } else if (op === 1 && n > 0) {
      const i = rng.below(n);
      const len = 1 + rng.below(Math.min(n - i, 64));
      v.splice(i, len);
    } else if (op === 2 && n > 0) {
      const i = rng.below(n);
      const len = 1 + rng.below(Math.min(n - i, 64));
      const chunk = v.slice(i, i + len);
      v.splice(rng.below(v.length + 1), 0, ...chunk);
    } else if (op === 3 && other.length > 0) {
      const i = rng.below(other.length);
      const len = 1 + rng.below(Math.min(other.length - i, 256));
      v.splice(rng.below(v.length + 1), 0, ...other.subarray(i, i + len));
    } else if (op === 4) {
      // replace a run of bytes with an interesting token
      const tok = INTERESTING[rng.below(INTERESTING.length)]!;
      const at = rng.below(v.length + 1);
      const end = Math.min(at + rng.below(6), v.length);
      v.splice(at, end - at, ...tok);
    } else if (op === 5 && n > 0) {
      v = v.slice(0, rng.below(n));
    } else {
      v.splice(rng.below(v.length + 1), 0, rng.byte());
    }
  }
  return Uint8Array.from(v);
}

/** Schema words, so that structural mutations produce mostly well-formed problems. */
const WORDS = [
  "point", "area", "circle", "ellipse", "rect", "polygon", "path", "icon", "from_svg", "text",
  "box", "composite", "hard", "ignore", "adjacent", "slider", "distant", "boundary", "internal",
  "straight", "angles", "orthogonal", "elbow", "curved", "strict", "prefix", "weighted", "greedy",
  "local", "auto", "points", "lines", "ink", "labels", "items", "em", "2em", "3pt", "M0 0L5 5Z",
  "x + 1",
];
const KEYS = [
  "x", "y", "r", "w", "h", "rx", "ry", "rotation", "points", "polygon", "holes", "mark", "label",
  "text", "font", "size", "wrap", "max_width", "priority", "tier", "required", "group", "keep_with",
  "padding",
];

function interestingNumber(rng: Rng): number {
  switch (rng.below(10)) {
    case 0:
      return 0;
    case 1:
      return -1;
    case 2:
      return 1e308;
    case 3:
      return -1e308;
    case 4:
      return 1e-310;
    case 5:
      return 4294967296;
    case 6:
      return -0;
    case 7:
      return 0.5;
    case 8:
      return 1e6;
    default:
      return rng.below(1000) - 500;
  }
}

function randomValue(rng: Rng): unknown {
  switch (rng.below(8)) {
    case 0:
      return null;
    case 1:
      return rng.below(2) === 0;
    case 2:
    case 3:
      return interestingNumber(rng);
    case 4:
    case 5:
      return WORDS[rng.below(WORDS.length)];
    case 6:
      return [interestingNumber(rng), interestingNumber(rng)];
    default:
      return {};
  }
}

type Json = unknown;

/** One structural mutation of a JSON value: replace, delete, duplicate or insert (returns the new value). */
function mutateJson(rng: Rng, v: Json, depth: number): Json {
  const descend = depth < 12 && rng.below(4) !== 0;
  if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0) {
    const m = v as Record<string, Json>;
    const keys = Object.keys(m);
    const k = keys[rng.below(keys.length)]!;
    if (descend) m[k] = mutateJson(rng, m[k], depth + 1);
    else {
      const op = rng.below(3);
      if (op === 0) delete m[k];
      else if (op === 1) m[KEYS[rng.below(KEYS.length)]!] = randomValue(rng);
      else m[k] = randomValue(rng);
    }
    return m;
  }
  if (Array.isArray(v) && v.length > 0) {
    const i = rng.below(v.length);
    if (descend) v[i] = mutateJson(rng, v[i], depth + 1);
    else {
      const op = rng.below(4);
      if (op === 0) v.splice(i, 1);
      else if (op === 1) {
        for (let n = 1 + rng.below(3); n > 0; n--) v.splice(i, 0, structuredClone(v[i]));
      } else if (op === 2) v.reverse();
      else v[i] = randomValue(rng);
    }
    return v;
  }
  return randomValue(rng);
}

/** Keeps a mutated problem's run time bounded (budgets and sizes are not under test). */
function bound(v: Json): void {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return;
  const o = v as Record<string, Json>;
  if (o.solver === undefined) o.solver = {};
  const s = o.solver;
  if (s !== null && typeof s === "object" && !Array.isArray(s)) {
    const so = s as Record<string, Json>;
    so.time_budget_ms = 50;
    so.max_iterations = 2000;
    if (so.strategy === "exact") so.strategy = "local";
  }
}

const envInt = (name: string, d: number): number => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= 0 ? n : d;
};
const CASES = envInt("LA_FUZZ_CASES", 300);
const SEED = envInt("LA_FUZZ_SEED", 0);
const PROBLEMS = fileURLToPath(new URL("../../../../conformance/problems/", import.meta.url));

/** The seeds and mutated inputs (deterministic). */
function inputs(): Uint8Array[] {
  const texts = readdirSync(PROBLEMS)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readFileSync(join(PROBLEMS, f)));
  const rng = new Rng(7 + SEED);
  const seeds: Uint8Array[] = texts.map((t) => new Uint8Array(t));
  for (let k = 0; k < Math.floor(CASES / 2); k++) {
    let v: Json = JSON.parse(new TextDecoder().decode(texts[k % texts.length]));
    for (let n = 1 + rng.below(3); n > 0; n--) v = mutateJson(rng, v, 0);
    seeds.push(enc.encode(JSON.stringify(v)));
  }
  const out = seeds.slice();
  const r2 = new Rng(1 + SEED);
  for (let k = 0; k < CASES; k++) {
    const a = seeds[r2.below(seeds.length)]!;
    const b = seeds[r2.below(seeds.length)]!;
    out.push(mutate(r2, a, b));
  }
  return out;
}

const dec = new TextDecoder("utf-8", { fatal: true });

/** Runs one input; returns a failure description or null. Counts valid JSON and solved inputs. */
function runOne(bytes: Uint8Array, counts: { json: number; solved: number }): string | null {
  let text: string;
  try {
    text = dec.decode(bytes);
  } catch {
    return null; // not UTF-8: skipped, as in Rust
  }
  let v: Json;
  try {
    v = JSON.parse(text);
  } catch {
    try {
      placeWith(text, new BasicEnv());
      return "unparsable JSON was solved";
    } catch (e) {
      return e instanceof PlaceError ? null : `place(text): ${String(e)}`;
    }
  }
  counts.json++;
  bound(v);
  try {
    validate(v);
  } catch (e) {
    return `validate: ${String(e)}`;
  }
  try {
    placeWith(v, new BasicEnv());
    counts.solved++;
  } catch (e) {
    if (!(e instanceof PlaceError)) return `place: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
  }
  return null;
}

describe("fuzz smoke (mutated problems)", () => {
  const all = inputs();
  const counts = { json: 0, solved: 0 };
  const CHUNK = 50;
  for (let start = 0; start < all.length; start += CHUNK) {
    it(`mutated_problems_never_crash: inputs ${start}..${Math.min(start + CHUNK, all.length)}`, { timeout: 300_000 }, () => {
      const failures: string[] = [];
      for (let k = start; k < Math.min(start + CHUNK, all.length); k++) {
        const f = runOne(all[k]!, counts);
        if (f !== null) failures.push(`input ${k}: ${f.slice(0, 600)}\n  ${new TextDecoder().decode(all[k]!).slice(0, 300)}`);
      }
      expect(failures).toEqual([]);
    });
  }
  it("the mutations reach the solver", () => {
    expect(counts.json).toBeGreaterThan(CASES / 3);
    expect(counts.solved).toBeGreaterThan(CASES / 20);
  });
});
