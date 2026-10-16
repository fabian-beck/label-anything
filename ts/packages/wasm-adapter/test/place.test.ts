// place / validate / renderDebugSvg through the Node entry (auto-initialized).
import { readdirSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { Issue } from "@label-anything/core";
import { built, problemFiles, rasterOptions, readProblem, REPO, scatter, untimed, type AnyProblem } from "./helpers.js";

type Wasm = typeof import("../src/node.js");
let la: Wasm;

interface ValidateCase {
  name: string;
  problem?: unknown;
  problem_file?: string;
  problem_files?: string[];
  expect: { valid: boolean; errors?: Partial<Issue>[]; warnings?: Partial<Issue>[] };
}

const validateDir = `${REPO}conformance/validate/`;
const validateCases: ValidateCase[] = readdirSync(validateDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(validateDir + f, "utf8")) as ValidateCase);

function problemsOf(c: ValidateCase): unknown[] {
  const read = (p: string) => JSON.parse(readFileSync(validateDir + p, "utf8")) as unknown;
  if (c.problem_files) return c.problem_files.map(read);
  if (c.problem_file) return [read(c.problem_file)];
  return [c.problem];
}

function placeError(f: () => unknown): InstanceType<Wasm["PlaceError"]> {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(la.PlaceError);
    return e as InstanceType<Wasm["PlaceError"]>;
  }
  throw new Error("expected a PlaceError");
}

describe.skipIf(!built)("place", () => {
  beforeAll(async () => {
    la = await import("../src/node.js");
  });

  it("reports the version of the package and of the Rust core", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    const { testHooks } = await import("../src/api.js");
    expect(la.features()).toContain("svg"); // initializes the module
    expect(la.VERSION).toBe(pkg.version);
    expect(testHooks.coreVersion()).toBe(la.VERSION);
  });

  for (const file of problemFiles) {
    it(`places ${file} without hard violations, deterministically`, () => {
      const problem = readProblem(file);
      const options = rasterOptions(la.features(), problem);
      const a = la.place(problem, options);
      const b = la.place(JSON.stringify(problem), options); // JSON text gives the same result
      expect(a.stats.hard_violations).toBe(0);
      expect(a.stats.placed).toBeGreaterThan(0);
      expect(a.placements.length).toBe(problem.items.length);
      // a run cut by the wall-clock guard (3 x time budget, on an overloaded machine) is
      // not comparable; the guard never fires for these samples at normal speed
      if (!a.stats.time_guard_hit && !b.stats.time_guard_hit) expect(untimed(b)).toEqual(untimed(a));
    });
  }

  it("needs the decode feature for encoded raster sources", () => {
    const problem = readProblem("raster-ink.json");
    if (la.features().includes("decode")) {
      expect(la.place(problem).stats.hard_violations).toBe(0);
    } else {
      const e = placeError(() => la.place(problem));
      expect(e.errors).toEqual([expect.objectContaining({ pointer: "/obstacles/raster/source", code: "unsupported" })]);
    }
  });

  for (const c of validateCases) {
    it(`validate case ${c.name}`, () => {
      for (const problem of problemsOf(c)) {
        const report = la.validate(problem);
        expect(report.valid).toBe(c.expect.valid);
        for (const e of c.expect.errors ?? []) expect(report.errors).toContainEqual(expect.objectContaining(e));
        for (const w of c.expect.warnings ?? []) expect(report.warnings).toContainEqual(expect.objectContaining(w));
        expect(la.validate(JSON.stringify(problem))).toEqual(report);
        if (!c.expect.valid) {
          // place throws the Rust error list
          const e = placeError(() => la.place(problem as AnyProblem));
          expect(e.name).toBe("PlaceError");
          expect(e.errors).toEqual(report.errors);
          expect(e.message).toBe(report.errors.map((i) => `${i.pointer || "/"} ${i.code}: ${i.message}`).join("\n"));
        }
      }
    });
  }

  it("reports invalid JSON text as a parse error", () => {
    const e = placeError(() => la.place("{ not json"));
    expect(e.errors).toEqual([expect.objectContaining({ pointer: "", code: "parse" })]);
    expect(la.validate("[1,").errors[0]).toMatchObject({ pointer: "", code: "parse" });
    expect(la.validate(undefined).valid).toBe(false);
  });

  it("throws the same PlaceError as @label-anything/core", async () => {
    const core = await import("../../core/src/api.js");
    const errors: Issue[] = [
      { pointer: "/items/0", code: "required", message: "missing" },
      { pointer: "", code: "parse", message: "bad" },
    ];
    const a = new la.PlaceError(errors);
    const b = new core.PlaceError(errors);
    expect([a.name, a.message, a.errors]).toEqual([b.name, b.message, b.errors]);
    expect(a).toBeInstanceOf(Error);
    expect(Object.keys(a)).toEqual(Object.keys(b));
  });

  it("renders the debug SVG overlay", () => {
    const problem = readProblem("scatter-basic.json");
    const result = la.place(problem);
    const svg = la.renderDebugSvg(problem, result);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('id="labels"');
    expect(la.renderDebugSvg(JSON.stringify(problem), result)).toBe(svg);
    expect(() => la.renderDebugSvg("{", result)).toThrow(la.PlaceError);
    // output.debug_svg fills the result field
    const withSvg = la.place({ ...problem, output: { debug_svg: true } });
    expect(withSvg.debug_svg).toMatch(/^<svg/);
  });

  it("does not modify the problem object", () => {
    const problem = scatter(12, { priority: { terms: [{ builtin: "outlierness" }] } });
    const before = JSON.stringify(problem);
    la.place(problem, { priority: (_item, i) => [1, -i], cost: () => 0 });
    expect(JSON.stringify(problem)).toBe(before);
  });
});
