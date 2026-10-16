/**
 * Label Anything expression language (spec/expr.peg), a port of
 * rust/crates/la-expr with identical results (tested by conformance/expr/*.json).
 *
 * ```ts
 * const e = parseExpr("attrs.category == 'core' && attrs.cbo > 10");
 * evalExpr(e, { attrs: { category: "core", cbo: 41 }, id: "a", index: 0, text: "", x: 0, y: 0 }); // true
 * ```
 *
 * Parsing is the only step that can fail (it throws {@link ExprError}); evaluation is
 * total and never throws.
 *
 * @module
 */

import type { Node } from "./ast.js";
import type { ExprContext } from "./eval.js";
import { ev } from "./eval.js";
import { parseNode } from "./parser.js";
import type { Value } from "./value.js";
import { termNumber, truthy } from "./value.js";

export type { ExprErrorCode } from "./error.js";
export { EXPR_ARITY, EXPR_SYNTAX, EXPR_UNKNOWN_IDENTIFIER, ExprError } from "./error.js";
export type { ExprContext } from "./eval.js";
export { MAX_DEPTH } from "./parser.js";
export type { Value } from "./value.js";
export { compareCodePoints, termNumber, truthy, valuesEqual } from "./value.js";

/** A parsed expression; parse once, evaluate for many items. */
export class Expr {
  /** @internal */
  readonly root: Node;
  /** The source text. */
  readonly source: string;

  /** @internal Use {@link parseExpr}. */
  constructor(root: Node, source: string) {
    this.root = root;
    this.source = source;
  }
}

/**
 * Parses an expression. Throws {@link ExprError} with `code` (`expr_syntax`,
 * `expr_unknown_identifier`, `expr_arity`), `message` and the code-point `offset` of the
 * first error in reading order.
 */
export function parseExpr(src: string): Expr {
  return new Expr(parseNode(src), src);
}

/** Evaluates an expression for one item. Never throws. */
export function evalExpr(expr: Expr, ctx: ExprContext): Value {
  return ev(expr.root, ctx);
}

/** `truthy(evalExpr(expr, ctx))` (where-clauses). */
export function exprMatches(expr: Expr, ctx: ExprContext): boolean {
  return truthy(ev(expr.root, ctx));
}

/** `termNumber(evalExpr(expr, ctx))` (priority terms; null = missing). */
export function exprNumber(expr: Expr, ctx: ExprContext): number | null {
  return termNumber(ev(expr.root, ctx));
}
