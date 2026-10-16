//! Image decoding (PNG, JPEG, WebP) and raster `source` strings (spec §4.6).

use crate::base64::source_bytes;
use crate::error::{RasterError, RasterErrorKind};
use crate::rgba::Rgba;

/// Image formats recognized by their file signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ImageFormat {
    /// PNG (`89 50 4E 47 0D 0A 1A 0A`).
    Png,
    /// JPEG (`FF D8 FF`).
    Jpeg,
    /// WebP (`RIFF ···· WEBP`).
    WebP,
}

impl ImageFormat {
    /// Recognizes PNG, JPEG and WebP by their signature.
    pub fn sniff(bytes: &[u8]) -> Option<Self> {
        if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
            Some(Self::Png)
        } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
            Some(Self::Jpeg)
        } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
            Some(Self::WebP)
        } else {
            None
        }
    }

    /// The media type (`image/png`, `image/jpeg`, `image/webp`).
    pub fn mime_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::WebP => "image/webp",
        }
    }
}

/// Decodes a PNG, JPEG or WebP file to RGBA8 (straight alpha).
///
/// Conversions (identical to the TypeScript PNG decoder): grey and palette images are
/// expanded (low bit depths scaled by `255 / (2^bits − 1)`), `tRNS` becomes alpha, and
/// 16-bit samples become `(v + 128) div 257`. Gamma, colour profiles and other colour
/// metadata are ignored; for animated images the default image is decoded. Decoded
/// samples are limited to 512 MiB (`limit_exceeded`).
///
/// Requires the `decode` cargo feature (default); without it every recognized image is
/// an `unsupported` error. Unknown signatures are `unsupported_format`, broken files
/// `corrupt_image`.
pub fn decode(bytes: &[u8]) -> Result<Rgba, RasterError> {
    let Some(format) = ImageFormat::sniff(bytes) else {
        return Err(RasterError::new(
            RasterErrorKind::UnsupportedFormat,
            "not a PNG, JPEG or WebP image",
        ));
    };
    decode_format(bytes, format)
}

/// Decodes a raster `source` string: a `data:` URL (base64 or percent-encoded) or bare
/// base64 of a PNG, JPEG or WebP file. File paths are resolved by the callers.
pub fn decode_source(src: &str) -> Result<Rgba, RasterError> {
    decode(&source_bytes(src)?)
}

#[cfg(feature = "decode")]
fn decode_format(bytes: &[u8], format: ImageFormat) -> Result<Rgba, RasterError> {
    if format == ImageFormat::Png {
        png_precheck(bytes)?;
    }
    let image_format = match format {
        ImageFormat::Png => image::ImageFormat::Png,
        ImageFormat::Jpeg => image::ImageFormat::Jpeg,
        ImageFormat::WebP => image::ImageFormat::WebP,
    };
    let img = image::load_from_memory_with_format(bytes, image_format).map_err(map_image_error)?;
    let rgba = img.into_rgba8();
    let (width, height) = rgba.dimensions();
    Rgba::new(width, height, rgba.into_raw())
}

#[cfg(not(feature = "decode"))]
fn decode_format(_bytes: &[u8], format: ImageFormat) -> Result<Rgba, RasterError> {
    Err(RasterError::new(
        RasterErrorKind::Unsupported,
        format!(
            "cannot decode {}: label-anything-raster was built without the `decode` feature",
            format.mime_type()
        ),
    ))
}

#[cfg(feature = "decode")]
fn map_image_error(e: image::ImageError) -> RasterError {
    use image::ImageError as E;
    let kind = match &e {
        E::Limits(_) => RasterErrorKind::LimitExceeded,
        E::Unsupported(_) => RasterErrorKind::Unsupported,
        _ => RasterErrorKind::CorruptImage,
    };
    RasterError::new(kind, e.to_string())
}

/// Rejects PNG structures that the `png` crate does not handle gracefully: a `PLTE`
/// chunk (before the image data) whose length is not a multiple of 3. The TypeScript
/// decoder applies the same rule.
#[cfg(feature = "decode")]
fn png_precheck(bytes: &[u8]) -> Result<(), RasterError> {
    let mut pos = 8usize;
    while let Some(header) = bytes.get(pos..pos + 8) {
        let len = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
        let kind = &header[4..8];
        if kind == b"PLTE" && !len.is_multiple_of(3) {
            return Err(RasterError::new(
                RasterErrorKind::CorruptImage,
                format!("PNG PLTE chunk length {len} is not a multiple of 3"),
            ));
        }
        if kind == b"IDAT" || kind == b"IEND" {
            break;
        }
        pos = pos.saturating_add(12).saturating_add(len);
    }
    Ok(())
}
