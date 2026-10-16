// Parity with the Rust core: every fixture of conformance/parity/ (written by
// `cargo run --release -p label-anything --example place_oracle`) holds the Rust result of
// a conformance problem solved without a clock. The TypeScript solver, run without a clock
// and with the Rust budget profile (the same iteration counts), must reproduce it bit for
// bit: every placement, box, leader, text layout, debug SVG and statistic except the
// timing fields and the implementation name.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BasicEnv } from "../src/env.js";
import { placeWith } from "../src/place.js";
import { jsonDiff, withoutTiming } from "./parity-util.js";

const CONF = fileURLToPath(new URL("../../../../conformance/", import.meta.url));
const DIR = join(CONF, "parity");

interface Fixture {
  kind: string;
  problem?: unknown;
  problem_file?: string;
  result: unknown;
}

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

describe("parity with the Rust core (conformance/parity)", () => {
  it("covers every sample problem and inline place case", () => {
    const problems = readdirSync(join(CONF, "problems")).filter((f) => f.endsWith(".json"));
    for (const p of problems) expect(files, p).toContain(p);
    for (const f of readdirSync(join(CONF, "place")).filter((f) => f.endsWith(".json"))) {
      const c = JSON.parse(readFileSync(join(CONF, "place", f), "utf8")) as { problem?: unknown };
      if (c.problem !== undefined) expect(files, f).toContain(`place-${f}`);
    }
  });

  for (const f of files) {
    it(f, () => {
      const fx = JSON.parse(readFileSync(join(DIR, f), "utf8")) as Fixture;
      expect(fx.kind).toBe("parity");
      const problem = fx.problem ?? JSON.parse(readFileSync(join(DIR, fx.problem_file!), "utf8"));
      const r = withoutTiming(placeWith(problem, new BasicEnv(), "rust"));
      expect(jsonDiff(r, fx.result)).toEqual([]);
    });
  }
});
