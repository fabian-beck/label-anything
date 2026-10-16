//! Code point classes used by shaping selection and line breaking (spec §5.2–5.3).

use crate::unicode_data::COMBINING_MARKS;

/// Unicode `White_Space` (trimmed at line starts and ends).
pub(crate) fn is_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{D}'
            | ' '
            | '\u{85}'
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
    )
}

/// `White_Space` except the no-break spaces U+00A0, U+2007 and U+202F: a line may end
/// after it.
pub(crate) fn is_break_space(c: char) -> bool {
    is_space(c) && !matches!(c, '\u{A0}' | '\u{2007}' | '\u{202F}')
}

/// Combining mark (General_Category Mn, Mc or Me, Unicode 15.1).
pub(crate) fn is_mark(c: char) -> bool {
    let cp = u32::from(c);
    if cp < 0x300 {
        return false;
    }
    let index = COMBINING_MARKS.partition_point(|&(_, end)| end < cp);
    COMBINING_MARKS
        .get(index)
        .is_some_and(|&(start, _)| start <= cp)
}

/// CJK ideographs, syllables and full-width forms between which a line may break.
pub(crate) fn is_cjk(c: char) -> bool {
    matches!(
        c,
        '\u{2E80}'..='\u{9FFF}'
            | '\u{AC00}'..='\u{D7AF}'
            | '\u{F900}'..='\u{FAFF}'
            | '\u{FF00}'..='\u{FFEF}'
            | '\u{20000}'..='\u{2FFFF}'
    )
}

/// Whether `text` contains code points of scripts that simple shaping cannot measure
/// correctly, so that `Shaping::Auto` uses full shaping. The ranges are whole Unicode
/// blocks:
///
/// | range | blocks |
/// |---|---|
/// | U+0590–08FF | Hebrew, Arabic, Syriac, Arabic Supplement, Thaana, NKo, Samaritan, Mandaic, Syriac Supplement, Arabic Extended-B/A |
/// | U+0900–0DFF | Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam, Sinhala |
/// | U+0E00–109F | Thai, Lao, Tibetan, Myanmar |
/// | U+1100–11FF | Hangul Jamo |
/// | U+1780–18AF | Khmer, Mongolian |
/// | U+1CD0–1CFF | Vedic Extensions |
/// | U+A8E0–A8FF | Devanagari Extended |
/// | U+A960–A97F | Hangul Jamo Extended-A |
/// | U+A9E0–A9FF | Myanmar Extended-B |
/// | U+AA60–AA7F | Myanmar Extended-A |
/// | U+D7B0–D7FF | Hangul Jamo Extended-B |
/// | U+10EC0–10EFF | Arabic Extended-C |
/// | U+11660–1167F | Mongolian Supplement |
/// | U+11B00–11B5F | Devanagari Extended-A |
pub fn needs_complex_shaping(text: &str) -> bool {
    text.chars().any(|c| {
        matches!(
            c,
            '\u{0590}'..='\u{08FF}'
                | '\u{0900}'..='\u{0DFF}'
                | '\u{0E00}'..='\u{109F}'
                | '\u{1100}'..='\u{11FF}'
                | '\u{1780}'..='\u{18AF}'
                | '\u{1CD0}'..='\u{1CFF}'
                | '\u{A8E0}'..='\u{A8FF}'
                | '\u{A960}'..='\u{A97F}'
                | '\u{A9E0}'..='\u{A9FF}'
                | '\u{AA60}'..='\u{AA7F}'
                | '\u{D7B0}'..='\u{D7FF}'
                | '\u{10EC0}'..='\u{10EFF}'
                | '\u{11660}'..='\u{1167F}'
                | '\u{11B00}'..='\u{11B5F}'
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn white_space_matches_the_unicode_property() {
        for cp in 0..0x11_0000 {
            if let Some(c) = char::from_u32(cp) {
                assert_eq!(is_space(c), c.is_whitespace(), "U+{cp:04X}");
            }
        }
        assert!(!is_break_space('\u{A0}') && !is_break_space('\u{202F}') && is_break_space(' '));
    }

    #[test]
    fn marks() {
        assert!(is_mark('\u{301}') && is_mark('\u{20DD}') && is_mark('\u{93E}'));
        assert!(!is_mark('a') && !is_mark('\u{2FF}') && !is_mark('\u{370}'));
        assert!(COMBINING_MARKS.windows(2).all(|w| w[0].1 < w[1].0));
    }

    #[test]
    fn complex_scripts() {
        assert!(needs_complex_shaping("abc \u{05D0}"));
        assert!(needs_complex_shaping("\u{0915}\u{093F}"));
        assert!(needs_complex_shaping("\u{0E01}"));
        assert!(!needs_complex_shaping("Hello, Ελλάδα, Привет, 中文"));
    }
}
