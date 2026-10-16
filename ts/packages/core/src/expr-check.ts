/**
 * Expression checks of `validate` (`expr_syntax`, `expr_unknown_identifier`,
 * `expr_arity`).
 *
 * `validate.rs` calls `la_expr::parse` on every `priority.tiers[].where`,
 * `priority.terms[].expr` and `priority.coverage.by` string and reports a failure as
 * `Issue::new(ptr, e.code, format!("{} (at {})", e.message, e.offset))`. Every expression
 * check of `validate.ts` goes through {@link checkExpr}, which builds the same code and
 * message from the TypeScript parser (`expr/`, identical codes, messages and code-point
 * offsets).
 */
import { ExprError, parseExpr } from "./expr/index.js";

/** Code and message of the issue for an invalid expression, or `null` if `src` parses. */
export function checkExpr(src: string): { code: string; message: string } | null {
  try {
    parseExpr(src);
    return null;
  } catch (e) {
    if (e instanceof ExprError) return { code: e.code, message: `${e.message} (at ${e.offset})` };
    throw e;
  }
}
