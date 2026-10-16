// Robustness of the validator: the regression sample of the differential fuzzing against
// Rust (conformance/validate/reports/mutants.json, `node tools/validate/parity.mjs
// mutants`; the full fuzzing is `node tools/validate/parity.mjs fuzz`), and properties:
// validate/validateStr never throw on arbitrary JSON values and texts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareCodePoints } from "../src/expr/index.js";
import { parseJson, validate, validateStr, type Report } from "../src/validate.js";

const CONF = fileURLToPath(new URL("../../../../conformance/", import.meta.url));

interface MutantCase {
  name: string;
  problem?: unknown;
  text?: string;
  report: Report;
}

const MUTANTS = JSON.parse(readFileSync(`${CONF}validate/reports/mutants.json`, "utf8")).cases as MutantCase[];
const SAMPLE = JSON.parse(readFileSync(`${CONF}problems/presets-map.json`, "utf8")) as Record<string, unknown>;

const plain = (r: Report): Report => JSON.parse(JSON.stringify(r));

/** The invariants every report satisfies: valid iff no errors, issues sorted and deduplicated. */
function wellFormed(r: Report): void {
  expect(r.valid).toBe(r.errors.length === 0);
  for (const list of [r.errors, r.warnings]) {
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!;
      const b = list[i]!;
      const c = compareCodePoints(a.pointer, b.pointer) || compareCodePoints(a.code, b.code);
      expect(c, JSON.stringify([a, b])).toBeLessThan(0);
    }
    for (const e of list) {
      expect(typeof e.pointer).toBe("string");
      expect(e.code.length).toBeGreaterThan(0);
      expect(e.message.length).toBeGreaterThan(0);
    }
  }
}

describe("differential fuzzing regression sample (Rust reports)", () => {
  it("has value and text mutants", () => {
    expect(MUTANTS.filter((c) => c.problem !== undefined).length).toBeGreaterThanOrEqual(200);
    expect(MUTANTS.filter((c) => c.text !== undefined).length).toBeGreaterThanOrEqual(50);
  });

  it("reproduces every Rust report exactly", () => {
    const stale = "run node tools/validate/parity.mjs mutants";
    for (const c of MUTANTS) {
      const r = c.problem !== undefined ? validate(c.problem) : validateStr(c.text!);
      expect(plain(r), `${c.name} (${stale})`).toEqual(c.report);
      wellFormed(r);
    }
  });
});

/** JSON values without `__proto__` keys (fast-check builds objects by assignment). */
const json = fc.jsonValue({ maxDepth: 6 });

/** A JSON value placed at a random path of a valid sample problem. */
function inject(base: unknown, path: number[], v: unknown): unknown {
  const out = JSON.parse(JSON.stringify(base));
  let cur: unknown = out;
  for (let i = 0; i < path.length; i++) {
    const keys = Array.isArray(cur) ? cur.map((_, k) => k) : cur !== null && typeof cur === "object" ? Object.keys(cur) : [];
    if (keys.length === 0) break;
    const k = keys[path[i]! % keys.length]!;
    const container = cur as Record<string | number, unknown>;
    const child = container[k];
    if (i === path.length - 1 || child === null || typeof child !== "object") {
      container[k] = v;
      break;
    }
    cur = child;
  }
  return out;
}

describe("validate never throws", () => {
  it("on arbitrary JSON values", () => {
    fc.assert(
      fc.property(json, (v) => {
        wellFormed(validate(v));
        wellFormed(validate({ items: [], x: v }));
      }),
      { seed: 1, numRuns: 2000 },
    );
  });

  it("on arbitrary JSON values anywhere in a valid problem", () => {
    expect(validate(SAMPLE).valid).toBe(true);
    fc.assert(
      fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 8 }), json, (path, v) => {
        wellFormed(validate(inject(SAMPLE, path, v)));
      }),
      { seed: 2, numRuns: 3000 },
    );
  });

  it("on arbitrary strings in every string slot", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 8 }), fc.fullUnicodeString({ maxLength: 40 }), (path, s) => {
        wellFormed(validate(inject(SAMPLE, path, s)));
      }),
      { seed: 3, numRuns: 3000 },
    );
  });

  it("on deep, wide and unusual values", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100000; i++) deep = [deep];
    // uniqueItems compares the entries: iterative, no stack overflow
    wellFormed(validate({ items: [], placement: { models: [deep, deep] } }));
    wellFormed(validate({ items: [], leaders: { style: deep } }));
    const wide: Record<string, number> = {};
    for (let i = 0; i < 5000; i++) wide[`k${i}`] = i;
    wellFormed(validate({ items: [wide], avoid: { label: wide } }));
    const sparse: unknown[] = [];
    sparse[3] = 1;
    wellFormed(validate({ items: sparse, transform: [1, , 3] }));
    wellFormed(validate(JSON.parse('{"__proto__": [], "items": [{"__proto__": {"x": 1}}], "constructor": {"prototype": 1}}')));
    wellFormed(validate({ items: [{ anchor: { type: "point", x: Infinity, y: -0 }, label: { type: "text", text: "A" } }] }));
    for (const v of [undefined, null, 0, "", [], {}, new Date(0), new Map(), Object.create(null)]) wellFormed(validate(v));
  });
});

describe("validateStr never throws", () => {
  it("on arbitrary text", () => {
    fc.assert(
      fc.property(fc.fullUnicodeString({ maxLength: 60 }), (s) => {
        wellFormed(validateStr(s));
      }),
      { seed: 4, numRuns: 3000 },
    );
  });

  it("on JSON texts with random edits", () => {
    const base = JSON.stringify(SAMPLE);
    const pieces = fc.constantFrom("{", "}", "[", "]", ",", ":", '"', "\\", "\\u", "\\ud800", "e", "-", ".", "0", " ", "\n", "\u0001", "é", "😀", "1e400");
    fc.assert(
      fc.property(fc.nat(base.length), fc.nat(5), pieces, fc.boolean(), (at, del, piece, insert) => {
        const text = base.slice(0, at) + (insert ? piece : "") + base.slice(Math.min(base.length, at + del));
        const r = validateStr(text);
        wellFormed(r);
        // when JSON.parse accepts the text, both parsers agree on the value (unless serde_json
        // limits apply: nesting depth, out-of-range numbers, lone surrogates)
        let v: unknown;
        try {
          v = JSON.parse(text);
        } catch {
          return;
        }
        if (r.errors[0]?.code !== "parse") expect(parseJson(text)).toEqual(v);
      }),
      { seed: 5, numRuns: 3000 },
    );
  });

  it("reads number literals correctly rounded (= Number(literal), as serde_json with float_roundtrip)", () => {
    const literal = fc
      .tuple(
        fc.boolean(),
        fc.oneof(fc.constant("0"), fc.stringMatching(/^[1-9][0-9]{0,24}$/)),
        fc.option(fc.stringMatching(/^[0-9]{1,24}$/), { nil: undefined }),
        fc.option(fc.tuple(fc.constantFrom("e", "E"), fc.constantFrom("", "+", "-"), fc.integer({ min: 0, max: 400 })), { nil: undefined }),
      )
      .map(([neg, int, frac, exp]) => `${neg ? "-" : ""}${int}${frac !== undefined ? `.${frac}` : ""}${exp !== undefined ? `${exp[0]}${exp[1]}${exp[2]}` : ""}`);
    fc.assert(
      fc.property(literal, (lit) => {
        const x = Number(lit);
        if (Number.isFinite(x)) expect(Object.is(parseJson(lit), x), lit).toBe(true);
        else expect(() => parseJson(lit), lit).toThrow(/^number out of range/);
      }),
      { seed: 6, numRuns: 20000 },
    );
    for (const lit of ["0.1", "0.30000000000000004", "123456789012345", "1234567890123456", "9007199254740993", "1e22", "1e23",
      "4.9e-324", "2.2250738585072014e-308", "1.7976931348623157e308", "1.7976931348623159e308", "-0.0", "0e400", "5e-400"]) {
      const x = Number(lit);
      if (Number.isFinite(x)) expect(Object.is(parseJson(lit), x), lit).toBe(true);
    }
  });

  it("on lone surrogates (impossible in Rust strings: read as U+FFFD)", () => {
    expect(parseJson('"\ud800x"')).toBe("�x");
    expect(validateStr('{"items": [], "\udc00": 1}').errors.map((e) => e.pointer)).toEqual(["/�"]);
  });
});
