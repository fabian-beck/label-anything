//! Wrapping, balancing and truncation of text labels (spec §5.3).
//!
//! Every function takes a [`Measure`]: simple shaping with a font at a size
//! ([`Measure::Font`]), or a closure that returns the width of a string (a host
//! measurement, full shaping, …; `&closure` converts into [`Measure::Callback`]), so the
//! algorithms work with any font and size. With [`Measure::Font`] a text is prepared once
//! ([`MeasuredText`]) and every candidate line is measured in constant time, with results
//! bit-identical to the callback `|s| font.width(s, size)`; a callback is called once per
//! distinct line. Positions are code point indices. A line `[s..=e]` is the text from code
//! point `s` to `e` with trailing white space removed; the next line starts after `e`,
//! skipping white space. Blank texts produce a single empty line.
//!
//! Searches assume that extending a line never makes it narrower: they scan candidates in
//! ascending order and stop at the first one that does not fit, which for such widths is
//! the same as taking the largest one that fits, but measures far fewer long lines.

use std::collections::HashMap;

use crate::breaks::breaks_of;
use crate::unicode::{is_mark, is_space};
use crate::{Font, MeasuredText};

const ELLIPSIS: char = '\u{2026}';

/// How the wrapping functions measure text.
///
/// `&closure` converts into [`Measure::Callback`], so both
/// `greedy_wrap(text, w, &|s: &str| font.width_shaped(s, 12.0))` and
/// `greedy_wrap(text, w, Measure::Font { font, size: 12.0 })` work.
#[derive(Clone, Copy)]
pub enum Measure<'a> {
    /// Simple shaping, [`Font::width`]: each text is prepared once ([`MeasuredText`]) and
    /// every candidate line is measured in constant time, with the same results as the
    /// callback `|s| font.width(s, size)`.
    Font {
        /// The font.
        font: &'a Font,
        /// The font size in px.
        size: f64,
    },
    /// Any width function (a host measurement, full shaping, …), called once per distinct
    /// candidate line.
    Callback(&'a dyn Fn(&str) -> f64),
}

impl Measure<'_> {
    /// The width of `text`.
    pub fn width(&self, text: &str) -> f64 {
        match *self {
            Measure::Font { font, size } => font.width(text, size),
            Measure::Callback(measure) => measure(text),
        }
    }
}

impl<'a, F: Fn(&str) -> f64> From<&'a F> for Measure<'a> {
    fn from(measure: &'a F) -> Self {
        Measure::Callback(measure)
    }
}

impl std::fmt::Debug for Measure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Measure::Font { font, size } => f
                .debug_struct("Font")
                .field("font", font)
                .field("size", size)
                .finish(),
            Measure::Callback(_) => f.write_str("Callback(..)"),
        }
    }
}

/// How text that does not fit in `max_lines` lines of `max_width` is shortened.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Truncate {
    /// Keep the greedy lines even if there are more than `max_lines` of them.
    #[default]
    None,
    /// Shorten the last line with `…`.
    End,
    /// Replace the middle of the text with `…`.
    Middle,
}

/// Wrap settings of a text label (`wrap` and `truncate` of the problem).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WrapOptions {
    /// Maximum line width; `None` wraps only when `max_lines > 1` asks for it.
    pub max_width: Option<f64>,
    /// Maximum number of lines (values below 1 count as 1).
    pub max_lines: usize,
    /// Offer balanced variants (otherwise only the greedy wrap).
    pub balance: bool,
    /// What happens when the text needs more than `max_lines` lines.
    pub truncate: Truncate,
}

impl Default for WrapOptions {
    /// No width limit, unlimited lines, balanced, no truncation.
    fn default() -> Self {
        WrapOptions {
            max_width: None,
            max_lines: usize::MAX,
            balance: true,
            truncate: Truncate::None,
        }
    }
}

/// One way of laying out a text label.
#[derive(Clone, Debug, PartialEq)]
pub struct TextVariant {
    /// The lines, top to bottom.
    pub lines: Vec<String>,
    /// `measure(line)` of every line.
    pub widths: Vec<f64>,
    /// Whether text was replaced by `…`.
    pub truncated: bool,
}

/// A line as `(first, last)` code point indices (before trimming).
type Span = (usize, usize);

/// How a [`Wrapper`] measures its lines.
enum Widths<'a> {
    /// From the prepared text at a size ([`Measure::Font`]).
    Prepared(MeasuredText, f64),
    /// With the callback, once per line.
    Callback(&'a dyn Fn(&str) -> f64, HashMap<Span, f64>),
}

/// A text prepared for wrapping: code points, break opportunities and line widths.
struct Wrapper<'a> {
    text: &'a str,
    chars: Vec<char>,
    /// Byte offset of every code point, plus `text.len()`.
    bytes: Vec<usize>,
    breaks: Vec<usize>,
    measure: Measure<'a>,
    widths: Widths<'a>,
}

impl<'a> Wrapper<'a> {
    fn new(text: &'a str, measure: Measure<'a>) -> Self {
        let (mut bytes, chars): (Vec<usize>, Vec<char>) = text.char_indices().unzip();
        bytes.push(text.len());
        let breaks = breaks_of(&chars);
        let widths = match measure {
            Measure::Font { font, size } => Widths::Prepared(MeasuredText::new(font, text), size),
            Measure::Callback(measure) => Widths::Callback(measure, HashMap::new()),
        };
        Wrapper {
            text,
            chars,
            bytes,
            breaks,
            measure,
            widths,
        }
    }

    fn len(&self) -> usize {
        self.chars.len()
    }

    /// First non-space code point at or after `i`.
    fn skip_spaces(&self, mut i: usize) -> usize {
        while i < self.len() && is_space(self.chars[i]) {
            i += 1;
        }
        i
    }

    /// The end (exclusive) of line `[s..=e]` without its trailing white space.
    fn line_end(&self, (s, e): Span) -> usize {
        let mut end = e + 1;
        while end > s && is_space(self.chars[end - 1]) {
            end -= 1;
        }
        end
    }

    /// The text of line `[s..=e]` (trailing white space removed).
    fn line(&self, span: Span) -> &'a str {
        &self.text[self.bytes[span.0]..self.bytes[self.line_end(span)]]
    }

    fn width(&mut self, span: Span) -> f64 {
        let (start, end) = (span.0, self.line_end(span));
        match &mut self.widths {
            Widths::Prepared(text, size) => text.width(start, end, *size),
            Widths::Callback(measure, cache) => {
                let measure = *measure;
                *cache
                    .entry(span)
                    .or_insert_with(|| measure(&self.text[self.bytes[start]..self.bytes[end]]))
            }
        }
    }

    /// The first break opportunity at or after `s`, else the last code point.
    fn segment_end(&self, s: usize) -> usize {
        let index = self.breaks.partition_point(|&k| k < s);
        self.breaks.get(index).copied().unwrap_or(self.len() - 1)
    }

    /// Greedy wrap at width `w`: the rest of the text if it fits, else up to the last break
    /// that fits before the first one that does not, else an emergency break. Stops after
    /// `limit + 1` lines.
    fn greedy(&mut self, w: f64, limit: usize) -> Vec<Span> {
        let n = self.len();
        let mut lines = Vec::new();
        let mut s = self.skip_spaces(0);
        while s < n && lines.len() <= limit {
            let e = if self.width((s, n - 1)) <= w {
                n - 1
            } else {
                let mut end = None;
                for i in self.breaks.partition_point(|&k| k < s)..self.breaks.len() {
                    let k = self.breaks[i];
                    if self.width((s, k)) > w {
                        break;
                    }
                    end = Some(k);
                }
                match end {
                    Some(e) => e,
                    None => self.emergency(s, w),
                }
            };
            lines.push((s, e));
            s = self.skip_spaces(e + 1);
        }
        lines
    }

    /// Whether a line may end after code point `e` without splitting off combining marks.
    fn can_end(&self, e: usize) -> bool {
        e + 1 >= self.len() || !is_mark(self.chars[e + 1])
    }

    /// Emergency break inside the segment starting at `s` (no break opportunity fits): the
    /// last end before the segment's end that fits (ascending, stopping at the first that
    /// does not), else the shortest line.
    fn emergency(&mut self, s: usize, w: f64) -> usize {
        let segment_end = self.segment_end(s);
        let mut end = None;
        for e in s..segment_end {
            if !self.can_end(e) {
                continue;
            }
            if self.width((s, e)) > w {
                return end.unwrap_or(e);
            }
            end = Some(e);
        }
        end.unwrap_or(segment_end)
    }

    /// Whether every line ends at a break opportunity or at the end of the text (none at
    /// an emergency break).
    fn at_breaks(&self, lines: &[Span]) -> bool {
        lines
            .iter()
            .all(|&(_, e)| e + 1 >= self.len() || self.breaks.binary_search(&e).is_ok())
    }

    /// Whether `greedy(w)` needs at most `n` lines.
    fn fits(&mut self, w: f64, n: usize) -> bool {
        self.greedy(w, n).len() <= n
    }

    /// Balanced wrap into at most `n` lines (spec §5.3): no candidate narrower than the
    /// widest first segment of a line (at most `max_width`), so that lines end at break
    /// opportunities unless a segment is wider than `max_width`.
    fn balanced(&mut self, n: usize, max_width: Option<f64>) -> Vec<Span> {
        let len = self.len();
        let n = n.max(1);
        let first = self.skip_spaces(0);
        if first >= len {
            return Vec::new();
        }
        let mut starts = vec![first];
        for &k in &self.breaks {
            let s = self.skip_spaces(k + 1);
            if s < len && starts.last() != Some(&s) {
                starts.push(s);
            }
        }
        let mut candidates = Vec::new();
        // the widest first segment of a line: narrower widths need an emergency break
        let mut floor: f64 = 0.0;
        for s in starts {
            let first_break = self.breaks.partition_point(|&k| k < s);
            let segment = self.width((s, self.segment_end(s)));
            if segment > floor {
                floor = segment;
            }
            for i in first_break..=self.breaks.len() {
                let k = self.breaks.get(i).copied().unwrap_or(len - 1);
                let w = self.width((s, k));
                if max_width.is_some_and(|m| w > m) {
                    break;
                }
                candidates.push(w);
            }
        }
        if let Some(m) = max_width {
            candidates.push(m);
            candidates.retain(|&w| w <= m);
            if floor > m {
                floor = m;
            }
        }
        candidates.retain(|&w| w >= floor);
        candidates.retain(|w| !w.is_nan());
        candidates.sort_by(f64::total_cmp);
        candidates.dedup();
        if candidates.is_empty() {
            return self.greedy(max_width.unwrap_or(f64::INFINITY), usize::MAX);
        }
        let (mut lo, mut hi) = (0, candidates.len() - 1);
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.fits(candidates[mid], n) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        let lines = self.greedy(candidates[lo], usize::MAX);
        match max_width {
            Some(m) if lines.len() > n => self.greedy(m, usize::MAX),
            _ => lines,
        }
    }

    /// The whole text as one line.
    fn single_line(&self) -> Vec<Span> {
        let first = self.skip_spaces(0);
        if first < self.len() {
            vec![(first, self.len() - 1)]
        } else {
            Vec::new()
        }
    }

    /// The lines as strings; a blank text is one empty line.
    fn strings(&self, lines: &[Span]) -> Vec<String> {
        if lines.is_empty() {
            return vec![String::new()];
        }
        self.texts(lines)
    }

    fn texts(&self, lines: &[Span]) -> Vec<String> {
        lines
            .iter()
            .map(|&span| self.line(span).to_owned())
            .collect()
    }

    fn variant(&self, lines: Vec<String>, truncated: bool) -> TextVariant {
        let widths = lines.iter().map(|line| self.measure.width(line)).collect();
        TextVariant {
            lines,
            widths,
            truncated,
        }
    }

    /// The variant of the lines `spans` (not truncated; `lines` are their strings). With a
    /// prepared text the widths come from the spans, else every line is measured.
    fn spans_variant(&mut self, spans: &[Span], lines: Vec<String>) -> TextVariant {
        if spans.is_empty() || matches!(self.widths, Widths::Callback(..)) {
            return self.variant(lines, false);
        }
        let widths = spans.iter().map(|&span| self.width(span)).collect();
        TextVariant {
            lines,
            widths,
            truncated: false,
        }
    }
}

/// Greedy wrap: every line takes the rest of the text if it fits `max_width`, else extends
/// to the last break opportunity that fits; a segment wider than `max_width` is broken at
/// the last code point position that fits (never before a combining mark, at least one
/// code point).
pub fn greedy_wrap<'a>(text: &str, max_width: f64, measure: impl Into<Measure<'a>>) -> Vec<String> {
    let mut wrapper = Wrapper::new(text, measure.into());
    let lines = wrapper.greedy(max_width, usize::MAX);
    wrapper.strings(&lines)
}

/// Balanced wrap into at most `n_lines` lines: `greedy_wrap` at the smallest candidate
/// width (the widths of the lines between break opportunities, and `max_width`; only
/// those `<= max_width` and none narrower than the widest segment between two break
/// opportunities that starts a line, or than `max_width` if that is narrower) that needs
/// at most `n_lines` lines, found by binary search. If even `max_width` needs more lines,
/// the result is `greedy_wrap(text, max_width)`.
pub fn balanced_wrap<'a>(
    text: &str,
    n_lines: usize,
    max_width: Option<f64>,
    measure: impl Into<Measure<'a>>,
) -> Vec<String> {
    let mut wrapper = Wrapper::new(text, measure.into());
    let lines = wrapper.balanced(n_lines, max_width);
    wrapper.strings(&lines)
}

/// Shortens `text` with a trailing `…` to fit `max_width`: the longest code point prefix
/// (not separated from its combining marks, trailing white space removed; lengths are
/// tried in ascending order up to the first that does not fit) such that `prefix + "…"`
/// fits; `"…"` if none does. A text that fits is returned unchanged.
pub fn truncate_end<'a>(text: &str, max_width: f64, measure: impl Into<Measure<'a>>) -> String {
    let measure = measure.into();
    if measure.width(text) <= max_width {
        return text.to_owned();
    }
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut best = ELLIPSIS.to_string();
    for keep in 1..chars.len() {
        if is_mark(chars[keep].1) {
            continue;
        }
        let mut end = keep;
        while end > 0 && is_space(chars[end - 1].1) {
            end -= 1;
        }
        let candidate = format!("{}{ELLIPSIS}", &text[..chars[end].0]);
        if measure.width(&candidate) > max_width {
            break;
        }
        best = candidate;
    }
    best
}

/// Replaces the middle of `text` (trimmed) with `…` so that its greedy wrap at `max_width`
/// has at most `max_lines` lines, removing the fewest code points `r >= 1` (binary search):
/// the left part keeps `ceil((n - r) / 2)` code points, the right part `floor((n - r) / 2)`,
/// both shrunk so that no base is separated from its combining marks, with the white space
/// next to `…` removed. Returns the wrapped lines; a text that fits is only wrapped.
pub fn truncate_middle<'a>(
    text: &str,
    max_width: f64,
    max_lines: usize,
    measure: impl Into<Measure<'a>>,
) -> Vec<String> {
    let measure = measure.into();
    let max_lines = max_lines.max(1);
    let text = text.trim_matches(is_space);
    let wrap = |t: &str| {
        let mut wrapper = Wrapper::new(t, measure);
        let lines = wrapper.greedy(max_width, usize::MAX);
        (lines.len(), wrapper.strings(&lines))
    };
    let (count, lines) = wrap(text);
    if count <= max_lines {
        return lines;
    }
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let candidate = |removed: usize| -> String {
        let keep = n - removed;
        let mut left = keep.div_ceil(2);
        while left > 0 && is_mark(chars[left]) {
            left -= 1;
        }
        let mut right = n - keep / 2;
        while right < n && is_mark(chars[right]) {
            right += 1;
        }
        while left > 0 && is_space(chars[left - 1]) {
            left -= 1;
        }
        while right < n && is_space(chars[right]) {
            right += 1;
        }
        chars[..left]
            .iter()
            .chain([ELLIPSIS].iter())
            .chain(chars[right..].iter())
            .collect()
    };
    let (mut lo, mut hi) = (1, n);
    while lo < hi {
        let mid = (lo + hi) / 2;
        if Wrapper::new(&candidate(mid), measure).fits(max_width, max_lines) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    wrap(&candidate(lo)).1
}

/// The layout variants of a text label with wrap settings (spec §5.3 "Variants").
///
/// `L_min` is the line count of the greedy wrap at `max_width` (1 without `max_width`).
/// If `L_min <= max_lines`: the balanced wraps into `L_min ..= min(L_min + 2, max_lines)`
/// lines (only the greedy wrap if `balance` is false), without duplicates. Otherwise the
/// text is truncated: [`Truncate::End`] keeps the first `max_lines - 1` greedy lines and
/// [shortens](truncate_end) the rest of the text into the last line, [`Truncate::Middle`]
/// uses [`truncate_middle`], and [`Truncate::None`] keeps the whole text in the
/// [balanced](balanced_wrap) wrap into `max_lines` lines without a width limit (lines may
/// exceed `max_width`; `truncated == false`).
pub fn wrap_variants<'a>(
    text: &str,
    opts: &WrapOptions,
    measure: impl Into<Measure<'a>>,
) -> Vec<TextVariant> {
    let measure = measure.into();
    let mut wrapper = Wrapper::new(text, measure);
    let max_lines = opts.max_lines.max(1);
    let greedy = match opts.max_width {
        Some(m) => wrapper.greedy(m, usize::MAX),
        None => wrapper.single_line(),
    };
    let l_min = greedy.len().max(1);
    if l_min <= max_lines {
        if !opts.balance {
            let lines = wrapper.strings(&greedy);
            return vec![wrapper.spans_variant(&greedy, lines)];
        }
        let mut variants: Vec<TextVariant> = Vec::new();
        for n in l_min..=(l_min.saturating_add(2)).min(max_lines) {
            let spans = wrapper.balanced(n, opts.max_width);
            let lines = wrapper.strings(&spans);
            if variants.iter().all(|v| v.lines != lines) {
                variants.push(wrapper.spans_variant(&spans, lines));
            }
        }
        return variants;
    }
    // `l_min > max_lines >= 1` implies a max_width
    let (Some(max_width), Truncate::End | Truncate::Middle) = (opts.max_width, opts.truncate)
    else {
        // keep the text, give up the width: the narrowest wrap into max_lines lines
        let spans = wrapper.balanced(max_lines, None);
        let lines = wrapper.strings(&spans);
        return vec![wrapper.spans_variant(&spans, lines)];
    };
    let lines = if opts.truncate == Truncate::End {
        let mut lines = wrapper.texts(&greedy[..max_lines - 1]);
        let (rest_start, _) = greedy[max_lines - 1];
        let rest = wrapper.line((rest_start, wrapper.len() - 1));
        lines.push(truncate_end(rest, max_width, measure));
        lines
    } else {
        truncate_middle(text, max_width, max_lines, measure)
    };
    vec![wrapper.variant(lines, true)]
}

/// Extra variants for the `wrap` ladder step of labels without wrap settings: the balanced
/// wraps into `2 ..= max_lines` lines, without duplicates, single-line results and results
/// with a line that ends inside a word (an emergency break: more lines than the break
/// opportunities allow).
pub fn extra_wrap_variants<'a>(
    text: &str,
    max_lines: usize,
    measure: impl Into<Measure<'a>>,
) -> Vec<TextVariant> {
    let mut wrapper = Wrapper::new(text, measure.into());
    let mut variants: Vec<TextVariant> = Vec::new();
    // No wrap has more lines than code points, so larger counts only repeat variants.
    for n in 2..=max_lines.min(wrapper.len()) {
        let spans = wrapper.balanced(n, None);
        if spans.len() < 2 || !wrapper.at_breaks(&spans) {
            continue;
        }
        let lines = wrapper.strings(&spans);
        if variants.iter().all(|v| v.lines != lines) {
            variants.push(wrapper.spans_variant(&spans, lines));
        }
    }
    variants
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every code point is 1 wide, spaces too.
    fn count(s: &str) -> f64 {
        s.chars().count() as f64
    }

    #[test]
    fn greedy_takes_the_largest_fitting_break() {
        assert_eq!(greedy_wrap("aaa bbb ccc", 7.0, &count), ["aaa bbb", "ccc"]);
        assert_eq!(
            greedy_wrap("aaa bbb ccc", 6.0, &count),
            ["aaa", "bbb", "ccc"]
        );
        assert_eq!(
            greedy_wrap("org.example.Foo", 12.0, &count),
            ["org.example.", "Foo"]
        );
        assert_eq!(
            greedy_wrap("  lead  trail  ", 100.0, &count),
            ["lead  trail"]
        );
        assert_eq!(greedy_wrap("", 10.0, &count), [""]);
        assert_eq!(greedy_wrap("   ", 10.0, &count), [""]);
    }

    #[test]
    fn emergency_breaks() {
        assert_eq!(greedy_wrap("abcdefgh", 3.0, &count), ["abc", "def", "gh"]);
        assert_eq!(greedy_wrap("ab cdefgh", 3.0, &count), ["ab", "cde", "fgh"]);
        assert_eq!(greedy_wrap("abc", 0.0, &count), ["a", "b", "c"]);
        // never separate a base from its combining mark
        assert_eq!(
            greedy_wrap("ae\u{301}b", 2.0, &count),
            ["a", "e\u{301}", "b"]
        );
        assert_eq!(
            greedy_wrap("e\u{301}\u{302}x", 1.0, &count),
            ["e\u{301}\u{302}", "x"]
        );
    }

    #[test]
    fn balanced() {
        assert_eq!(
            balanced_wrap("aaa bbb ccc ddd", 2, None, &count),
            ["aaa bbb", "ccc ddd"]
        );
        assert_eq!(
            balanced_wrap("aaa bbb ccc ddd", 1, None, &count),
            ["aaa bbb ccc ddd"]
        );
        assert_eq!(
            balanced_wrap("aaaaaaaa b c", 2, None, &count),
            ["aaaaaaaa", "b c"]
        );
        assert_eq!(
            balanced_wrap("aaa bbb ccc ddd", 2, Some(5.0), &count),
            ["aaa", "bbb", "ccc", "ddd"]
        );
        assert_eq!(balanced_wrap("", 2, None, &count), [""]);
    }

    #[test]
    fn truncation() {
        assert_eq!(truncate_end("abcdef", 6.0, &count), "abcdef");
        assert_eq!(truncate_end("abcdef", 4.0, &count), "abc…");
        assert_eq!(truncate_end("ab cdef", 4.0, &count), "ab…");
        assert_eq!(truncate_end("abe\u{301}f", 4.0, &count), "ab…");
        assert_eq!(truncate_end("abc", 0.0, &count), "…");
        assert_eq!(
            truncate_middle("org.example.Foo", 7.0, 1, &count),
            ["org…Foo"]
        );
        assert_eq!(truncate_middle("abcdefgh", 5.0, 1, &count), ["ab…gh"]);
        assert_eq!(truncate_middle("abc defgh", 5.0, 1, &count), ["ab…gh"]);
        assert_eq!(truncate_middle("abc", 5.0, 1, &count), ["abc"]);
    }

    #[test]
    fn variants() {
        let opts = WrapOptions {
            max_width: Some(8.0),
            max_lines: 3,
            ..WrapOptions::default()
        };
        let v = wrap_variants("aa bb cc dd ee ff", &opts, &count);
        let lines: Vec<_> = v.iter().map(|v| v.lines.clone()).collect();
        assert_eq!(
            lines,
            [
                vec!["aa bb cc", "dd ee ff"],
                vec!["aa bb", "cc dd", "ee ff"]
            ]
        );
        assert_eq!(v[0].widths, [8.0, 8.0]);
        // balanced(3) equals balanced(2) here and is deduplicated
        let same = WrapOptions {
            max_width: Some(7.0),
            ..opts
        };
        assert_eq!(wrap_variants("aaa bbb ccc ddd", &same, &count).len(), 1);

        let greedy = WrapOptions {
            balance: false,
            ..opts
        };
        assert_eq!(
            wrap_variants("aa bb cc dd ee ff", &greedy, &count)[0].lines,
            ["aa bb cc", "dd ee ff"]
        );

        let end = WrapOptions {
            max_width: Some(7.0),
            max_lines: 1,
            truncate: Truncate::End,
            ..opts
        };
        let v = wrap_variants("aaa bbb ccc ddd", &end, &count);
        assert_eq!(
            (v[0].lines.clone(), v[0].truncated),
            (vec!["aaa bb…".to_owned()], true)
        );
        let v = wrap_variants(
            "aaa bbb ccc ddd",
            &WrapOptions {
                max_lines: 2,
                max_width: Some(4.0),
                ..end
            },
            &count,
        );
        assert_eq!(v[0].lines, ["aaa", "bbb…"]);

        let middle = WrapOptions {
            truncate: Truncate::Middle,
            ..end
        };
        assert_eq!(
            wrap_variants("aaa bbb ccc ddd", &middle, &count)[0].lines,
            ["aaa…ddd"]
        );

        // `none` keeps the text within max_lines; lines may exceed max_width
        let none = WrapOptions {
            truncate: Truncate::None,
            max_lines: 2,
            max_width: Some(4.0),
            ..end
        };
        let v = wrap_variants("aaa bbb ccc ddd", &none, &count);
        assert_eq!(
            (v[0].lines.clone(), v[0].truncated),
            (vec!["aaa bbb".to_owned(), "ccc ddd".to_owned()], false)
        );

        let unbounded = WrapOptions {
            max_width: None,
            max_lines: 2,
            ..WrapOptions::default()
        };
        let lines: Vec<_> = wrap_variants("aaa bbb ccc", &unbounded, &count)
            .into_iter()
            .map(|v| v.lines)
            .collect();
        assert_eq!(lines, [vec!["aaa bbb ccc"], vec!["aaa bbb", "ccc"]]);
    }

    #[test]
    fn extra_variants() {
        let lines: Vec<_> = extra_wrap_variants("aaa bbb ccc", 3, &count)
            .into_iter()
            .map(|v| v.lines)
            .collect();
        assert_eq!(lines, [vec!["aaa bbb", "ccc"], vec!["aaa", "bbb", "ccc"]]);
        assert!(extra_wrap_variants("unbreakable", 3, &count).is_empty());
        let unbounded: Vec<_> = extra_wrap_variants("a b", usize::MAX, &count)
            .into_iter()
            .map(|v| v.lines)
            .collect();
        assert_eq!(unbounded, [vec!["a", "b"]]);
    }
}
