//! Decoded raster images.

use std::fmt;

use crate::base64::decode_base64;
use crate::error::{RasterError, RasterErrorKind};

/// A decoded raster: row-major RGBA8 with straight (non-premultiplied) alpha.
///
/// `data.len()` must be `width * height * 4`; [`Rgba::new`] checks this. [`process`]
/// and [`estimate_background`] treat an inconsistent value as an empty image.
///
/// [`process`]: crate::process
/// [`estimate_background`]: crate::estimate_background
#[derive(Clone, PartialEq, Eq, Hash, Default)]
pub struct Rgba {
    /// Width in raster pixels.
    pub width: u32,
    /// Height in raster pixels.
    pub height: u32,
    /// `width * height` pixels of 4 bytes (R, G, B, A), row by row from the top.
    pub data: Vec<u8>,
}

impl fmt::Debug for Rgba {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Rgba")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("data", &format_args!("[{} bytes]", self.data.len()))
            .finish()
    }
}

/// `width * height * 4` if both are non-zero and the product fits in `usize`.
pub(crate) fn rgba_len(width: u32, height: u32) -> Option<usize> {
    if width == 0 || height == 0 {
        return None;
    }
    (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(4)
}

impl Rgba {
    /// Wraps raw RGBA8 pixels after checking the dimensions.
    pub fn new(width: u32, height: u32, data: Vec<u8>) -> Result<Self, RasterError> {
        let Some(expected) = rgba_len(width, height) else {
            return Err(RasterError::new(
                RasterErrorKind::InvalidDimensions,
                format!("invalid raster dimensions {width}x{height}"),
            ));
        };
        if data.len() != expected {
            return Err(RasterError::new(
                RasterErrorKind::InvalidDimensions,
                format!(
                    "RGBA data of a {width}x{height} raster must have {expected} bytes, got {}",
                    data.len()
                ),
            ));
        }
        Ok(Self {
            width,
            height,
            data,
        })
    }

    /// `true` if the dimensions are non-zero and match the length of `data`.
    pub fn is_valid(&self) -> bool {
        rgba_len(self.width, self.height) == Some(self.data.len())
    }
}

/// Builds an [`Rgba`] from base64-encoded raw pixels (`rgba.data` of a raster source:
/// `width * height * 4` bytes, row-major RGBA8, straight alpha).
pub fn rgba_from_base64(width: u32, height: u32, b64: &str) -> Result<Rgba, RasterError> {
    Rgba::new(width, height, decode_base64(b64)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_dimensions() {
        assert!(Rgba::new(1, 1, vec![0; 4]).is_ok());
        assert_eq!(
            Rgba::new(0, 1, vec![]).unwrap_err().kind,
            RasterErrorKind::InvalidDimensions
        );
        assert_eq!(
            Rgba::new(2, 1, vec![0; 4]).unwrap_err().kind,
            RasterErrorKind::InvalidDimensions
        );
        assert_eq!(
            Rgba::new(u32::MAX, u32::MAX, vec![]).unwrap_err().kind,
            RasterErrorKind::InvalidDimensions
        );
        let img = rgba_from_base64(1, 1, "AQIDBA==").unwrap();
        assert_eq!(img.data, [1, 2, 3, 4]);
        assert!(rgba_from_base64(2, 1, "AQIDBA==").is_err());
        assert!(!Rgba {
            width: 2,
            height: 2,
            data: vec![0; 3]
        }
        .is_valid());
    }
}
