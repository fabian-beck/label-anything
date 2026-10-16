/**
 * Evaluator (port of rust/crates/la-expr/src/eval.rs). Total: never throws.
 *
 * @module
 */

import type { ArithOp, CmpOp, FuncName, Node, PostOp, VarName } from "./ast.js";
import { numberLen } from "./lexer.js";
import type { Value } from "./value.js";
import { codePointLength, compareCodePoints, isObject, member, norm, truthy, valuesEqual } from "./value.js";
import { ceil, floor, ln, ln1p, roundHalfAway, sqrt } from "../detmath.js";

/** Everything an expression can read about one item. */
export interface ExprContext {
  /** The item's attrs ({} when the item has none). JSON data. */
  attrs: Value;
  /** Item id. */
  id: string;
  /** Input index (0-based). */
  index: number;
  /** Label text ("" for non-text labels). */
  text: string;
  /** Explicit item.priority, or null. */
  priority?: number | null;
  /** Explicit item.tier, or null. */
  tier?: number | null;
  /** Anchor reference point in canvas px. */
  x: number;
  y: number;
}

/** A number result: non-finite → null. */
function num(x: number): Value {
  return Number.isFinite(x) ? x : null;
}

function variable(v: VarName, cx: ExprContext): Value {
  switch (v) {
    case "attrs":
      return norm(cx.attrs);
    case "id":
      return typeof cx.id === "string" ? cx.id : "";
    case "index":
      return num(cx.index);
    case "text":
      return typeof cx.text === "string" ? cx.text : "";
    case "priority":
      return typeof cx.priority === "number" ? num(cx.priority) : null;
    case "tier":
      return typeof cx.tier === "number" ? num(cx.tier) : null;
    case "x":
      return num(cx.x);
    case "y":
      return num(cx.y);
  }
}

function arith(op: ArithOp, a: Value, b: Value): Value {
  if (typeof a === "number" && typeof b === "number") {
    switch (op) {
      case "+":
        return num(a + b);
      case "-":
        return num(a - b);
      case "*":
        return num(a * b);
      case "/":
        return b === 0 ? null : num(a / b);
      case "%":
        return b === 0 ? null : num(a % b);
    }
  }
  if (op === "+" && typeof a === "string" && typeof b === "string") return a + b;
  return null;
}

/** < <= > >=: numbers numerically, strings by code points, anything else false. */
function order(op: CmpOp, a: Value, b: Value): boolean {
  let c: number;
  if (typeof a === "number" && typeof b === "number") {
    if (a < b) c = -1;
    else if (a > b) c = 1;
    else if (a === b) c = 0;
    else return false;
  } else if (typeof a === "string" && typeof b === "string") {
    c = compareCodePoints(a, b);
  } else {
    return false;
  }
  switch (op) {
    case "<":
      return c < 0;
    case "<=":
      return c <= 0;
    case ">":
      return c > 0;
    case ">=":
      return c >= 0;
    default:
      return false;
  }
}

function index(base: Value, key: Value): Value {
  if (isObject(base)) return typeof key === "string" ? member(base, key) : null;
  if (Array.isArray(base) && typeof key === "number") {
    if (key >= 0 && key < base.length && floor(key) === key) return norm(base[key]);
  }
  return null;
}

/** number(s): the Number rule with an optional leading '-', surrounded by [ \t\r\n]*. */
function parseNumberString(s: string): Value {
  const isWs = (c: number) => c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;
  let a = 0;
  let b = s.length;
  while (a < b && isWs(s.charCodeAt(a))) a++;
  while (b > a && isWs(s.charCodeAt(b - 1))) b--;
  let neg = false;
  if (a < b && s.charCodeAt(a) === 0x2d) {
    neg = true;
    a++;
  }
  const body = s.slice(a, b);
  const at = (k: number) => {
    if (k >= body.length) return 0;
    const c = body.charCodeAt(k);
    return c < 0x80 ? c : 0;
  };
  if (body.length === 0 || numberLen(at, 0) !== body.length) return null;
  const v = Number(body);
  if (!Number.isFinite(v)) return null;
  return neg ? -v : v;
}

const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
const asciiUpper = (s: string) => s.replace(/[a-z]+/g, (m) => m.toUpperCase());

/** Lazily evaluated call arguments; for method calls the receiver is argument 0. */
class Args {
  constructor(
    private readonly recv: Value | undefined,
    private readonly nodes: Node[],
    private readonly cx: ExprContext,
  ) {}

  get length(): number {
    return this.nodes.length + (this.recv === undefined ? 0 : 1);
  }

  get(i: number): Value {
    if (this.recv !== undefined) {
      if (i === 0) return this.recv;
      i -= 1;
    }
    const n = this.nodes[i];
    return n === undefined ? null : ev(n, this.cx);
  }
}

function call(f: FuncName, recv: Value | undefined, nodes: Node[], cx: ExprContext): Value {
  const a = new Args(recv, nodes, cx);
  switch (f) {
    case "abs":
    case "floor":
    case "ceil":
    case "round":
    case "log":
    case "log1p":
    case "sqrt": {
      const x = a.get(0);
      if (typeof x !== "number") return null;
      switch (f) {
        case "abs":
          return num(Math.abs(x));
        case "floor":
          return num(floor(x));
        case "ceil":
          return num(ceil(x));
        case "round":
          return num(roundHalfAway(x));
        case "log":
          return x > 0 ? num(ln(x)) : null;
        case "log1p":
          return x > -1 ? num(ln1p(x)) : null;
        default:
          return x >= 0 ? num(sqrt(x)) : null;
      }
    }
    case "min":
    case "max": {
      const first = a.get(0);
      if (typeof first !== "number") return null;
      let acc = first;
      for (let i = 1; i < a.length; i++) {
        const x = a.get(i);
        if (typeof x !== "number") return null;
        if ((f === "min" && x < acc) || (f === "max" && x > acc)) acc = x;
      }
      return acc;
    }
    case "len": {
      const v = a.get(0);
      if (typeof v === "string") return codePointLength(v);
      if (Array.isArray(v)) return v.length;
      return null;
    }
    case "lower":
    case "upper": {
      const v = a.get(0);
      if (typeof v !== "string") return null;
      return f === "lower" ? asciiLower(v) : asciiUpper(v);
    }
    case "number": {
      const v = a.get(0);
      if (typeof v === "number") return v;
      if (typeof v === "boolean") return v ? 1 : 0;
      if (typeof v === "string") return parseNumberString(v);
      return null;
    }
    case "startsWith":
    case "endsWith": {
      const s = a.get(0);
      const p = a.get(1);
      if (typeof s !== "string" || typeof p !== "string") return null;
      return f === "startsWith" ? s.startsWith(p) : s.endsWith(p);
    }
    case "contains": {
      const s = a.get(0);
      const n = a.get(1);
      if (typeof s === "string" && typeof n === "string") return s.includes(n);
      if (Array.isArray(s)) {
        for (const e of s) if (valuesEqual(norm(e), n)) return true;
        return false;
      }
      return null;
    }
    case "coalesce": {
      for (let i = 0; i < a.length; i++) {
        const v = a.get(i);
        if (v !== null) return v;
      }
      return null;
    }
  }
}

function postfix(base: Node, ops: PostOp[], cx: ExprContext): Value {
  let cur = ev(base, cx);
  for (const op of ops) {
    switch (op.k) {
      case "member":
        cur = isObject(cur) ? member(cur, op.name) : null;
        break;
      case "index":
        cur = index(cur, ev(op.index, cx));
        break;
      case "method":
        cur = call(op.f, cur, op.args, cx);
        break;
    }
  }
  return cur;
}

/** Evaluates a syntax tree. */
export function ev(n: Node, cx: ExprContext): Value {
  switch (n.k) {
    case "null":
      return null;
    case "bool":
    case "num":
    case "str":
      return n.v;
    case "var":
      return variable(n.v, cx);
    case "list":
      return n.items.map((i) => ev(i, cx));
    case "not":
      return !truthy(ev(n.e, cx));
    case "neg": {
      const v = ev(n.e, cx);
      return typeof v === "number" ? -v : null;
    }
    case "and":
      for (const i of n.items) if (!truthy(ev(i, cx))) return false;
      return true;
    case "or":
      for (const i of n.items) if (truthy(ev(i, cx))) return true;
      return false;
    case "cmp": {
      const a = ev(n.l, cx);
      const b = ev(n.r, cx);
      if (n.op === "==") return valuesEqual(a, b);
      if (n.op === "!=") return !valuesEqual(a, b);
      return order(n.op, a, b);
    }
    case "in": {
      const a = ev(n.lhs, cx);
      for (const i of n.list) if (valuesEqual(a, ev(i, cx))) return !n.negate;
      return n.negate;
    }
    case "arith": {
      let acc = ev(n.first, cx);
      for (let i = 0; i < n.rest.length; i++) {
        acc = arith(n.ops[i] as ArithOp, acc, ev(n.rest[i] as Node, cx));
      }
      return acc;
    }
    case "postfix":
      return postfix(n.base, n.ops, cx);
    case "call":
      return call(n.f, undefined, n.args, cx);
  }
}
