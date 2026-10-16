// Runs conformance/validate/*.json (format: conformance/README.md, "validate cases") and
// checks that every report is the Rust validator's, issue for issue and byte for byte
// (conformance/validate/reports/rust.json, written by `node tools/validate/parity.mjs
// reports`; `cargo test -p label-anything-core --test validate_reports` keeps it current).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validate, validateStr, type Report } from "../src/validate.js";

const CONF = fileURLToPath(new URL("../../../../conformance/", import.meta.url));

interface ExpectedIssue {
  pointer: string;
  code: string;
}

interface ValidateCase {
  kind: string;
  name: string;
  problem?: unknown;
  problem_file?: string;
  problem_files?: string[];
  expect: { valid: boolean; errors?: ExpectedIssue[]; warnings?: ExpectedIssue[]; exact?: boolean };
}

const jsonFiles = (dir: string): string[] =>
  readdirSync(join(CONF, dir))
    .filter((f) => f.endsWith(".json"))
    .sort();

const REPORTS = JSON.parse(readFileSync(join(CONF, "validate/reports/rust.json"), "utf8")).reports as Record<string, Report>;
const STALE = "conformance/validate/reports/rust.json is stale: run node tools/validate/parity.mjs reports";

/** A report as plain JSON (issues are class instances). */
const plain = (r: Report): Report => JSON.parse(JSON.stringify(r));

/** The problems of a case: [key relative to conformance/, report]. */
function caseProblems(file: string, c: ValidateCase): [string, Report][] {
  const out: [string, Report][] = [];
  if (c.problem !== undefined) out.push([`validate/${file}`, validate(c.problem)]);
  for (const f of [...(c.problem_files ?? []), ...(c.problem_file !== undefined ? [c.problem_file] : [])]) {
    const key = join("validate", f).replace(/\\/g, "/");
    out.push([key, validateStr(readFileSync(join(CONF, key), "utf8"))]);
  }
  return out;
}

const cases = jsonFiles("validate").map((f) => [f, JSON.parse(readFileSync(join(CONF, "validate", f), "utf8"))] as [string, ValidateCase]);

describe("conformance/validate", () => {
  it("has the M0 sample set", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    const referenced = new Set<string>();
    for (const [f, c] of cases) for (const [key] of caseProblems(f, c)) referenced.add(key);
    // every sample problem is validated by some case (the M0 acceptance criterion)
    const samples = jsonFiles("problems").map((f) => `problems/${f}`);
    expect(samples.length).toBe(24);
    for (const s of samples) expect(referenced.has(s), s).toBe(true);
  });

  for (const [file, c] of cases) {
    it(`${file}: ${c.name}`, () => {
      expect(c.kind).toBe("validate");
      const problems = caseProblems(file, c);
      expect(problems.length).toBeGreaterThan(0);
      for (const [key, r] of problems) {
        const errors = r.errors.map((e) => `${e.pointer} ${e.code}`);
        expect(r.valid, `${key}: ${JSON.stringify(r.errors)}`).toBe(c.expect.valid);
        for (const e of c.expect.errors ?? []) expect(errors, key).toContain(`${e.pointer} ${e.code}`);
        const warnings = r.warnings.map((w) => `${w.pointer} ${w.code}`);
        for (const w of c.expect.warnings ?? []) expect(warnings, key).toContain(`${w.pointer} ${w.code}`);
        if (c.expect.exact) expect(r.errors.length, key).toBe((c.expect.errors ?? []).length);
      }
    });
  }
});

describe("parity with the Rust validator (reports/rust.json)", () => {
  it("has a report for every sample problem and every inline case problem", () => {
    const keys = [
      ...jsonFiles("problems").map((f) => `problems/${f}`),
      ...cases.filter(([, c]) => c.problem !== undefined).map(([f]) => `validate/${f}`),
    ];
    expect(Object.keys(REPORTS), STALE).toEqual(keys);
  });

  for (const f of jsonFiles("problems")) {
    it(`problems/${f}`, () => {
      const r = validateStr(readFileSync(join(CONF, "problems", f), "utf8"));
      expect(plain(r), STALE).toEqual(REPORTS[`problems/${f}`]);
      // the parsed value gives the same report
      expect(plain(validate(JSON.parse(readFileSync(join(CONF, "problems", f), "utf8"))))).toEqual(plain(r));
    });
  }

  for (const [f, c] of cases.filter(([, c]) => c.problem !== undefined)) {
    it(`validate/${f}`, () => {
      expect(plain(validate(c.problem)), STALE).toEqual(REPORTS[`validate/${f}`]);
    });
  }
});
