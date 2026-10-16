/**
 * Syntax tree (port of rust/crates/la-expr/src/ast.rs). Operator, postfix and method
 * chains are flat arrays, so tree depth is bounded by the nesting limit.
 *
 * @module
 */

export type VarName = "attrs" | "id" | "index" | "text" | "priority" | "tier" | "x" | "y";

export type FuncName =
  | "abs"
  | "min"
  | "max"
  | "log"
  | "sqrt"
  | "floor"
  | "ceil"
  | "round"
  | "log1p"
  | "len"
  | "lower"
  | "upper"
  | "number"
  | "startsWith"
  | "endsWith"
  | "contains"
  | "coalesce";

export const VARIABLES: ReadonlySet<string> = new Set(["attrs", "id", "index", "text", "priority", "tier", "x", "y"]);

/** Arity: [count, variadic] — exactly `count` arguments, or at least `count` if variadic. */
export const FUNCTIONS: { readonly [name: string]: readonly [number, boolean] } = {
  abs: [1, false],
  min: [1, true],
  max: [1, true],
  log: [1, false],
  sqrt: [1, false],
  floor: [1, false],
  ceil: [1, false],
  round: [1, false],
  log1p: [1, false],
  len: [1, false],
  lower: [1, false],
  upper: [1, false],
  number: [1, false],
  startsWith: [2, false],
  endsWith: [2, false],
  contains: [2, false],
  coalesce: [1, true],
};

export type CmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=";
export type ArithOp = "+" | "-" | "*" | "/" | "%";

export type PostOp =
  | { k: "member"; name: string }
  | { k: "index"; index: Node }
  | { k: "method"; f: FuncName; args: Node[] };

export type Node =
  | { k: "null" }
  | { k: "bool"; v: boolean }
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "var"; v: VarName }
  | { k: "list"; items: Node[] }
  | { k: "not"; e: Node }
  | { k: "neg"; e: Node }
  | { k: "and"; items: Node[] }
  | { k: "or"; items: Node[] }
  | { k: "cmp"; op: CmpOp; l: Node; r: Node }
  | { k: "in"; lhs: Node; list: Node[]; negate: boolean }
  | { k: "arith"; first: Node; ops: ArithOp[]; rest: Node[] }
  | { k: "postfix"; base: Node; ops: PostOp[] }
  | { k: "call"; f: FuncName; args: Node[] };
