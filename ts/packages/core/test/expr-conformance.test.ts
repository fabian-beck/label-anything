// Runs conformance/expr/*.json (format: conformance/README.md, "expr cases"). Values must
// be identical: numbers by Object.is (so -0 !== 0), strings, lists and objects structurally.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ExprContext, Value } from "../src/expr/index.js";
import { evalExpr, ExprError, exprMatches, exprNumber, parseExpr, termNumber, truthy } from "../src/expr/index.js";

// LA_EXPR_CONFORMANCE_DIR runs another directory of expr cases (e.g. a large generated suite).
const DIR = process.env.LA_EXPR_CONFORMANCE_DIR
  ? process.env.LA_EXPR_CONFORMANCE_DIR.replace(/\/?$/, "/")
  : fileURLToPath(new URL("../../../../conformance/expr/", import.meta.url));

interface Case {
  expr: string;
  context?: Partial<ExprContext>;
  value?: Value;
  truthy?: boolean;
  term?: number | null;
  error?: string;
  offset?: number;
}

interface File {
  kind: string;
  name: string;
  context?: Partial<ExprContext>;
  cases: Case[];
}

function identical(a: Value, b: Value): boolean {
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => identical(x, b[i] as Value));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && identical(a[k] as Value, b[k] as Value));
  }
  return a === b;
}

function context(file: File, c: Case): ExprContext {
  return { attrs: {}, id: "", index: 0, text: "", priority: null, tier: null, x: 0, y: 0, ...file.context, ...c.context };
}

function run(file: File, c: Case): string | null {
  let expr;
  try {
    expr = parseExpr(c.expr);
  } catch (e) {
    if (!(e instanceof ExprError)) return `non-ExprError thrown: ${String(e)}`;
    if (c.error === undefined) return `unexpected error ${e.code} at ${e.offset}: ${e.message}`;
    if (e.code !== c.error) return `expected ${c.error}, got ${e.code} (${e.message})`;
    if (c.offset !== undefined && e.offset !== c.offset) return `expected offset ${c.offset}, got ${e.offset} (${e.message})`;
    if (!e.message) return "empty message";
    return null;
  }
  if (c.error !== undefined) return `expected error ${c.error}, parsed fine`;
  const cx = context(file, c);
  const got = evalExpr(expr, cx);
  if (!("value" in c)) return "case has neither value nor error";
  if (!identical(got, c.value as Value)) return `got ${JSON.stringify(got)}, want ${JSON.stringify(c.value)}`;
  if (c.truthy !== undefined && (truthy(got) !== c.truthy || exprMatches(expr, cx) !== c.truthy)) {
    return `truthy: want ${c.truthy}`;
  }
  if ("term" in c) {
    const want = c.term ?? null;
    const same = (v: number | null) => (v === null ? want === null : want !== null && Object.is(v, want));
    if (!same(termNumber(got)) || !same(exprNumber(expr, cx))) return `term: got ${termNumber(got)}, want ${want}`;
  }
  return null;
}

describe("conformance/expr", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
  let total = 0;
  for (const name of files) {
    const file = JSON.parse(readFileSync(DIR + name, "utf8")) as File;
    total += file.cases.length;
    it(name, () => {
      expect(file.kind).toBe("expr");
      const failures: string[] = [];
      for (const c of file.cases) {
        const msg = run(file, c);
        if (msg !== null) failures.push(`${JSON.stringify(c.expr.slice(0, 80))}: ${msg}`);
      }
      expect(failures).toEqual([]);
    });
  }
  it("has at least 200 cases", () => {
    expect(total).toBeGreaterThanOrEqual(200);
  });
});
