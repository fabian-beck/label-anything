// Port of rust/crates/la-core/tests/measure_paths.rs: without a host measurement callback,
// wrapping and truncation measure their candidate lines with the fonts in constant time
// (`FontMeasure`, ADR text/measurement); with one, every line goes through `Measurer.width`. The
// two paths must give bit-identical label variants and identical results.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BasicEnv, type Env, envHasMeasureCallback } from "../src/env.js";
import { Measurer, baseVariants, bundledFonts, ladderVariants, userFonts } from "../src/labels.js";
import { build } from "../src/model/index.js";
import { placeWith } from "../src/place.js";
import { jsonDiff } from "./parity-util.js";

const conformanceDir = fileURLToPath(new URL("../../../../conformance/", import.meta.url));

/** Declares a measurement callback that never measures, so every line takes the closure
 * path and falls back to the same fonts. */
const closurePath: Env = {};

function assertSameResults(name: string, problem: unknown): void {
  expect(envHasMeasureCallback(new BasicEnv())).toBe(false);
  expect(envHasMeasureCallback(closurePath)).toBe(true);
  const fast = placeWith(problem, new BasicEnv());
  const closure = placeWith(problem, closurePath);
  expect(jsonDiff(fast, closure), name).toEqual([]);
}

/**
 * The base variants and the variants of every ladder step of every item, compared bit for
 * bit. Returns the number of text lines compared.
 */
function assertSameVariants(name: string, problem: unknown): number {
  const m = build(problem, new BasicEnv());
  const fonts = userFonts(m, new BasicEnv()) ?? bundledFonts();
  const fast = new Measurer(fonts, new BasicEnv(), m.shaping);
  const closure = new Measurer(fonts, closurePath, m.shaping);
  let lines = 0;
  for (const item of m.items) {
    const variants = [baseVariants(fast, item), baseVariants(closure, item)];
    for (const step of m.ladder) {
      const { minScale, wrapMaxLines } = m.degrade;
      const a = ladderVariants(fast, item, step, variants[0], minScale, wrapMaxLines);
      const b = ladderVariants(closure, item, step, variants[1], minScale, wrapMaxLines);
      variants[0].push(...a);
      variants[1].push(...b);
    }
    expect(jsonDiff(variants[0], variants[1]), `${name}: item ${item.id}`).toEqual([]);
    for (const v of variants[0]) lines += v.lines();
  }
  return lines;
}

function conformance(dir: string): [string, Record<string, unknown>][] {
  return readdirSync(join(conformanceDir, dir))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => [f, JSON.parse(readFileSync(join(conformanceDir, dir, f), "utf8"))]);
}

/** A data URL (percent-encoded) of a synthetic font whose kern pair `T o` skips its second
 * glyph (ValueFormat2 ≠ 0) and whose acute accent is a GDEF mark. */
function syntheticGposFont(): string {
  const bytes = readFileSync(join(conformanceDir, "text/fonts/synthetic-gpos.ttf"));
  let encoded = "";
  for (const b of bytes) encoded += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  return `data:font/ttf,${encoded}`;
}

/**
 * Far more labels than fit: long qualified class names without wrap settings (the `wrap`
 * ladder step), with wrap settings and every truncation mode, alternatives, bold text,
 * combining marks, a Hebrew name, and a user font, with a `truncate` ladder step.
 */
function crowded(shaping: string): Record<string, unknown> {
  const names = [
    "com.facebook.react.uimanager.layoutanimation.LayoutAnimationController",
    "org.springframework.beans.factory.support.DefaultListableBeanFactory",
    "java.util.concurrent.ConcurrentHashMap$KeySetView",
    "XMLHttpRequestFactory",
    "Crème brûlée à la carte, Stéphane",
    "שלום עולם hello.world",
    "Toa.ToToa-AVAVA yóTo ToaB.CyTo",
    "std::collections::HashMap<String, Vec<u8>>",
  ];
  const fontFile = syntheticGposFont();
  const items = [];
  for (let i = 0; i < 48; i++) {
    const name = names[i % names.length];
    const label: Record<string, unknown> = { type: "text", text: `${name}${i}` };
    switch (i % 6) {
      case 1:
        label.wrap = { max_width: 60 + (i % 50), max_lines: 1 + (i % 4) };
        break;
      case 2:
        label.wrap = { max_width: 50, max_lines: 2 };
        label.truncate = ["end", "middle", "none"][i % 3];
        break;
      case 3:
        label.alternatives = [name.split(".").pop(), "x.y"];
        break;
      case 4:
        label.font = { weight: "bold", size: 9 };
        break;
    }
    if (name.startsWith("Toa") && i % 3 !== 0) label.font = { family: "Synthetic", file: fontFile };
    const [x, y] = [30 + (i % 12) * 28, 25 + Math.trunc(i / 12) * 22];
    items.push({ id: `i${i}`, anchor: { type: "point", x, y }, label, priority: i % 7 });
  }
  return {
    canvas: { width: 400, height: 120 },
    items,
    text: { shaping },
    degrade: ["alternatives", "wrap", "truncate", "distant", "shrink:0.85", "omit"],
    solver: { max_iterations: 2000 },
  };
}

describe("measure_paths", () => {
  it("sample_problems_and_place_cases", () => {
    for (const [name, problem] of conformance("problems")) assertSameResults(name, problem);
    // the other place cases reference the sample problems
    for (const [name, c] of conformance("place")) if (c.problem !== undefined) assertSameResults(name, c.problem);
  });

  it("crowded_labels", () => {
    for (const shaping of ["auto", "simple"]) {
      const problem = crowded(shaping);
      expect(assertSameVariants(shaping, problem)).toBeGreaterThan(500);
      assertSameResults(shaping, problem);
    }
  });
});
