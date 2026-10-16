//! Fonts: loading, vertical metrics and text measurement.

use std::borrow::Cow;

use crate::cmap::CharMap;
use crate::kern::Kerning;
use crate::reader::{Parsed, Reader};
use crate::unicode::needs_complex_shaping;
use crate::TextError;

/// A parsed font, holding everything simple shaping needs (spec §5.2).
///
/// Parsing happens once in [`Font::from_bytes`]: advances, the character map and the
/// pair-kerning lookups are flattened into lookup tables, so measuring is allocation-free
/// for short strings.
pub struct Font {
    units_per_em: u16,
    ascender: i16,
    descender: i16,
    line_gap: i16,
    advances: Vec<u16>,
    cmap: CharMap,
    kerning: Kerning,
    /// The sfnt bytes, kept for full shaping.
    #[cfg(feature = "shaping")]
    data: Cow<'static, [u8]>,
}

/// Which shaper measures a text (`text.shaping` of the problem).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Shaping {
    /// Simple shaping only: identical in every implementation.
    Simple,
    /// Full OpenType shaping (rustybuzz); simple shaping without the `shaping` feature.
    Full,
    /// Full shaping for texts that [need it](needs_complex_shaping), simple otherwise.
    #[default]
    Auto,
}

fn tag(name: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*name)
}

fn invalid(message: impl Into<String>) -> TextError {
    TextError::InvalidFont(message.into())
}

/// The table directory of an sfnt (TrueType, OpenType/CFF, or the first font of a
/// collection).
struct Tables<'a> {
    data: &'a [u8],
    /// (tag, offset, length)
    records: Vec<(u32, u32, u32)>,
}

impl<'a> Tables<'a> {
    fn parse(data: &'a [u8]) -> Result<Tables<'a>, TextError> {
        let r = Reader::new(data);
        let too_short = |_| invalid("the data is too short to be a font");
        let mut start = 0;
        if r.u32(0).map_err(too_short)? == tag(b"ttcf") {
            if r.u32(8).map_err(too_short)? == 0 {
                return Err(invalid("the font collection is empty"));
            }
            start = r.u32(12).map_err(too_short)? as usize;
        }
        let flavor = r.u32(start).map_err(too_short)?;
        if ![0x0001_0000, tag(b"true"), tag(b"OTTO")].contains(&flavor) {
            return Err(invalid("not a TrueType/OpenType font"));
        }
        let records = (|| -> Parsed<Vec<(u32, u32, u32)>> {
            let count = usize::from(r.u16(start + 4)?);
            r.check_array(start + 12, count, 16)?;
            (0..count)
                .map(|i| {
                    let at = start + 12 + 16 * i;
                    Ok((r.u32(at)?, r.u32(at + 8)?, r.u32(at + 12)?))
                })
                .collect()
        })()
        .map_err(too_short)?;
        Ok(Tables { data, records })
    }

    /// The first table with this tag; `None` if absent or outside the data.
    fn get(&self, name: &[u8; 4]) -> Option<Reader<'a>> {
        let &(_, offset, length) = self.records.iter().find(|record| record.0 == tag(name))?;
        Reader::new(self.data)
            .slice(offset as usize, length as usize)
            .ok()
    }

    fn required(&self, name: &[u8; 4]) -> Result<Reader<'a>, TextError> {
        self.get(name)
            .ok_or_else(|| invalid(format!("missing '{}' table", String::from_utf8_lossy(name))))
    }
}

fn malformed(name: &str) -> impl Fn(crate::reader::Malformed) -> TextError + '_ {
    move |_| invalid(format!("malformed '{name}' table"))
}

impl Font {
    /// Loads a TrueType or OpenType (CFF) font, the first font of a TrueType collection, or
    /// (with the `woff2` feature) a WOFF2 font. WOFF 1.0 is not supported.
    pub fn from_bytes(data: Vec<u8>) -> Result<Font, TextError> {
        match data.get(..4) {
            Some(b"wOF2") => Self::from_woff2(&data),
            Some(b"wOFF") => Err(TextError::Unsupported(
                "WOFF 1.0 fonts are not supported; use TTF, OTF or WOFF2".into(),
            )),
            _ => Self::parse(Cow::Owned(data)),
        }
    }

    #[cfg(feature = "woff2")]
    fn from_woff2(data: &[u8]) -> Result<Font, TextError> {
        let sfnt = wuff::decompress_woff2(data)
            .map_err(|_| invalid("the WOFF2 data cannot be decoded"))?;
        Self::parse(Cow::Owned(sfnt))
    }

    #[cfg(not(feature = "woff2"))]
    fn from_woff2(_: &[u8]) -> Result<Font, TextError> {
        Err(TextError::Unsupported(
            "WOFF2 fonts need the `woff2` feature of label-anything-text; use TTF or OTF".into(),
        ))
    }

    /// Loads a font embedded in the binary (no copy).
    #[cfg(feature = "bundled-font")]
    pub(crate) fn from_static(data: &'static [u8]) -> Result<Font, TextError> {
        Self::parse(Cow::Borrowed(data))
    }

    fn parse(data: Cow<'static, [u8]>) -> Result<Font, TextError> {
        let tables = Tables::parse(&data)?;
        let head = tables.required(b"head")?;
        let units_per_em = head.u16(18).map_err(malformed("head"))?;
        if !(16..=16384).contains(&units_per_em) {
            return Err(invalid(format!(
                "unitsPerEm {units_per_em} is outside 16..=16384"
            )));
        }
        let num_glyphs = tables
            .required(b"maxp")?
            .u16(4)
            .map_err(malformed("maxp"))?;
        if num_glyphs == 0 {
            return Err(invalid("the font has no glyphs"));
        }
        let hhea = tables.required(b"hhea")?;
        let hhea_values =
            (|| -> Parsed<_> { Ok((hhea.i16(4)?, hhea.i16(6)?, hhea.i16(8)?, hhea.u16(34)?)) })();
        let (mut ascender, mut descender, mut line_gap, long_metrics) =
            hhea_values.map_err(malformed("hhea"))?;
        // OS/2 typo metrics replace hhea when fsSelection bit 7 (USE_TYPO_METRICS) is set.
        if let Some(os2) = tables.get(b"OS/2") {
            let typo = (|| -> Parsed<_> {
                Ok((os2.u16(62)?, (os2.i16(68)?, os2.i16(70)?, os2.i16(72)?)))
            })();
            if let Ok((selection, metrics)) = typo {
                if selection & 0x0080 != 0 {
                    (ascender, descender, line_gap) = metrics;
                }
            }
        }
        let advances = Self::parse_advances(tables.required(b"hmtx")?, long_metrics, num_glyphs)?;
        let cmap = CharMap::parse(tables.required(b"cmap")?, num_glyphs)
            .map_err(malformed("cmap"))?
            .ok_or_else(|| invalid("no Unicode 'cmap' subtable of format 4 or 12"))?;
        let kerning = Kerning::parse(
            tables.get(b"GDEF"),
            tables.get(b"GPOS"),
            tables.get(b"kern"),
            num_glyphs,
        );
        Ok(Font {
            units_per_em,
            ascender,
            descender,
            line_gap,
            advances,
            cmap,
            kerning,
            #[cfg(feature = "shaping")]
            data,
        })
    }

    /// Advance of every glyph; glyphs past `numberOfHMetrics` repeat the last advance.
    fn parse_advances(
        hmtx: Reader,
        long_metrics: u16,
        num_glyphs: u16,
    ) -> Result<Vec<u16>, TextError> {
        if long_metrics == 0 {
            return Err(invalid("numberOfHMetrics is 0"));
        }
        let long_metrics = long_metrics.min(num_glyphs);
        let mut advances = (0..usize::from(long_metrics))
            .map(|g| hmtx.u16(4 * g))
            .collect::<Parsed<Vec<u16>>>()
            .map_err(malformed("hmtx"))?;
        let last = advances[advances.len() - 1];
        advances.resize(usize::from(num_glyphs), last);
        Ok(advances)
    }

    /// Font design units per em (`head.unitsPerEm`).
    pub fn units_per_em(&self) -> u16 {
        self.units_per_em
    }

    /// Ascender in font units: `hhea.ascender`, or `OS/2.sTypoAscender` when the font sets
    /// USE_TYPO_METRICS (spec §5.2).
    pub fn ascender(&self) -> i16 {
        self.ascender
    }

    /// Descender in font units, **negative** below the baseline as stored in the font
    /// (`hhea.descender` or `OS/2.sTypoDescender`). The spec's descent is `−descender`.
    pub fn descender(&self) -> i16 {
        self.descender
    }

    /// Line gap in font units (`hhea.lineGap` or `OS/2.sTypoLineGap`).
    pub fn line_gap(&self) -> i16 {
        self.line_gap
    }

    #[inline]
    fn glyph(&self, c: char) -> u16 {
        self.cmap.glyph(u32::from(c))
    }

    /// Simple shaping (spec §5.2): the sum of the `hmtx` advances of the glyphs the code
    /// points map to (unmapped → glyph 0) plus all pair-kerning adjustments, in font units.
    pub fn advance_units(&self, text: &str) -> i64 {
        let advance = |g: u16| i64::from(self.advances[usize::from(g)]);
        if self.kerning.is_empty() {
            return text.chars().map(|c| advance(self.glyph(c))).sum();
        }
        const STACK: usize = 128;
        let mut stack = [0u16; STACK];
        let mut heap = Vec::new();
        let buffer: &mut [u16] = if text.len() <= STACK {
            &mut stack
        } else {
            heap.resize(text.len(), 0);
            &mut heap
        };
        let mut total = 0;
        let mut n = 0;
        for c in text.chars() {
            let g = self.glyph(c);
            buffer[n] = g;
            n += 1;
            total += advance(g);
        }
        total + self.kerning.adjustment(&buffer[..n])
    }

    /// Width of `text` at `size` px with simple shaping:
    /// `advance_units(text) as f64 * size / units_per_em as f64`, in exactly this order, so
    /// the result is bit-identical in every implementation.
    pub fn width(&self, text: &str, size: f64) -> f64 {
        self.advance_units(text) as f64 * size / f64::from(self.units_per_em)
    }

    /// Width of `text` at `size` px with full OpenType shaping (rustybuzz, default
    /// features, so `kern` is on), scaled like [`Font::width`]. Equals [`Font::width`]
    /// without the `shaping` feature or if rustybuzz cannot read the font.
    pub fn width_shaped(&self, text: &str, size: f64) -> f64 {
        #[cfg(feature = "shaping")]
        {
            if let Some(face) = rustybuzz::Face::from_slice(&self.data, 0) {
                let mut buffer = rustybuzz::UnicodeBuffer::new();
                buffer.push_str(text);
                let glyphs = rustybuzz::shape(&face, &[], buffer);
                let units: i64 = glyphs
                    .glyph_positions()
                    .iter()
                    .map(|p| i64::from(p.x_advance))
                    .sum();
                return units as f64 * size / f64::from(self.units_per_em);
            }
        }
        self.width(text, size)
    }

    /// Width of `text` at `size` px with the given shaping mode.
    pub fn measure(&self, text: &str, size: f64, shaping: Shaping) -> f64 {
        let full = match shaping {
            Shaping::Simple => false,
            Shaping::Full => true,
            Shaping::Auto => needs_complex_shaping(text),
        };
        if full {
            self.width_shaped(text, size)
        } else {
            self.width(text, size)
        }
    }
}

impl std::fmt::Debug for Font {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Font")
            .field("units_per_em", &self.units_per_em)
            .field("ascender", &self.ascender)
            .field("descender", &self.descender)
            .field("line_gap", &self.line_gap)
            .field("num_glyphs", &self.advances.len())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REGULAR: &[u8] = include_bytes!("../assets/NotoSans-Regular.metrics.ttf");

    #[test]
    fn metrics_and_simple_shaping() {
        let font = Font::from_bytes(REGULAR.to_vec()).unwrap();
        assert_eq!(
            (
                font.units_per_em(),
                font.ascender(),
                font.descender(),
                font.line_gap()
            ),
            (1000, 1069, -293, 0)
        );
        assert_eq!(font.advance_units(""), 0);
        // simple shaping neither hides default ignorables nor normalizes
        assert_eq!(font.measure("A\u{200B}V", 1000.0, Shaping::Simple), 1239.0);
        let long = "The quick brown fox jumps over the lazy dog. ".repeat(20);
        assert_eq!(
            font.advance_units(&long),
            20 * font.advance_units(&long[..45])
        );
    }

    /// Reference values: HarfBuzz (uharfbuzz 0.56.3) with default features.
    #[cfg(feature = "shaping")]
    #[test]
    fn full_shaping_matches_harfbuzz() {
        let font = Font::from_bytes(REGULAR.to_vec()).unwrap();
        for (text, units) in [
            ("Hello, World", 5755.0),
            ("A\u{200B}V", 1199.0),
            ("x \u{2264} y \u{2260} z", 3721.0),
            ("co\u{AD}op", 2305.0),
        ] {
            assert_eq!(font.width_shaped(text, 1000.0), units, "{text:?}");
        }
        assert_eq!(font.measure("A\u{200B}V", 1000.0, Shaping::Full), 1199.0);
        assert_eq!(font.measure("A\u{200B}V", 1000.0, Shaping::Auto), 1239.0);
        let hebrew = "\u{5E9}\u{5DC}\u{5D5}\u{5DD}";
        assert_eq!(
            font.measure(hebrew, 12.0, Shaping::Auto),
            font.width_shaped(hebrew, 12.0)
        );
    }

    #[cfg(not(feature = "shaping"))]
    #[test]
    fn full_shaping_falls_back_to_simple() {
        let font = Font::from_bytes(REGULAR.to_vec()).unwrap();
        assert_eq!(font.width_shaped("A\u{200B}V", 1000.0), 1239.0);
    }
}
