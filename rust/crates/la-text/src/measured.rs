//! Constant-time widths of the substrings of a text with simple shaping (spec §5.2).

use crate::kern::KerningRanges;
use crate::Font;

/// A text prepared for measuring its substrings with simple shaping.
///
/// Simple shaping adds up integer glyph advances and pair-kerning adjustments, so one
/// linear-time pass over the text answers every code point range in constant time:
/// prefix sums of the advances, plus, per kerning lookup, the adjustments its walk (spec
/// §5.2) adds from every position on. The ranges are exact: `advance_units(start, end)`
/// equals [`Font::advance_units`] of the code points `start..end` for every range, so
/// [`MeasuredText::width`] is bit-identical to [`Font::width`]. The wrapping functions
/// measure their candidate lines this way with [`Measure::Font`](crate::Measure::Font).
///
/// ```
/// # #[cfg(feature = "bundled-font")] {
/// use label_anything_text::{FontBook, MeasuredText};
///
/// let book = FontBook::with_bundled();
/// let font = book.font(book.resolve("default", 400, false));
/// let text = MeasuredText::new(font, "AVA");
/// assert_eq!(text.advance_units(0, 2), font.advance_units("AV"));
/// assert_eq!(text.width(1, 3, 12.0), font.width("VA", 12.0));
/// # }
/// ```
#[derive(Clone, Debug)]
pub struct MeasuredText {
    units_per_em: u16,
    /// `advances[i]`: the sum of the advances of the first `i` glyphs, in font units.
    advances: Vec<i64>,
    kerning: KerningRanges,
}

impl MeasuredText {
    /// Maps `text` to glyphs and prepares its ranges, in time linear in its length.
    pub fn new(font: &Font, text: &str) -> MeasuredText {
        let mut glyphs = Vec::with_capacity(text.len());
        let mut advances = Vec::with_capacity(text.len() + 1);
        let mut total = 0;
        advances.push(total);
        for c in text.chars() {
            let glyph = font.glyph(c);
            glyphs.push(glyph);
            total += font.glyph_advance(glyph);
            advances.push(total);
        }
        MeasuredText {
            units_per_em: font.units_per_em(),
            advances,
            kerning: font.kerning().ranges(&glyphs),
        }
    }

    /// The number of code points of the text.
    pub fn len(&self) -> usize {
        self.advances.len() - 1
    }

    /// Whether the text is empty.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// [`Font::advance_units`] of the code points `start..end` of the text.
    ///
    /// # Panics
    /// If `start > end` or `end > self.len()`.
    #[inline]
    pub fn advance_units(&self, start: usize, end: usize) -> i64 {
        assert!(
            start <= end && end <= self.len(),
            "code point range {start}..{end} outside 0..{}",
            self.len()
        );
        self.advances[end] - self.advances[start] + self.kerning.adjustment(start, end)
    }

    /// [`Font::width`] of the code points `start..end` at `size` px:
    /// `advance_units(start, end) as f64 * size / units_per_em as f64`, in exactly this
    /// order (bit-identical).
    ///
    /// # Panics
    /// If `start > end` or `end > self.len()`.
    #[inline]
    pub fn width(&self, start: usize, end: usize, size: f64) -> f64 {
        self.advance_units(start, end) as f64 * size / f64::from(self.units_per_em)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REGULAR: &[u8] = include_bytes!("../assets/NotoSans-Regular.metrics.ttf");
    const BOLD: &[u8] = include_bytes!("../assets/NotoSans-Bold.metrics.ttf");

    /// Kerning pairs, combining marks (GDEF marks under IgnoreMarks), unmapped code points,
    /// supplementary planes, white space and long class names.
    const TEXTS: &[&str] = &[
        "",
        "A",
        "AVAVAV WAVY Typography",
        "To. Wa, Yo! L'F.P,Tr Ve LT LV AT Ty r. y,",
        "Te\u{301} A\u{308}V Wa\u{300}y o\u{302}\u{301} \u{301}x e\u{301}e\u{301}e\u{301}",
        "\u{301}\u{302}A\u{301}\u{301}V\u{301}",
        "Cr\u{e8}me br\u{fb}l\u{e9}e \u{e0} la carte",
        "\u{391}\u{3b8}\u{3ae}\u{3bd}\u{3b1}\u{39a}\u{3b1}\u{3b9} \u{41c}\u{43e}\u{441}\u{43a}\u{432}\u{430}",
        "\u{4e2d}\u{6587}x\u{1F600}y\u{0915}\u{093F}\ttab\u{a0}nbsp",
        "com.facebook.react.uimanager.layoutanimation.LayoutAnimationController$1",
        "org.springframework.beans.factory.support.DefaultListableBeanFactory",
        "XMLHttpRequestFactory std::collections::HashMap<String, Vec<u8>>",
    ];

    #[test]
    fn every_range_equals_simple_shaping() {
        for data in [REGULAR, BOLD] {
            let font = Font::from_bytes(data.to_vec()).unwrap();
            for text in TEXTS {
                let measured = MeasuredText::new(&font, text);
                let bytes: Vec<usize> = text
                    .char_indices()
                    .map(|(i, _)| i)
                    .chain([text.len()])
                    .collect();
                assert_eq!(measured.len(), bytes.len() - 1);
                for start in 0..bytes.len() {
                    for end in start..bytes.len() {
                        let s = &text[bytes[start]..bytes[end]];
                        assert_eq!(
                            measured.advance_units(start, end),
                            font.advance_units(s),
                            "{s:?}"
                        );
                        for size in [1.0, 10.0, 12.0, 16.5] {
                            let (got, expected) =
                                (measured.width(start, end, size), font.width(s, size));
                            assert_eq!(got.to_bits(), expected.to_bits(), "{s:?} at {size}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn empty_text() {
        let font = Font::from_bytes(REGULAR.to_vec()).unwrap();
        let measured = MeasuredText::new(&font, "");
        assert!(measured.is_empty());
        assert_eq!(measured.advance_units(0, 0), 0);
    }

    #[test]
    #[should_panic(expected = "outside")]
    fn reversed_range_panics() {
        let font = Font::from_bytes(REGULAR.to_vec()).unwrap();
        MeasuredText::new(&font, "AV").advance_units(2, 1);
    }

    #[test]
    #[should_panic(expected = "outside")]
    fn range_past_the_end_panics() {
        let font = Font::from_bytes(REGULAR.to_vec()).unwrap();
        MeasuredText::new(&font, "AV").advance_units(0, 3);
    }
}
