//! Label Anything expression language (`spec/expr.peg`) and deterministic math.
//!
//! Expressions are used by `priority.tiers[].where`, `priority.terms[].expr` and
//! `priority.coverage.by`. They are small, safe and side-effect free: parsing is the only
//! step that can fail ([`ExprError`]); evaluation is total and never panics.
//!
//! ```
//! use label_anything_expr::{parse, Context, Value};
//!
//! let attrs = Value::from(&serde_json::json!({ "category": "core", "cbo": 41 }));
//! let expr = parse("attrs.category == 'core' && attrs.cbo > 10").unwrap();
//! assert_eq!(expr.eval(&Context::new(&attrs)), Value::Bool(true));
//! ```
//!
//! [`det_math`] holds the deterministic math functions and the PCG32 generator shared bit
//! for bit with the TypeScript implementation (`ts/packages/core/src/detmath.ts`,
//! `pcg.ts`, `expr/`).

mod ast;
pub mod det_math;
mod error;
mod eval;
mod lexer;
mod parser;
mod value;

pub use error::{ExprError, EXPR_ARITY, EXPR_SYNTAX, EXPR_UNKNOWN_IDENTIFIER};
pub use eval::Context;
pub use parser::MAX_DEPTH;
pub use value::{term_number, truthy, values_equal, Value};

/// A parsed expression; parse once, evaluate for many items.
#[derive(Debug, Clone)]
pub struct Expr {
    root: ast::Node,
    source: String,
}

/// Parses an expression (`spec/expr.peg`). Errors carry the code (`expr_syntax`,
/// `expr_unknown_identifier`, `expr_arity`) and the code-point offset of the first error
/// in reading order.
pub fn parse(src: &str) -> Result<Expr, ExprError> {
    Ok(Expr {
        root: parser::parse_node(src)?,
        source: src.to_string(),
    })
}

impl Expr {
    /// Evaluates the expression for one item. Never fails.
    pub fn eval(&self, ctx: &Context) -> Value {
        eval::eval(&self.root, ctx).into_value()
    }

    /// `truthy(self.eval(ctx))` without materializing the result (where-clauses).
    pub fn matches(&self, ctx: &Context) -> bool {
        eval::truthy_v(&eval::eval(&self.root, ctx))
    }

    /// `term_number(&self.eval(ctx))` without materializing the result (priority terms).
    pub fn eval_number(&self, ctx: &Context) -> Option<f64> {
        eval::term_number_v(&eval::eval(&self.root, ctx))
    }

    /// The source text the expression was parsed from.
    pub fn source(&self) -> &str {
        &self.source
    }
}

impl std::str::FromStr for Expr {
    type Err = ExprError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        parse(s)
    }
}

#[cfg(test)]
mod tests;
