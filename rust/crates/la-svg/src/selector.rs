//! The selector engine shared by class rules, `from_svg` marks and `<style>` sheets.
//! Mirrors `selector.ts`.
//!
//! Grammar (our CSS subset):
//!
//! ```text
//! list      = complex ("," complex)*
//! complex   = compound (combinator compound)*          combinator = ws+ | ws* ">" ws*
//! compound  = (type | "*")? (".class" | "#id" | "[attr]" | "[attr op value]" | ":pseudo")*
//! op        = "=" | "^=" | "$=" | "*="       (exact, prefix, suffix, substring)
//! pseudo    = small | background | filled | unfilled    (class rules and marks only)
//! ```
//!
//! Matching uses a dynamic program over the element's ancestor chain (linear in
//! `compounds × depth`), so selectors with many descendant combinators cannot cause
//! exponential backtracking.

use crate::error::{SvgError, SvgErrorCode};
use crate::Element;

/// `:small` threshold (bbox ≤ 16 px in both dimensions).
pub const SMALL_PX: f64 = 16.0;
/// `:background` threshold (bbox ≥ 90 % of the canvas in both dimensions).
pub const BACKGROUND_FRACTION: f64 = 0.9;
/// Maximum number of compound selectors in one complex selector.
const MAX_COMPOUNDS: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SelectorMode {
    /// `<style>` sheets: our geometry/fill pseudo-classes are not allowed.
    Css,
    /// Class rules and `from_svg` marks.
    Rules,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Pseudo {
    Small,
    Background,
    Filled,
    Unfilled,
}

/// Attribute value test: `=` exact, `^=` prefix, `$=` suffix, `*=` substring (as in CSS,
/// an empty value never matches with the last three).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AttrOp {
    Equals,
    Prefix,
    Suffix,
    Contains,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AttrSel {
    pub name: String,
    /// `None` for `[attr]` (presence).
    pub value: Option<(AttrOp, String)>,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub(crate) struct Compound {
    pub tag: Option<String>,
    pub ids: Vec<String>,
    pub classes: Vec<String>,
    pub attrs: Vec<AttrSel>,
    pub pseudos: Vec<Pseudo>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Combinator {
    Descendant,
    Child,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Complex {
    pub compounds: Vec<Compound>,
    /// `combinators[k]` joins `compounds[k]` and `compounds[k + 1]`.
    pub combinators: Vec<Combinator>,
    /// (ids, classes + attributes + pseudo-classes, types).
    pub specificity: (u32, u32, u32),
}

/// A parsed selector list (see the module documentation for the syntax).
#[derive(Clone, Debug, PartialEq)]
pub struct Selector {
    pub(crate) selectors: Vec<Complex>,
}

impl Selector {
    /// Parses a selector list for class rules and `from_svg` marks. Syntax errors are
    /// reported with code [`SvgErrorCode::Pattern`].
    pub fn parse(s: &str) -> Result<Selector, SvgError> {
        parse_selector_list(s, SelectorMode::Rules)
    }
}

struct P<'a> {
    s: &'a str,
    b: &'a [u8],
    i: usize,
    mode: SelectorMode,
}

#[inline]
fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0C)
}

#[inline]
fn is_ident_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b >= 0x80
}

impl P<'_> {
    fn err(&self, msg: &str) -> SvgError {
        let pos = self.s[..self.i.min(self.s.len())].chars().count();
        SvgError::new(
            SvgErrorCode::Pattern,
            format!("invalid selector '{}': {msg} at position {pos}", self.s),
        )
    }
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }
    fn skip_ws(&mut self) -> bool {
        let start = self.i;
        while self.i < self.b.len() && is_ws(self.b[self.i]) {
            self.i += 1;
        }
        self.i > start
    }

    /// One escape after `\`: hex (1–6 digits, optional trailing whitespace) or a literal.
    fn escape(&mut self, out: &mut String) -> Result<(), SvgError> {
        self.i += 1;
        let Some(&x) = self.b.get(self.i) else {
            return Err(self.err("incomplete escape"));
        };
        if x.is_ascii_hexdigit() {
            let start = self.i;
            while self.i < self.b.len() && self.i - start < 6 && self.b[self.i].is_ascii_hexdigit()
            {
                self.i += 1;
            }
            let n = u32::from_str_radix(&self.s[start..self.i], 16).unwrap_or(0xFFFD);
            let ch = char::from_u32(n)
                .filter(|&c| c != '\0')
                .unwrap_or('\u{FFFD}');
            out.push(ch);
            if self.i < self.b.len() && is_ws(self.b[self.i]) {
                self.i += 1;
            }
            return Ok(());
        }
        if x == b'\n' || x == b'\r' || x == 0x0C {
            return Err(self.err("invalid escape"));
        }
        let ch = self.s[self.i..].chars().next().expect("in bounds");
        out.push(ch);
        self.i += ch.len_utf8();
        Ok(())
    }

    /// A run of identifier characters (letters, digits, `-`, `_`, non-ASCII, escapes),
    /// plus `extra` bytes.
    fn word(&mut self, extra: &[u8]) -> Result<String, SvgError> {
        let mut out = String::new();
        while let Some(x) = self.peek() {
            if x == b'\\' {
                self.escape(&mut out)?;
            } else if is_ident_char(x) || extra.contains(&x) {
                let ch = self.s[self.i..].chars().next().expect("in bounds");
                out.push(ch);
                self.i += ch.len_utf8();
            } else {
                break;
            }
        }
        Ok(out)
    }

    fn list(&mut self) -> Result<Vec<Complex>, SvgError> {
        let mut out = Vec::new();
        loop {
            self.skip_ws();
            out.push(self.complex()?);
            self.skip_ws();
            match self.peek() {
                None => return Ok(out),
                Some(b',') => self.i += 1,
                Some(_) => return Err(self.err("unexpected character")),
            }
        }
    }

    fn complex(&mut self) -> Result<Complex, SvgError> {
        let mut compounds = vec![self.compound()?];
        let mut combinators = Vec::new();
        loop {
            let had_ws = self.skip_ws();
            match self.peek() {
                None | Some(b',') => break,
                Some(b'>') => {
                    self.i += 1;
                    self.skip_ws();
                    combinators.push(Combinator::Child);
                }
                Some(b'+' | b'~') => return Err(self.err("sibling combinators are not supported")),
                Some(_) if had_ws => combinators.push(Combinator::Descendant),
                Some(_) => return Err(self.err("unexpected character")),
            }
            compounds.push(self.compound()?);
            if compounds.len() > MAX_COMPOUNDS {
                return Err(self.err("selector too long"));
            }
        }
        let mut spec = (0u32, 0u32, 0u32);
        for c in &compounds {
            spec.0 += c.ids.len() as u32;
            spec.1 += (c.classes.len() + c.attrs.len() + c.pseudos.len()) as u32;
            spec.2 += u32::from(c.tag.is_some());
        }
        Ok(Complex {
            compounds,
            combinators,
            specificity: spec,
        })
    }

    fn compound(&mut self) -> Result<Compound, SvgError> {
        let mut c = Compound::default();
        let mut any = false;
        match self.peek() {
            Some(b'*') => {
                self.i += 1;
                any = true;
            }
            Some(x) if x.is_ascii_alphabetic() || x == b'_' || x >= 0x80 || x == b'\\' => {
                c.tag = Some(self.word(&[])?);
                any = true;
            }
            _ => {}
        }
        loop {
            match self.peek() {
                Some(b'.') => {
                    self.i += 1;
                    let w = self.word(&[])?;
                    if w.is_empty() {
                        return Err(self.err("expected a class name"));
                    }
                    c.classes.push(w);
                }
                Some(b'#') => {
                    self.i += 1;
                    let w = self.word(&[])?;
                    if w.is_empty() {
                        return Err(self.err("expected an id"));
                    }
                    c.ids.push(w);
                }
                Some(b'[') => {
                    self.i += 1;
                    c.attrs.push(self.attr()?);
                }
                Some(b':') => {
                    self.i += 1;
                    c.pseudos.push(self.pseudo()?);
                }
                _ => break,
            }
            any = true;
        }
        if !any {
            return Err(self.err(if self.peek().is_none() {
                "expected a selector"
            } else {
                "unexpected character"
            }));
        }
        Ok(c)
    }

    fn attr(&mut self) -> Result<AttrSel, SvgError> {
        self.skip_ws();
        let mut name = String::new();
        loop {
            let w = self.word(b":.")?;
            name.push_str(&w);
            // `ns|name` (namespace separator, not the `|=` operator) maps to `ns:name`.
            if self.peek() == Some(b'|')
                && self.b.get(self.i + 1) != Some(&b'=')
                && !name.is_empty()
            {
                self.i += 1;
                name.push(':');
                continue;
            }
            break;
        }
        if name.is_empty() {
            return Err(self.err("expected an attribute name"));
        }
        self.skip_ws();
        match self.peek() {
            Some(b']') => {
                self.i += 1;
                Ok(AttrSel { name, value: None })
            }
            Some(c @ (b'=' | b'^' | b'$' | b'*')) => {
                let op = match c {
                    b'=' => AttrOp::Equals,
                    b'^' => AttrOp::Prefix,
                    b'$' => AttrOp::Suffix,
                    _ => AttrOp::Contains,
                };
                self.i += 1;
                if op != AttrOp::Equals {
                    if self.peek() != Some(b'=') {
                        return Err(self.err("expected '=' after the attribute operator"));
                    }
                    self.i += 1;
                }
                self.skip_ws();
                let value = match self.peek() {
                    Some(q @ (b'"' | b'\'')) => {
                        self.i += 1;
                        let mut v = String::new();
                        loop {
                            match self.peek() {
                                None => return Err(self.err("unterminated string")),
                                Some(x) if x == q => {
                                    self.i += 1;
                                    break;
                                }
                                Some(b'\\') => self.escape(&mut v)?,
                                Some(_) => {
                                    let ch = self.s[self.i..].chars().next().expect("in bounds");
                                    v.push(ch);
                                    self.i += ch.len_utf8();
                                }
                            }
                        }
                        v
                    }
                    _ => {
                        let mut v = String::new();
                        while let Some(x) = self.peek() {
                            if is_ws(x) || x == b']' || x == b'"' || x == b'\'' {
                                break;
                            }
                            if x == b'\\' {
                                self.escape(&mut v)?;
                            } else {
                                let ch = self.s[self.i..].chars().next().expect("in bounds");
                                v.push(ch);
                                self.i += ch.len_utf8();
                            }
                        }
                        if v.is_empty() {
                            return Err(self.err("expected an attribute value"));
                        }
                        v
                    }
                };
                self.skip_ws();
                match self.peek() {
                    Some(b']') => {
                        self.i += 1;
                        Ok(AttrSel {
                            name,
                            value: Some((op, value)),
                        })
                    }
                    None => Err(self.err("expected ']'")),
                    Some(_) => Err(self.err("expected ']' (attribute flags are not supported)")),
                }
            }
            Some(b'~' | b'|') => {
                Err(self.err("only the '=', '^=', '$=' and '*=' attribute operators are supported"))
            }
            None => Err(self.err("expected ']'")),
            Some(_) => Err(self.err("unexpected character in attribute selector")),
        }
    }

    fn pseudo(&mut self) -> Result<Pseudo, SvgError> {
        if self.peek() == Some(b':') {
            return Err(self.err("pseudo-elements are not supported"));
        }
        let name = self.word(&[])?.to_ascii_lowercase();
        if self.peek() == Some(b'(') {
            return Err(self.err(&format!("pseudo-class ':{name}()' is not supported")));
        }
        let p = match name.as_str() {
            "small" => Pseudo::Small,
            "background" => Pseudo::Background,
            "filled" => Pseudo::Filled,
            "unfilled" => Pseudo::Unfilled,
            "" => return Err(self.err("expected a pseudo-class name")),
            _ => return Err(self.err(&format!("unknown pseudo-class ':{name}'"))),
        };
        if self.mode == SelectorMode::Css {
            return Err(self.err(&format!("':{name}' is not allowed in style sheets")));
        }
        Ok(p)
    }
}

pub(crate) fn parse_selector_list(s: &str, mode: SelectorMode) -> Result<Selector, SvgError> {
    let mut p = P {
        s,
        b: s.as_bytes(),
        i: 0,
        mode,
    };
    if s.bytes().all(is_ws) {
        return Err(p.err("empty selector"));
    }
    Ok(Selector {
        selectors: p.list()?,
    })
}

/// Geometry context of the pseudo-classes.
#[derive(Clone, Copy, Debug)]
pub(crate) struct MatchContext {
    pub canvas_width: f64,
    pub canvas_height: f64,
}

fn compound_matches(c: &Compound, els: &[Element], i: usize, ctx: &MatchContext) -> bool {
    let el = &els[i];
    if let Some(t) = &c.tag {
        if el.tag != *t {
            return false;
        }
    }
    for id in &c.ids {
        if el.id.as_deref() != Some(id.as_str()) {
            return false;
        }
    }
    for cl in &c.classes {
        if !el.classes.iter().any(|x| x == cl) {
            return false;
        }
    }
    for a in &c.attrs {
        match el.attr(&a.name) {
            None => return false,
            Some(v) => {
                if let Some((op, want)) = &a.value {
                    let ok = match op {
                        AttrOp::Equals => v == want,
                        AttrOp::Prefix => !want.is_empty() && v.starts_with(want.as_str()),
                        AttrOp::Suffix => !want.is_empty() && v.ends_with(want.as_str()),
                        AttrOp::Contains => !want.is_empty() && v.contains(want.as_str()),
                    };
                    if !ok {
                        return false;
                    }
                }
            }
        }
    }
    for p in &c.pseudos {
        let ok = match p {
            Pseudo::Small => el.bbox.is_some_and(|b| b.w <= SMALL_PX && b.h <= SMALL_PX),
            Pseudo::Background => el.bbox.is_some_and(|b| {
                b.w >= BACKGROUND_FRACTION * ctx.canvas_width
                    && b.h >= BACKGROUND_FRACTION * ctx.canvas_height
            }),
            Pseudo::Filled => el.filled,
            Pseudo::Unfilled => !el.filled,
        };
        if !ok {
            return false;
        }
    }
    true
}

pub(crate) fn complex_matches(
    sel: &Complex,
    els: &[Element],
    i: usize,
    ctx: &MatchContext,
) -> bool {
    let m = sel.compounds.len();
    if !compound_matches(&sel.compounds[m - 1], els, i, ctx) {
        return false;
    }
    if m == 1 {
        return true;
    }
    // chain[0] = the element, chain[d] = its d-th ancestor.
    let mut chain = vec![i];
    let mut p = els[i].parent;
    while let Some(x) = p {
        chain.push(x);
        p = els[x].parent;
    }
    let l = chain.len();
    // reach[d]: compounds k+1.. match with compound k+1 at chain[d].
    let mut reach = vec![false; l];
    reach[0] = true;
    let mut next = vec![false; l];
    for k in (0..m - 1).rev() {
        let comb = sel.combinators[k];
        let mut any_before = reach[0];
        let mut found = false;
        next[0] = false;
        for d in 1..l {
            let ok = match comb {
                Combinator::Child => reach[d - 1],
                Combinator::Descendant => any_before,
            };
            next[d] = ok && compound_matches(&sel.compounds[k], els, chain[d], ctx);
            found |= next[d];
            any_before = any_before || reach[d];
        }
        if !found {
            return false;
        }
        std::mem::swap(&mut reach, &mut next);
    }
    true
}

impl Selector {
    pub(crate) fn matches_in(&self, els: &[Element], i: usize, ctx: &MatchContext) -> bool {
        self.selectors
            .iter()
            .any(|c| complex_matches(c, els, i, ctx))
    }
}
