//! Structured errors of the raster crate.

use std::fmt;

/// The kind of a [`RasterError`].
///
/// [`RasterErrorKind::code`] is a stable string shared with the TypeScript implementation
/// (`@label-anything/raster`), so callers on every platform can branch on the same codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum RasterErrorKind {
    /// Base64 text with an invalid character, misplaced padding or a truncated quantum.
    InvalidBase64,
    /// A malformed `data:` URL (no `,`, bad percent escape).
    InvalidDataUrl,
    /// The bytes are not a PNG, JPEG or WebP image (unknown signature).
    UnsupportedFormat,
    /// The image format was recognized, but the file is corrupt or truncated.
    CorruptImage,
    /// Zero or overflowing dimensions, or pixel data whose length does not match them.
    InvalidDimensions,
    /// The decoded image would exceed the memory limit (512 MiB of decoded samples).
    LimitExceeded,
    /// The operation is not available in this build or environment (for example
    /// decoding without the `decode` cargo feature).
    Unsupported,
}

impl RasterErrorKind {
    /// The stable machine-readable code (`snake_case`).
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidBase64 => "invalid_base64",
            Self::InvalidDataUrl => "invalid_data_url",
            Self::UnsupportedFormat => "unsupported_format",
            Self::CorruptImage => "corrupt_image",
            Self::InvalidDimensions => "invalid_dimensions",
            Self::LimitExceeded => "limit_exceeded",
            Self::Unsupported => "unsupported",
        }
    }
}

impl fmt::Display for RasterErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

/// An error from decoding or validating a raster source. Never a panic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RasterError {
    /// What went wrong (see [`RasterErrorKind::code`] for the stable code).
    pub kind: RasterErrorKind,
    /// Human-readable details.
    pub message: String,
}

impl RasterError {
    /// Creates an error of the given kind.
    pub fn new(kind: RasterErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    /// The stable machine-readable code of [`Self::kind`].
    pub fn code(&self) -> &'static str {
        self.kind.code()
    }
}

impl fmt::Display for RasterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind.code(), self.message)
    }
}

impl std::error::Error for RasterError {}
