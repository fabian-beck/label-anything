/** Error codes of the expression language (shared with validation). */
export type ExprErrorCode = "expr_syntax" | "expr_unknown_identifier" | "expr_arity";

export const EXPR_SYNTAX: ExprErrorCode = "expr_syntax";
export const EXPR_UNKNOWN_IDENTIFIER: ExprErrorCode = "expr_unknown_identifier";
export const EXPR_ARITY: ExprErrorCode = "expr_arity";

/**
 * A parse error (evaluation never fails). `offset` is the position of the offending
 * token in Unicode code points (the source length for an unexpected end of input);
 * `message` is identical to the Rust implementation's.
 */
export class ExprError extends Error {
  readonly code: ExprErrorCode;
  readonly offset: number;

  constructor(code: ExprErrorCode, message: string, offset: number) {
    super(message);
    this.name = "ExprError";
    this.code = code;
    this.offset = offset;
  }
}
