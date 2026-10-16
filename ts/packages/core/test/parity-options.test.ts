// Parity with the Rust core beyond the fixtures: every sample problem of
// conformance/problems/ with option changes that steer the solver into paths the fixtures
// do not reach (soft item costs, item buffers, a partial own-mark policy, hard point and
// line classes), solved by the Rust CLI without a clock and by the TypeScript core with
// the Rust budget profile. Runs when the Rust CLI has been built
// (`cargo build --release -p label-anything-cli`).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BasicEnv } from "../src/env.js";
import { placeWith, validate } from "../src/place.js";
import { jsonDiff, withoutTiming } from "./parity-util.js";

const PROBLEMS = fileURLToPath(new URL("../../../../conformance/problems/", import.meta.url));
const BIN = fileURLToPath(new URL("../../../../rust/target/release/label-anything", import.meta.url));
const HAS_CLI = existsSync(BIN);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

/**
 * `p` with at most 1500 local-search moves: without a clock nothing else bounds the
 * search, and a few sample problems take seconds per variant with the full budget.
 */
function bounded(p: Obj): Obj {
  const solver = obj(p.solver);
  const it = typeof solver.max_iterations === "number" ? Math.min(solver.max_iterations, 1500) : 1500;
  return { ...p, solver: { ...solver, max_iterations: it } };
}

/** `p` with `avoid.<section>` extended by `add`. */
function withAvoid(p: Obj, section: string, add: Obj): Obj {
  const avoid = obj(p.avoid);
  return { ...p, avoid: { ...avoid, [section]: { ...obj(avoid[section]), ...add } } };
}

const VARIANTS: [string, (p: Obj) => Obj][] = [
  ["soft items", (p) => withAvoid(p, "label", { items: 0.7 })],
  ["item buffer", (p) => withAvoid(p, "buffer", { items: 0.5 })],
  ["partial own mark", (p) => withAvoid(p, "label", { own_mark: "partial:0.3" })],
  ["hard points and lines", (p) => withAvoid(withAvoid(p, "label", { points: "hard", lines: "hard" }), "leader", { points: "hard", lines: "hard" })],
];

/** The Rust CLI's result without a clock (null if this build lacks `--no-clock`). */
function rustResult(p: unknown): unknown {
  try {
    const out = execFileSync(BIN, ["place", "-", "--no-clock"], {
      input: JSON.stringify(p),
      cwd: PROBLEMS,
      maxBuffer: 1 << 28,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(out.toString());
  } catch (e) {
    const msg = String((e as { stderr?: unknown }).stderr ?? e);
    if (msg.includes("--no-clock")) return null;
    throw e;
  }
}

describe("parity with the Rust core under option changes", () => {
  for (const f of readdirSync(PROBLEMS).filter((f) => f.endsWith(".json")).sort()) {
    for (const [name, change] of VARIANTS) {
      it.skipIf(!HAS_CLI)(`${f}: ${name}`, () => {
        const p = bounded(change(JSON.parse(readFileSync(join(PROBLEMS, f), "utf8")) as Obj));
        expect(validate(p).valid).toBe(true);
        const rust = rustResult(p);
        if (rust === null) return; // an older CLI build without --no-clock
        const ts = withoutTiming(placeWith(p, new BasicEnv(), "rust"));
        expect(jsonDiff(ts, withoutTiming(rust))).toEqual([]);
      });
    }
  }
});
