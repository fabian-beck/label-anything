//! The error type of the crate.

use std::fmt;

/// Error returned when font data cannot be loaded.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum TextError {
    /// The data is not a usable TrueType/OpenType font; the message says why.
    InvalidFont(String),
    /// The data is a font format this build cannot read (WOFF 1.0, or WOFF2 without the
    /// `woff2` feature).
    Unsupported(String),
}

impl fmt::Display for TextError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TextError::InvalidFont(msg) => write!(f, "invalid font: {msg}"),
            TextError::Unsupported(msg) => write!(f, "unsupported font format: {msg}"),
        }
    }
}

impl std::error::Error for TextError {}
