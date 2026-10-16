// Port of rust/crates/la-core/tests/random_problems.rs (property test): random problems
// (several priority bands, obstacles, leaders, composite labels, groups) must always
// solve with 0 hard violations, 0 priority inversions and 0 leader crossings,
// deterministically. The solver's own verification would *repair* a violation (and
// report it), so any non-zero count here is a solver bug.
//
// When the Rust CLI has been built (`cargo build --release -p label-anything-cli`), the
// first seeds are also solved by it (without a clock) and the results must be identical.
// LA_RANDOM_CASES (default 150) and LA_RANDOM_PARITY (default 40) set the counts.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BasicEnv } from "../src/env.js";
import { placeWith } from "../src/place.js";
import { jsonDiff, withoutTiming } from "./parity-util.js";

const MASK = (BigInt(1) << BigInt(64)) - BigInt(1);

/** Small deterministic generator (SplitMix64), as in the Rust test. */
export class Rng {
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
  f(): number {
    return Number(this.next() >> BigInt(11)) / 9007199254740992;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.f();
  }
  below(n: number): number {
    return Number(this.next() % BigInt(n));
  }
}

const WORDS = [
  "Alpha",
  "Beta",
  "Gamma",
  "Delta",
  "Epsilon",
  "Zeta",
  "Eta",
  "Theta",
  "Iota",
  "Kappa",
  "org.example.Name",
  "A much longer label",
];

/** The random problem of `seed` (the same JSON as the Rust test builds). */
export function problem(seed: number): Record<string, unknown> {
  const r = new Rng(seed);
  const w = r.range(200, 500);
  const h = r.range(150, 400);
  const n = 5 + r.below(40);
  const clustered = r.below(2) === 0;
  const cx = w * 0.5;
  const cy = h * 0.5;
  const items: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    let x: number;
    let y: number;
    if (clustered) {
      x = cx + r.range(-60, 60);
      y = cy + r.range(-45, 45);
    } else {
      x = r.range(0, w);
      y = r.range(0, h);
    }
    const text = WORDS[r.below(WORDS.length)]!;
    let label: Record<string, unknown>;
    switch (r.below(6)) {
      case 0:
        label = {
          type: "composite",
          gap: 2,
          parts: [
            { type: "icon", width: 9, height: 9, shape: "circle" },
            { type: "text", text },
          ],
        };
        break;
      case 1:
        label = { type: "text", text, wrap: { max_width: 40, max_lines: 2 } };
        break;
      case 2: {
        const width = r.range(8, 40);
        const height = r.range(6, 20);
        label = { type: "box", width, height };
        break;
      }
      default:
        label = { type: "text", text };
    }
    // few distinct scores: several items per priority band
    const item: Record<string, unknown> = {
      id: `i${i}`,
      anchor: { type: "point", x, y },
      label,
      priority: r.below(4),
    };
    if (r.below(10) === 0) item.required = true;
    if (r.below(12) === 0) item.tier = 1;
    items.push(item);
  }
  const points: number[][] = [];
  const np = r.below(200);
  for (let k = 0; k < np; k++) {
    const px = r.range(0, w);
    const py = r.range(0, h);
    points.push([px, py]);
  }
  const rects: number[][] = [];
  const nr = r.below(4);
  for (let k = 0; k < nr; k++) {
    const a = r.range(0, w);
    const b = r.range(0, h);
    const c = r.range(5, 60);
    const d = r.range(5, 60);
    rects.push([a, b, c, d]);
  }
  const vector: Record<string, unknown>[] = [
    { class: "points", points, r: 1.5 },
    { class: "walls", rects },
  ];
  if (r.below(3) === 0) {
    const y0 = r.range(0, h);
    const y1 = r.range(0, h);
    vector.push({ class: "lines", polylines: [[[0, y0], [w, y1]]], width: 1.5 });
  }
  const models = [
    ["adjacent", "slider"],
    ["adjacent", "slider", "distant"],
    ["adjacent", "slider", "boundary"],
    ["adjacent", "slider", "distant", "boundary"],
  ][r.below(4)]!;
  const style = ["straight", "angles", "orthogonal", "elbow", "curved"][r.below(5)]!;
  const omission = ["strict", "strict", "prefix", "weighted"][r.below(4)]!;
  const strategy = ["greedy", "local", "auto"][r.below(3)]!;
  return {
    canvas: { width: w, height: h, padding: 2 },
    items,
    obstacles: { vector },
    avoid: { label: { walls: "hard", points: 0.3, lines: 1.0 } },
    placement: { models },
    leaders: { style },
    priority: { omission },
    solver: { strategy, time_budget_ms: 200, max_iterations: 3000 },
  };
}

const envInt = (name: string, d: number): number => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v >= 0 ? v : d;
};
const CASES = envInt("LA_RANDOM_CASES", 150);
const PARITY = envInt("LA_RANDOM_PARITY", 40);

const BIN = fileURLToPath(new URL("../../../../rust/target/release/label-anything", import.meta.url));
const HAS_CLI = existsSync(BIN);

/** The Rust CLI's result without a clock (null if this build lacks `--no-clock`). */
function rustResult(p: unknown): unknown {
  try {
    const out = execFileSync(BIN, ["place", "-", "--no-clock"], { input: JSON.stringify(p), maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "pipe"] });
    return JSON.parse(out.toString());
  } catch (e) {
    const msg = String((e as { stderr?: unknown }).stderr ?? e);
    if (msg.includes("--no-clock")) return null;
    throw e;
  }
}

describe("random_problems", () => {
  type Stats = Record<string, unknown>;
  for (let seed = 0; seed < CASES; seed++) {
    it(`random_problems_keep_the_guarantees: seed ${seed}`, () => {
      const p = problem(seed);
      const r = placeWith(p, new BasicEnv()) as unknown as { placements: unknown; stats: Stats };
      const failures: string[] = [];
      for (const k of ["hard_violations", "priority_inversions", "leader_crossings"]) {
        if (r.stats[k] !== 0) failures.push(`seed ${seed}: ${k} = ${String(r.stats[k])}`);
      }
      const r2 = placeWith(p, new BasicEnv()) as unknown as { placements: unknown };
      if (jsonDiff(r.placements, r2.placements).length > 0) failures.push(`seed ${seed}: not deterministic`);
      expect(failures).toEqual([]);
    });
  }

  for (let seed = 0; seed < Math.min(PARITY, CASES); seed++) {
    it.skipIf(!HAS_CLI)(`same result as the Rust CLI: seed ${seed}`, () => {
      const p = problem(seed);
      const rust = rustResult(p);
      if (rust === null) return; // an older CLI build without --no-clock
      const ts = withoutTiming(placeWith(p, new BasicEnv(), "rust"));
      expect(jsonDiff(ts, withoutTiming(rust))).toEqual([]);
    });
  }
});
