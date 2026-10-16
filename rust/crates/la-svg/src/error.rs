//! Structured errors and warnings (codes shared with `@label-anything/svg`).

use std::fmt;

/// Machine-readable error / warning code. The string forms are shared with the
/// TypeScript implementation and listed in `conformance/svg/README.md`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "snake_case"))]
pub enum SvgErrorCode {
    /// The input is not well-formed XML.
    Parse,
    /// Well-formed XML that is not a usable SVG document (e.g. the root is not `<svg>`),
    /// or invalid options (non-positive canvas, tolerance, ...).
    InvalidValue,
    /// Selector syntax error.
    Pattern,
    /// A resource limit was exceeded (nesting depth, element count, `<use>` expansion, ...).
    Limit,
    /// Warning only: part of the document was ignored (e.g. a `<use>` with a missing target).
    Ignored,
}

impl SvgErrorCode {
    /// The shared string form (`"parse"`, `"invalid_value"`, `"pattern"`, `"limit"`, `"ignored"`).
    pub const fn as_str(self) -> &'static str {
        match self {
            SvgErrorCode::Parse => "parse",
            SvgErrorCode::InvalidValue => "invalid_value",
            SvgErrorCode::Pattern => "pattern",
            SvgErrorCode::Limit => "limit",
            SvgErrorCode::Ignored => "ignored",
        }
    }
}

impl fmt::Display for SvgErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A structured error (or warning, see [`crate::Scene::warnings`]).
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct SvgError {
    /// Machine-readable code.
    pub code: SvgErrorCode,
    /// Human-readable message (not part of the cross-implementation contract).
    pub message: String,
}

impl SvgError {
    pub(crate) fn new(code: SvgErrorCode, message: impl Into<String>) -> Self {
        SvgError {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for SvgError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for SvgError {}
