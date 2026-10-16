use std::fmt;

/// Error code: the source does not match the grammar (also: number literal out of
/// range, invalid string escape, nesting deeper than [`crate::MAX_DEPTH`]).
pub const EXPR_SYNTAX: &str = "expr_syntax";
/// Error code: unknown variable or function name.
pub const EXPR_UNKNOWN_IDENTIFIER: &str = "expr_unknown_identifier";
/// Error code: a function called with the wrong number of arguments.
pub const EXPR_ARITY: &str = "expr_arity";

/// A parse error. Evaluation never fails; only [`crate::parse`] returns errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExprError {
    /// `expr_syntax`, `expr_unknown_identifier` or `expr_arity`.
    pub code: &'static str,
    /// Human-readable description (identical in the TypeScript implementation).
    pub message: String,
    /// Offset of the offending token in Unicode code points (= the source length for
    /// an unexpected end of input).
    pub offset: usize,
}

impl ExprError {
    pub(crate) fn new(code: &'static str, offset: usize, message: impl Into<String>) -> Self {
        ExprError {
            code,
            message: message.into(),
            offset,
        }
    }

    pub(crate) fn syntax(offset: usize, message: impl Into<String>) -> Self {
        Self::new(EXPR_SYNTAX, offset, message)
    }
}

impl fmt::Display for ExprError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} at offset {}: {}",
            self.code, self.offset, self.message
        )
    }
}

impl std::error::Error for ExprError {}
