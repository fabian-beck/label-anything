// Port of rust/crates/la-core/tests/place_samples.rs: runs `place` on all conformance
// sample problems and checks the hard guarantees.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BasicEnv } from "../src/env.js";
import { placeWith } from "../src/place.js";

const DIR = fileURLToPath(new URL("../../../../conformance/problems/", import.meta.url));

describe("place_samples", () => {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const f of files) {
    it(`samples_place_without_violations: ${f}`, () => {
      const p = JSON.parse(readFileSync(join(DIR, f), "utf8"));
      const r = placeWith(p, new BasicEnv()) as { placements: unknown; stats: Record<string, unknown> };
      expect(r.stats.hard_violations).toBe(0);
      expect(r.stats.priority_inversions).toBe(0);
      expect(r.stats.leader_crossings).toBe(0);
      const r2 = placeWith(p, new BasicEnv()) as { placements: unknown };
      expect(r2.placements, "not deterministic").toEqual(r.placements);
    });
  }
});
