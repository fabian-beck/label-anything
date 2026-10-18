// Port of the unit tests of rust/crates/la-core/src/validate.rs (same names), plus tests
// of the TypeScript specifics. Exact parity with the Rust reports is tested by
// conformance-validate.test.ts and validate-fuzz.test.ts.
import { describe, expect, it } from "vitest";
import { JsonError, parseJson, ptrJoin, ptrToken, RESERVED_CLASSES, validate, validateStr, type Report } from "../src/validate.js";

function codes(r: Report): [string, string][] {
  return r.errors.map((e) => [e.pointer, e.code]);
}

const point = (x: unknown, y: unknown) => ({ type: "point", x, y });
const text = (t: string) => ({ type: "text", text: t });

describe("validate", () => {
  it("minimal_problem_is_valid", () => {
    const r = validate({ items: [{ anchor: { type: "point", x: 1, y: 2 }, label: { type: "text", text: "A" } }] });
    expect(r.valid, JSON.stringify(r.errors)).toBe(true);
  });

  it("unknown_properties_suggest_close_names", () => {
    const r = validate({
      items: [],
      priorty: {},
      fontsize: 10,
      canvas: { widht: 8, height: 6 },
      defaults: { font: { lineHeight: 1.4 } },
    });
    const msgs = r.errors.map((e) => e.message);
    expect(msgs).toContain("unknown property 'priorty' (did you mean 'priority'?)");
    expect(msgs).toContain("unknown property 'widht' (did you mean 'width'?)");
    expect(msgs).toContain("unknown property 'lineHeight' (did you mean 'line_height'?)");
    expect(msgs).toContain("unknown property 'fontsize'");
  });

  it("structural_errors_have_pointers", () => {
    const r = validate({
      canvas: { width: -1, height: 10 },
      items: [
        { id: "a", anchor: { type: "point", x: 1 }, label: { type: "text", text: "A" } },
        {
          id: "a",
          anchor: { type: "point", x: 1, y: 2, mark: { shape: "circle", r: 2, w: 1 } },
          label: { type: "text", text: "B", padding: "3qq" },
        },
        { anchor: { type: "line" }, label: { type: "icon", width: 4 } },
      ],
      avoid: { label: { outlierz: "hard" } },
      frobnicate: 1,
    });
    const c = codes(r);
    expect(c).toContainEqual(["/canvas/width", "range"]);
    expect(c).toContainEqual(["/items/0/anchor/y", "required"]);
    expect(c).toContainEqual(["/items/1/id", "duplicate_id"]);
    expect(c).toContainEqual(["/items/1/anchor/mark/w", "unknown_property"]);
    expect(c).toContainEqual(["/items/1/label/padding", "unit"]);
    expect(c).toContainEqual(["/items/2/anchor/type", "unsupported"]);
    expect(c).toContainEqual(["/items/2/label/height", "required"]);
    expect(c).toContainEqual(["/frobnicate", "unknown_property"]);
    expect(r.warnings[0]!.code).toBe("unknown_class");
  });

  it("exclusive_alternatives", () => {
    const r = validate({ items: [], obstacles: { svg: { source: "<svg/>", path: "x.svg" } } });
    expect(codes(r)).toEqual([["/obstacles/svg", "exclusive"]]);
  });

  it("parse_errors", () => {
    const r = validateStr('{"items": [');
    expect(r.errors[0]!.code).toBe("parse");
  });
});

describe("validate (TypeScript specifics)", () => {
  it("reports messages, sorted and deduplicated like Rust", () => {
    const r = validate({
      items: [{ anchor: point("1", 2), label: { type: "text", text: "A", padding: true } }],
      placement: { offset: "3 px", models: ["adjacent", "adjacent"] },
      solver: { seed: 1.5, time_budget_ms: 0 },
      leaders: { style: "zigzag" },
      version: "2",
    });
    expect(r.errors).toEqual([
      { pointer: "/items/0/anchor/x", code: "type", message: "expected number, got string" },
      { pointer: "/items/0/label/padding", code: "type", message: "expected number, got boolean" },
      {
        pointer: "/leaders/style",
        code: "enum",
        message: 'must be one of "straight", "angles", "orthogonal", "elbow", "curved"',
      },
      { pointer: "/placement/models/1", code: "unique", message: "duplicate entry" },
      {
        pointer: "/placement/offset",
        code: "unit",
        message: 'invalid length "3 px": use a number (px) or <number>px|pt|em',
      },
      { pointer: "/solver/seed", code: "type", message: "expected integer, got number" },
      { pointer: "/solver/time_budget_ms", code: "range", message: "must be > 0" },
      { pointer: "/version", code: "const", message: 'must be "1"' },
    ]);
  });

  it("counts string lengths in code points and cuts long values like Rust", () => {
    const r = validate({ items: [{ id: "", anchor: point(0, 0), label: text("A") }], degrade: ["😀".repeat(70), "😀".repeat(40)] });
    const tail = " does not match ^(alternatives|wrap|truncate|distant|boundary|evict_lower|soft_overlap|omit|shrink:(0(\\.[0-9]+)?|1(\\.0+)?|\\.[0-9]+))$";
    // more than 60 bytes: the first 57 code points of the JSON text, then "…"
    expect(r.errors[0]).toEqual({ pointer: "/degrade/0", code: "pattern", message: `"${"😀".repeat(56)}…${tail}` });
    // more than 60 bytes but fewer than 58 code points: all of it, then "…" (as in Rust)
    expect(r.errors[1]).toEqual({ pointer: "/degrade/1", code: "pattern", message: `"${"😀".repeat(40)}"…${tail}` });
    expect(r.errors[2]).toEqual({ pointer: "/items/0/id", code: "length", message: "must have at least 1 characters" });
    // one astral character is one code point: long enough
    expect(validate({ items: [{ id: "😀", anchor: point(0, 0), label: text("A") }] }).valid).toBe(true);
  });

  it("treats 1.0 like 1 and checks integers by their value", () => {
    expect(validate({ items: [], solver: { seed: 1.0 } }).valid).toBe(true);
    expect(validateStr('{"items": [], "solver": {"seed": 1.0, "max_iterations": 2e3}}').valid).toBe(true);
    expect(codes(validate({ items: [], solver: { seed: 4294967296 } }))).toEqual([["/solver/seed", "range"]]);
    expect(validate({ items: [], solver: { seed: -0 } }).valid).toBe(true);
  });

  it("escapes pointer tokens", () => {
    expect(ptrToken("a/b~c")).toBe("a~1b~0c");
    expect(ptrJoin("/x", "~/")).toBe("/x/~0~1");
    const r = validate({ items: [], "a/b~c": 1, avoid: { label: { "x/y": 1 } } });
    expect(r.errors).toEqual([
      { pointer: "/avoid/label/x~1y", code: "pattern", message: '"x/y" does not match ^[A-Za-z_][A-Za-z0-9_.:-]*$' },
      { pointer: "/a~1b~0c", code: "unknown_property", message: "unknown property 'a/b~c'" },
    ]);
    expect(r.warnings.map((w) => w.pointer)).toEqual(["/avoid/label/x~1y"]);
  });

  it("checks expressions with the expression parser", () => {
    const r = validate({
      items: [],
      priority: { tiers: [{ where: "attrs.x +", tier: 1 }], terms: [{ expr: "foo(1)" }], coverage: { by: "attrs.region" } },
    });
    expect(r.errors).toEqual([
      { pointer: "/priority/terms/0/expr", code: "expr_unknown_identifier", message: expect.stringMatching(/ \(at 0\)$/) },
      { pointer: "/priority/tiers/0/where", code: "expr_syntax", message: expect.stringMatching(/ \(at 9\)$/) },
    ]);
  });

  it("knows the reserved and produced classes", () => {
    expect(RESERVED_CLASSES).toEqual(["items", "labels", "leaders", "canvas_edge", "ink", "text"]);
    const r = validate({
      items: [],
      preset: "map",
      obstacles: { vector: [{ class: "roads" }], svg: [{ source: "<svg/>" }], raster: { source: "x.png", classmap: { "#fff": "water" } } },
      avoid: { label: { roads: 1, water: 1, areas: 1, own_mark: "hard", "*": 1, ink: 1, foo: 1 }, relaxable: ["ignore", "lines"] },
    });
    expect(r.valid).toBe(true);
    expect(r.warnings.map((w) => [w.pointer, w.code])).toEqual([
      ["/avoid/label/foo", "unknown_class"],
      ["/avoid/relaxable/0", "unknown_class"],
    ]);
  });

  it("treats undefined properties as absent and never reads the prototype chain", () => {
    expect(validate({ items: [], canvas: undefined }).valid).toBe(true);
    const r = validate({ items: [{ anchor: { type: "point", x: 1, y: undefined }, label: text("A") }] });
    expect(codes(r)).toEqual([["/items/0/anchor/y", "required"]]);
    const proto = validate(JSON.parse('{"items": [], "__proto__": {"canvas": 1}, "constructor": 1}'));
    expect(codes(proto)).toEqual([
      ["/__proto__", "unknown_property"],
      ["/constructor", "unknown_property"],
    ]);
    expect(validate({ items: [], preset: "toString" }).errors[0]!.code).toBe("enum");
    expect(validate({ items: [[1, 2], undefined] }).errors.map((e) => e.message)).toEqual([
      "expected object, got array",
      "expected object, got null",
    ]);
  });

  it("rejects NaN and infinite numbers, which JSON cannot carry", () => {
    const r = validate({ canvas: { width: Infinity, height: 10 }, items: [{ anchor: point(NaN, 2), label: text("A") }] });
    expect(r.errors.map((e) => [e.pointer, e.code, e.message])).toEqual([
      ["/canvas/width", "type", "expected number, got Infinity"],
      ["/items/0/anchor/x", "type", "expected number, got NaN"],
    ]);
    expect(validate({ items: [], solver: { seed: -Infinity } }).errors[0]!.message).toBe("expected integer, got -Infinity");
  });
});

describe("parseJson", () => {
  it("parses like serde_json", () => {
    expect(parseJson(' {"a": [1, -0, 2.5e1, "x\\u00e9\\ud83d\\ude00"], "a": true} ')).toEqual({ a: true });
    expect(Object.is(parseJson("-0"), -0)).toBe(true);
    expect(parseJson("1e-400")).toBe(0);
    expect(parseJson("123456789012345678901234567890")).toBe(1.2345678901234568e29);
    expect(parseJson('"é😀"')).toBe("é😀");
    const deep = "[".repeat(127) + "]".repeat(127);
    expect(Array.isArray(parseJson(deep))).toBe(true);
  });

  it("reports serde_json's errors and positions", () => {
    const cases: [string, string][] = [
      ['{"items": [', "EOF while parsing a list at line 1 column 11"],
      ["", "EOF while parsing a value at line 1 column 0"],
      ["{", "EOF while parsing an object at line 1 column 1"],
      ['{"a" 1}', "expected `:` at line 1 column 6"],
      ["[1 2]", "expected `,` or `]` at line 1 column 4"],
      ['{"a": 1 "b": 2}', "expected `,` or `}` at line 1 column 9"],
      ["[1,]", "trailing comma at line 1 column 4"],
      ['{"a": 1,}', "trailing comma at line 1 column 9"],
      ["{1: 2}", "key must be a string at line 1 column 2"],
      ["tru", "EOF while parsing a value at line 1 column 3"],
      ["trux", "expected ident at line 1 column 4"],
      ["01", "invalid number at line 1 column 2"],
      ["1.", "EOF while parsing a value at line 1 column 2"],
      ["1.x", "invalid number at line 1 column 3"],
      ["-", "EOF while parsing a value at line 1 column 1"],
      ["1e", "EOF while parsing a value at line 1 column 2"],
      ["1e+x", "invalid number at line 1 column 4"],
      ["1e400", "number out of range at line 1 column 5"],
      ["1e9999999999", "number out of range at line 1 column 12"],
      ["1e99999999999999", "number out of range at line 1 column 12"],
      ['"\\x"', "invalid escape at line 1 column 3"],
      ['"\\u12"', "EOF while parsing a string at line 1 column 6"],
      ['"\\ud800"', "unexpected end of hex escape at line 1 column 8"],
      ['"\\udc00"', "lone leading surrogate in hex escape at line 1 column 7"],
      ['"a\nb"', "control character (\\u0000-\\u001F) found while parsing a string at line 2 column 0"],
      ['"abc', "EOF while parsing a string at line 1 column 4"],
      ["[1] x", "trailing characters at line 1 column 5"],
      ["\n\n  @", "expected value at line 3 column 3"],
      ["é", "expected value at line 1 column 1"],
      ["[".repeat(128), "recursion limit exceeded at line 1 column 128"],
    ];
    for (const [input, message] of cases) {
      let error: unknown = null;
      try {
        parseJson(input);
      } catch (e) {
        error = e;
      }
      expect(error, input).toBeInstanceOf(JsonError);
      expect((error as JsonError).message, input).toBe(message);
      expect(validateStr(input).errors, input).toEqual([{ pointer: "", code: "parse", message: `invalid JSON: ${message}` }]);
    }
  });
});
