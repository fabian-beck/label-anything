//! A small CSS parser for `<style>` elements and `style="…"` attributes. Mirrors `css.ts`.
//!
//! Supported: qualified rules with selectors from our subset (other rules are dropped as
//! CSS error recovery requires), declarations with `!important`, comments, and skipping of
//! at-rules (`@media`, `@font-face`, `@import`, `@keyframes`, ...) including their blocks.

use crate::selector::{parse_selector_list, Complex, SelectorMode};

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Decl {
    /// Lowercased property name.
    pub name: String,
    pub value: String,
    pub important: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct CssRule {
    pub selectors: Vec<Complex>,
    pub decls: Vec<Decl>,
}

/// Removes `/* … */` comments (outside strings).
fn strip_comments(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let mut run = 0;
    while i < b.len() {
        match b[i] {
            q @ (b'"' | b'\'') => {
                i += 1;
                while i < b.len() && b[i] != q {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
                i = (i + 1).min(b.len());
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                out.push_str(&s[run..i]);
                out.push(' ');
                i = match s[i + 2..].find("*/") {
                    Some(k) => i + 2 + k + 2,
                    None => b.len(),
                };
                run = i;
            }
            _ => i += 1,
        }
    }
    out.push_str(&s[run..]);
    out
}

/// Index of the first `target` byte at nesting level 0 (outside strings, (), [] and {}),
/// starting at `i`; `b.len()` if none.
fn find_top(b: &[u8], mut i: usize, targets: &[u8]) -> usize {
    let mut depth = 0usize;
    while i < b.len() {
        let x = b[i];
        if depth == 0 && targets.contains(&x) {
            return i;
        }
        match x {
            b'"' | b'\'' => {
                let q = x;
                i += 1;
                while i < b.len() && b[i] != q {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
        i += 1;
    }
    b.len()
}

/// Given `b[open] == '{'`, returns the index of the matching `}` (or `b.len()`).
fn block_end(b: &[u8], open: usize) -> usize {
    let mut depth = 0usize;
    let mut i = open;
    while i < b.len() {
        match b[i] {
            b'"' | b'\'' => {
                let q = b[i];
                i += 1;
                while i < b.len() && b[i] != q {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return i;
                }
            }
            _ => {}
        }
        i += 1;
    }
    b.len()
}

#[inline]
fn is_css_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0C)
}

/// Parses a style sheet. Rules whose selector is invalid (or outside our subset) are
/// dropped; their declarations never apply.
pub(crate) fn parse_stylesheet(text: &str) -> Vec<CssRule> {
    let s = strip_comments(text);
    let b = s.as_bytes();
    let mut rules = Vec::new();
    let mut i = 0;
    loop {
        while i < b.len() && is_css_ws(b[i]) {
            i += 1;
        }
        if i >= b.len() {
            break;
        }
        if s[i..].starts_with("<!--") {
            i += 4;
            continue;
        }
        if s[i..].starts_with("-->") {
            i += 3;
            continue;
        }
        if b[i] == b'@' {
            let k = find_top(b, i, b";{");
            if k >= b.len() {
                break;
            }
            i = if b[k] == b';' {
                k + 1
            } else {
                block_end(b, k) + 1
            };
            continue;
        }
        let k = find_top(b, i, b"{");
        if k >= b.len() {
            break;
        }
        let end = block_end(b, k);
        let prelude = &s[i..k];
        let body = &s[k + 1..end.min(b.len())];
        if let Ok(list) = parse_selector_list(prelude, SelectorMode::Css) {
            let decls = parse_declarations(body);
            if !decls.is_empty() {
                rules.push(CssRule {
                    selectors: list.selectors,
                    decls,
                });
            }
        }
        i = end + 1;
    }
    rules
}

/// Parses a declaration list (`fill: red; stroke: blue !important`).
pub(crate) fn parse_declarations(text: &str) -> Vec<Decl> {
    let owned;
    let text = if text.contains("/*") {
        owned = strip_comments(text);
        owned.as_str()
    } else {
        text
    };
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let end = find_top(b, i, b";");
        let part = &text[i..end];
        i = end + 1;
        let pb = part.as_bytes();
        let colon = find_top(pb, 0, b":");
        if colon >= pb.len() {
            continue;
        }
        let name = part[..colon].trim_matches(|c: char| c.is_ascii() && is_css_ws(c as u8));
        if name.is_empty()
            || !name
                .bytes()
                .all(|x| x.is_ascii_alphanumeric() || x == b'-' || x == b'_')
        {
            continue;
        }
        let mut value =
            part[colon + 1..].trim_matches(|c: char| c.is_ascii() && is_css_ws(c as u8));
        let mut important = false;
        if let Some(bang) = value.rfind('!') {
            let tail = value[bang + 1..].trim_matches(|c: char| c.is_ascii() && is_css_ws(c as u8));
            if tail.eq_ignore_ascii_case("important") {
                important = true;
                value = value[..bang].trim_matches(|c: char| c.is_ascii() && is_css_ws(c as u8));
            }
        }
        if value.is_empty() {
            continue;
        }
        out.push(Decl {
            name: name.to_ascii_lowercase(),
            value: value.to_string(),
            important,
        });
    }
    out
}
