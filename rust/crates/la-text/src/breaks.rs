//! Line-break opportunities (spec §5.3).

use crate::unicode::{is_break_space, is_cjk, is_mark};

/// Indices `k` (in code points) such that a line may end after code point `k`, ascending,
/// `0 <= k < n - 1` (the end of the text is not listed).
///
/// A line may end between `a = text[k]` and `b = text[k + 1]`:
///
/// * never if `b` is a combining mark;
/// * after white space other than the no-break spaces U+00A0, U+2007, U+202F;
/// * after `/ \ . _ - , ; : |`, except between two colons (`::` breaks after the second)
///   and after `.` or `,` between two ASCII digits;
/// * between a Lowercase and an Uppercase code point (camelCase);
/// * after `a` if `a` and `b` are Uppercase and `text[k + 2]` is Lowercase (`XMLHttp` →
///   `XML|Http`);
/// * between two CJK code points (U+2E80–9FFF, U+AC00–D7AF, U+F900–FAFF, U+FF00–FFEF,
///   U+20000–2FFFF).
pub fn break_opportunities(text: &str) -> Vec<usize> {
    breaks_of(&text.chars().collect::<Vec<_>>())
}

/// [`break_opportunities`] of a text given as code points.
pub(crate) fn breaks_of(cps: &[char]) -> Vec<usize> {
    let mut out = Vec::new();
    for k in 0..cps.len().saturating_sub(1) {
        let (a, b) = (cps[k], cps[k + 1]);
        if is_mark(b) {
            continue;
        }
        let breaks = if is_break_space(a) {
            true
        } else if matches!(a, '/' | '\\' | '.' | '_' | '-' | ',' | ';' | ':' | '|') {
            let colons = a == ':' && b == ':';
            let number = matches!(a, '.' | ',')
                && k > 0
                && cps[k - 1].is_ascii_digit()
                && b.is_ascii_digit();
            !colons && !number
        } else {
            (a.is_lowercase() && b.is_uppercase())
                || (a.is_uppercase()
                    && b.is_uppercase()
                    && cps.get(k + 2).is_some_and(|c| c.is_lowercase()))
                || (is_cjk(a) && is_cjk(b))
        };
        if breaks {
            out.push(k);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::break_opportunities as breaks;

    #[test]
    fn spaces_and_punctuation() {
        assert_eq!(breaks("a b"), [1]);
        assert_eq!(breaks("a  b"), [1, 2]);
        assert_eq!(breaks("org.example.Foo"), [3, 11]);
        assert_eq!(breaks("a/b\\c_d-e,f;g:h|i"), [1, 3, 5, 7, 9, 11, 13, 15]);
        assert_eq!(breaks("10\u{A0}km"), Vec::<usize>::new());
        assert_eq!(breaks("end."), Vec::<usize>::new());
    }

    #[test]
    fn colons_and_numbers() {
        assert_eq!(breaks("std::vec"), [4]);
        assert_eq!(breaks("a:::b"), [3]);
        assert_eq!(breaks("3.14 and 1,000"), [4, 8]);
        assert_eq!(breaks("v1.x"), [2]);
        assert_eq!(breaks("x.5"), [1]);
    }

    #[test]
    fn camel_case_and_acronyms() {
        assert_eq!(breaks("camelCase"), [4]);
        assert_eq!(breaks("XMLHttpRequest"), [2, 6]);
        assert_eq!(breaks("ABC"), Vec::<usize>::new());
        assert_eq!(breaks("getHTTP"), [2]);
        assert_eq!(breaks("ΑθήναΚαι"), [4]);
    }

    #[test]
    fn cjk_and_marks() {
        assert_eq!(breaks("中文字"), [0, 1]);
        assert_eq!(breaks("a中"), Vec::<usize>::new());
        assert_eq!(breaks("a \u{301}b"), Vec::<usize>::new());
        assert_eq!(breaks("e\u{301}-x"), [2]);
    }
}
