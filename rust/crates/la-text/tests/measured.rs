//! `MeasuredText` and `Measure::Font` against simple shaping and the closure measure on the
//! synthetic fonts of `conformance/text/fonts/` (marks, IgnoreMarks and other lookup flags,
//! pairs that skip their second glyph, legacy `kern` tables, CFF, a collection).

use std::path::Path;

use label_anything_text::{
    balanced_wrap, extra_wrap_variants, greedy_wrap, truncate_end, truncate_middle, wrap_variants,
    Font, Measure, MeasuredText, Truncate, WrapOptions,
};

/// The code points the synthetic fonts map (and a few they do not): kerned letters, the
/// combining acute (a GDEF mark), space, period, Greek Alpha, supplementary-plane glyphs.
const ALPHABET: &str = "ABCTVaoy. \u{301}\u{391}\u{1F600}\u{10400}z";

fn fonts() -> Vec<(String, Font)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance/text/fonts");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .expect("conformance/text/fonts exists")
        .map(|entry| entry.expect("readable").path())
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|path| {
            let font = Font::from_bytes(std::fs::read(&path).unwrap()).expect("valid font");
            (
                path.file_name().unwrap().to_string_lossy().into_owned(),
                font,
            )
        })
        .collect()
}

/// xorshift64*: deterministic pseudo-random texts.
struct Rng(u64);

impl Rng {
    fn below(&mut self, n: usize) -> usize {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) % n as u64) as usize
    }

    /// Mostly kerned letters ("ToToTo" chains skipping pairs), with marks and spaces.
    fn text(&mut self, max_len: usize) -> String {
        let len = self.below(max_len + 1);
        (0..len)
            .map(|_| match self.below(10) {
                0..=3 => ['T', 'o', 'A', 'V'][self.below(4)],
                _ => {
                    let alphabet: Vec<char> = ALPHABET.chars().collect();
                    alphabet[self.below(alphabet.len())]
                }
            })
            .collect()
    }
}

#[test]
fn every_range_equals_simple_shaping() {
    let fonts = fonts();
    assert!(fonts.len() >= 5, "synthetic fonts: {}", fonts.len());
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    for (name, font) in &fonts {
        for _ in 0..300 {
            let text = rng.text(16);
            let measured = MeasuredText::new(font, &text);
            let chars: Vec<char> = text.chars().collect();
            for start in 0..=chars.len() {
                for end in start..=chars.len() {
                    let s: String = chars[start..end].iter().collect();
                    assert_eq!(
                        measured.advance_units(start, end),
                        font.advance_units(&s),
                        "{name}: {s:?} in {text:?}"
                    );
                    let (got, expected) = (measured.width(start, end, 13.3), font.width(&s, 13.3));
                    assert_eq!(got.to_bits(), expected.to_bits(), "{name}: {s:?}");
                }
            }
        }
    }
}

/// Wrapping with `Measure::Font` gives the same lines and bit-identical widths as the closure.
#[test]
fn font_measure_wraps_like_the_closure() {
    let mut rng = Rng(7);
    for (name, font) in &fonts() {
        for _ in 0..200 {
            let text = rng.text(24);
            let size = [9.0, 11.0, 13.3][rng.below(3)];
            let closure = |s: &str| font.width(s, size);
            let fast = Measure::Font { font, size };
            let full = font.width(&text, size);
            for w in [
                0.0,
                full * 0.2,
                full * 0.35,
                full * 0.5,
                full * 0.8,
                full + 1.0,
            ] {
                let context = format!("{name}: {text:?} at {w}");
                assert_eq!(
                    greedy_wrap(&text, w, fast),
                    greedy_wrap(&text, w, &closure),
                    "{context}"
                );
                assert_eq!(
                    truncate_end(&text, w, fast),
                    truncate_end(&text, w, &closure),
                    "{context}"
                );
                for n in 1..=3 {
                    for m in [None, Some(w)] {
                        assert_eq!(
                            balanced_wrap(&text, n, m, fast),
                            balanced_wrap(&text, n, m, &closure),
                            "{context}"
                        );
                    }
                    assert_eq!(
                        truncate_middle(&text, w, n, fast),
                        truncate_middle(&text, w, n, &closure),
                        "{context}"
                    );
                    for truncate in [Truncate::None, Truncate::End, Truncate::Middle] {
                        let opts = WrapOptions {
                            max_width: Some(w),
                            max_lines: n,
                            balance: n != 2,
                            truncate,
                        };
                        assert_eq!(
                            wrap_variants(&text, &opts, fast),
                            wrap_variants(&text, &opts, &closure),
                            "{context}"
                        );
                    }
                }
            }
            assert_eq!(
                extra_wrap_variants(&text, 4, fast),
                extra_wrap_variants(&text, 4, &closure),
                "{name}: {text:?}"
            );
        }
    }
}
