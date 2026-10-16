// Unit tests of the TypeScript expression language. The language-neutral cases shared
// with Rust are in conformance/expr (expr-conformance.test.ts).
import { describe, expect, it } from "vitest";
import type { ExprContext, Value } from "../src/expr/index.js";
import {
  compareCodePoints,
  evalExpr,
  Expr,
  ExprError,
  exprMatches,
  exprNumber,
  MAX_DEPTH,
  parseExpr,
  truthy,
  valuesEqual,
} from "../src/expr/index.js";
import { codePointLength } from "../src/expr/value.js";
import { Pcg32 } from "../src/pcg.js";

const ctx = (attrs: Value = {}, extra: Partial<ExprContext> = {}): ExprContext => ({
  attrs,
  id: "",
  index: 0,
  text: "",
  x: 0,
  y: 0,
  ...extra,
});

const run = (src: string, attrs: Value = {}, extra: Partial<ExprContext> = {}) => evalExpr(parseExpr(src), ctx(attrs, extra));

function parseError(src: string): ExprError {
  try {
    parseExpr(src);
  } catch (e) {
    expect(e).toBeInstanceOf(ExprError);
    return e as ExprError;
  }
  throw new Error(`expected a parse error for ${src}`);
}

describe("API", () => {
  it("parses once and evaluates per item", () => {
    const e = parseExpr("attrs.category == 'core' && attrs.cbo > 10");
    expect(e).toBeInstanceOf(Expr);
    expect(e.source).toBe("attrs.category == 'core' && attrs.cbo > 10");
    expect(evalExpr(e, ctx({ category: "core", cbo: 41 }))).toBe(true);
    expect(evalExpr(e, ctx({ category: "core", cbo: 4 }))).toBe(false);
    expect(exprMatches(e, ctx({ category: "core", cbo: 41 }))).toBe(true);
    expect(exprNumber(parseExpr("attrs.n * 2"), ctx({ n: 21 }))).toBe(42);
    expect(exprNumber(parseExpr("'x'"), ctx())).toBeNull();
  });

  it("reports errors with code, offset and the same messages as Rust", () => {
    const e = parseError("len(1, 2)");
    expect(e.name).toBe("ExprError");
    expect(e.code).toBe("expr_arity");
    expect(e.offset).toBe(0);
    expect(e.message).toBe("len() takes 1 argument, got 2");
    expect(parseError("min()").message).toBe("min() takes at least 1 argument, got 0");
    expect(parseError("attrs.x +").message).toBe("expected an expression, found end of input");
    expect(parseError("x = 1").message).toBe("unexpected character '=' (use '==' to compare)");
    expect(parseError("foo(1)").message).toBe("unknown function 'foo'");
    expect(parseError("bar").message).toBe("unknown identifier 'bar'");
    expect(parseError("attrs.in").message).toBe("expected a member name after '.', found 'in'");
    expect(parseError("'\\uD800'").message).toBe("invalid \\u escape: unpaired surrogate");
    expect(parseError("1e999").message).toBe("number out of range");
    expect(parseError("(".repeat(MAX_DEPTH + 1) + "1").message).toBe(
      "expression nested too deeply (more than 256 levels)",
    );
  });

  it("context fields default sensibly", () => {
    expect(run("[priority, tier]")).toEqual([null, null]);
    expect(run("[priority, tier]", {}, { priority: 2, tier: -1 })).toEqual([2, -1]);
    expect(run("x + y", {}, { x: NaN, y: 1 })).toBeNull();
  });
});

describe("JS-specific safety", () => {
  it("only own JSON keys are visible", () => {
    const attrs = JSON.parse('{"__proto__": 5, "a": {}}') as Value;
    expect(run("attrs.__proto__", attrs)).toBe(5);
    expect(run("attrs.constructor", attrs)).toBeNull();
    expect(run("attrs.a.toString", attrs)).toBeNull();
    expect(run("attrs.a.hasOwnProperty", attrs)).toBeNull();
    expect(run("attrs['__proto__']", { a: 1 })).toBeNull();
    expect(run("[1].length")).toBeNull();
    expect(run("'abc'.length")).toBeNull();
    expect(() => parseExpr("toString(1)")).toThrow(ExprError);
    expect(() => parseExpr("constructor")).toThrow(ExprError);
  });

  it("non-JSON values read as null", () => {
    const attrs = { u: undefined, n: NaN, i: Infinity, f: () => 1, b: BigInt(1), l: [undefined, NaN] } as unknown as Value;
    for (const k of ["u", "n", "i", "f", "b"]) expect(run(`attrs.${k}`, attrs)).toBeNull();
    expect(run("attrs.l[0] == null && attrs.l[1] == null", attrs)).toBe(true);
    expect(run("attrs.l == [null, null]", attrs)).toBe(true);
    expect(run("attrs.missing", undefined as unknown as Value)).toBeNull();
  });

  it("strings compare by code point, len counts code points", () => {
    expect(compareCodePoints("￿", "😀")).toBeLessThan(0);
    expect(compareCodePoints("", "\u{10000}")).toBeLessThan(0);
    expect(compareCodePoints("a", "b")).toBeLessThan(0);
    expect(compareCodePoints("ab", "a")).toBeGreaterThan(0);
    expect(compareCodePoints("😀", "😀")).toBe(0);
    expect(compareCodePoints("😀", "😁")).toBeLessThan(0);
    expect(codePointLength("a😀b")).toBe(3);
    expect(codePointLength("\uD800")).toBe(1);
    // exhaustive check of the fix-up against code point order on BMP/astral samples
    const rng = new Pcg32(11);
    const pick = () => {
      const r = rng.nextBelow(4);
      const cp = r === 0 ? rng.nextBelow(0xd800) : r === 1 ? 0xe000 + rng.nextBelow(0x2000) : 0x10000 + rng.nextBelow(0x100000);
      return String.fromCodePoint(cp);
    };
    for (let i = 0; i < 20000; i++) {
      const a = pick() + pick();
      const b = pick() + pick();
      const ca = Array.from(a, (c) => c.codePointAt(0) as number);
      const cb = Array.from(b, (c) => c.codePointAt(0) as number);
      let want = 0;
      for (let k = 0; k < Math.min(ca.length, cb.length) && want === 0; k++) want = Math.sign((ca[k] as number) - (cb[k] as number));
      if (want === 0) want = Math.sign(ca.length - cb.length);
      expect(Math.sign(compareCodePoints(a, b))).toBe(want);
    }
  });

  it("valuesEqual is iterative (deep data cannot overflow the stack)", () => {
    let a: Value = [];
    let b: Value = [];
    for (let i = 0; i < 100000; i++) {
      a = [a];
      b = [b];
    }
    expect(valuesEqual(a, b)).toBe(true);
    expect(run("attrs.a == attrs.b", { a, b })).toBe(true);
    expect(truthy(a)).toBe(true);
  });
});

describe("limits and robustness", () => {
  it("allows MAX_DEPTH levels and rejects one more", () => {
    const d = MAX_DEPTH;
    expect(run("(".repeat(d) + "1" + ")".repeat(d))).toBe(1);
    expect(run("abs(".repeat(d) + "1" + ")".repeat(d))).toBe(1);
    expect(run("[".repeat(d) + "]".repeat(d) + " == []")).toBe(false);
    expect(parseError("(".repeat(d + 1) + "1" + ")".repeat(d + 1)).offset).toBe(d);
    expect(run(Array(100000).fill("1").join(" + "))).toBe(100000);
    expect(run(Array(100000).fill("false").join(" || "))).toBe(false);
  });

  it("random token soups never throw anything but ExprError; evaluation never throws", () => {
    const atoms = ["attrs", "attrs.a", "attrs['b']", "id", "index", "text", "priority", "tier", "x", "y", "1", "0",
      "-0", "2.5", "1e308", "'s'", '"\\u00e9"', "true", "false", "null", "[1, 'a']", "[]", "len", "min", "coalesce",
      "number", "contains", "startsWith", "(", ")", "[", "]", ",", ".", "+", "-", "*", "/", "%", "==", "!=", "<",
      "<=", ">", ">=", "&&", "||", "!", "in", "not", "@", "'", "\\", "😀", "lower", "upper", "abs", "log", "log1p",
      "sqrt", "round", "floor", "ceil", "max", "endsWith", "foo"];
    const attrs = { a: [1, 2, { c: "x" }], b: -1.5, s: "Straße" };
    const rng = new Pcg32(99);
    let parsed = 0;
    for (let i = 0; i < 30000; i++) {
      const n = 1 + rng.nextBelow(12);
      const parts: string[] = [];
      for (let k = 0; k < n; k++) parts.push(atoms[rng.nextBelow(atoms.length)] as string);
      const src = parts.join(rng.nextU32() & 1 ? " " : "");
      let e: Expr | null = null;
      try {
        e = parseExpr(src);
      } catch (err) {
        expect(err).toBeInstanceOf(ExprError);
      }
      if (e) {
        parsed++;
        evalExpr(e, ctx(attrs, { priority: 1, tier: 2 }));
      }
    }
    expect(parsed).toBeGreaterThan(500);
  });
});
