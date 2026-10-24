//! A small, iterative XML 1.0 parser with namespaces and internal DTD entities.
//!
//! This is a line-by-line mirror of `ts/packages/svg/src/xml.ts`. Its acceptance rules
//! follow `roxmltree` (which the test suite uses as an oracle), but nesting is handled
//! with an explicit stack, so deeply nested input can never overflow the call stack
//! (roxmltree recurses once per nesting level; see ADR obstacles/svg).

use crate::error::{SvgError, SvgErrorCode};

pub(crate) const NS_SVG: &str = "http://www.w3.org/2000/svg";
pub(crate) const NS_XLINK: &str = "http://www.w3.org/1999/xlink";
pub(crate) const NS_XML: &str = "http://www.w3.org/XML/1998/namespace";
const NS_XMLNS: &str = "http://www.w3.org/2000/xmlns/";

/// Maximum element nesting depth (the root element has depth 1).
pub(crate) const MAX_DEPTH: usize = 1024;
/// Maximum number of elements in a document.
pub(crate) const MAX_ELEMENTS: usize = 1_000_000;
/// Maximum nesting of entity references (as roxmltree).
const MAX_ENTITY_DEPTH: u32 = 10;
/// Maximum number of references resolved by one top-level entity reference (as roxmltree).
const MAX_ENTITY_REFS: u32 = 255;

/// An attribute (namespace declarations are not attributes).
#[derive(Debug, Clone)]
pub(crate) struct XmlAttr {
    /// Qualified name as written (`xlink:href`).
    pub qname: String,
    /// Byte offset of the local part in `qname`.
    pub local: usize,
    /// Namespace (index into [`XmlDoc::namespaces`]); `None` for unprefixed attributes.
    pub ns: Option<u32>,
    /// Normalized value (references expanded, whitespace characters mapped to spaces).
    pub value: String,
}

impl XmlAttr {
    pub(crate) fn local_name(&self) -> &str {
        &self.qname[self.local..]
    }
}

#[derive(Debug, Clone)]
pub(crate) enum XmlNode {
    Element(usize),
    /// Character data (adjacent text and CDATA merged; comments and PIs split it).
    Text(String),
}

#[derive(Debug, Clone)]
pub(crate) struct XmlElement {
    /// Qualified name as written.
    pub qname: String,
    /// Byte offset of the local part in `qname`.
    pub local: usize,
    /// Namespace (index into [`XmlDoc::namespaces`]).
    pub ns: Option<u32>,
    pub attrs: Vec<XmlAttr>,
    pub parent: Option<usize>,
    pub children: Vec<XmlNode>,
}

impl XmlElement {
    #[cfg(test)]
    pub(crate) fn local_name(&self) -> &str {
        &self.qname[self.local..]
    }
}

/// Elements in document order (pre-order), the root element first.
#[derive(Debug, Default)]
pub(crate) struct XmlDoc {
    pub elements: Vec<XmlElement>,
    /// Interned namespace URIs. Index 0 is always the XML namespace.
    pub namespaces: Vec<String>,
}

impl XmlDoc {
    #[cfg(test)]
    pub(crate) fn ns_uri(&self, ns: Option<u32>) -> Option<&str> {
        ns.map(|i| self.namespaces[i as usize].as_str())
    }
}

/// Parses `input` into an [`XmlDoc`].
pub(crate) fn parse_xml(input: &str) -> Result<XmlDoc, SvgError> {
    let mut c = Cursor { s: input, pos: 0 };
    if input.starts_with('\u{FEFF}') {
        c.pos = 3;
    }
    let mut b = Builder::new();
    parse_declaration(&mut c)?;
    parse_misc(&mut c)?;
    c.skip_ws();
    if c.starts_with("<!DOCTYPE") {
        parse_doctype(&mut c, &mut b)?;
        parse_misc(&mut c)?;
    }
    c.skip_ws();
    if c.at_end() {
        return Err(SvgError::new(
            SvgErrorCode::Parse,
            "XML: the document has no root element",
        ));
    }
    if c.peek() != Some(b'<') || matches!(c.peek_at(1), Some(b'!' | b'?' | b'/')) {
        return Err(c.err("unexpected content before the root element"));
    }
    parse_start_tag(&mut c, &mut b)?;
    if !b.stack.is_empty() {
        parse_content(&mut c, &mut b, 0, false)?;
    }
    parse_misc(&mut c)?;
    if !c.at_end() {
        return Err(c.err("unexpected content after the root element"));
    }
    Ok(XmlDoc {
        elements: b.elements,
        namespaces: b.namespaces,
    })
}

// ---------------------------------------------------------------------------------------
// Characters

#[inline]
fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

#[inline]
fn is_xml_char(c: char) -> bool {
    let u = c as u32;
    if u < 0x20 {
        matches!(u, 0x9 | 0xA | 0xD)
    } else {
        u <= 0xD7FF || (0xE000..=0xFFFD).contains(&u) || u >= 0x10000
    }
}

#[inline]
fn is_ascii_name_start(b: u8) -> bool {
    matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b':' | b'_')
}

#[inline]
fn is_ascii_name_char(b: u8) -> bool {
    matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b':' | b'_' | b'-' | b'.')
}

fn is_name_start(c: char) -> bool {
    let u = c as u32;
    if u < 128 {
        return is_ascii_name_start(u as u8);
    }
    matches!(u,
        0xC0..=0xD6 | 0xD8..=0xF6 | 0xF8..=0x2FF | 0x370..=0x37D | 0x37F..=0x1FFF
        | 0x200C..=0x200D | 0x2070..=0x218F | 0x2C00..=0x2FEF | 0x3001..=0xD7FF
        | 0xF900..=0xFDCF | 0xFDF0..=0xFFFD | 0x10000..=0xEFFFF)
}

fn is_name_char(c: char) -> bool {
    let u = c as u32;
    if u < 128 {
        return is_ascii_name_char(u as u8);
    }
    matches!(u,
        0xB7 | 0xC0..=0xD6 | 0xD8..=0xF6 | 0xF8..=0x2FF | 0x300..=0x36F | 0x370..=0x37D
        | 0x37F..=0x1FFF | 0x200C..=0x200D | 0x203F..=0x2040 | 0x2070..=0x218F
        | 0x2C00..=0x2FEF | 0x3001..=0xD7FF | 0xF900..=0xFDCF | 0xFDF0..=0xFFFD
        | 0x10000..=0xEFFFF)
}

fn starts_with_name_start(s: &str) -> bool {
    s.chars().next().is_some_and(is_name_start)
}

/// 1-based line and column (in code points) of byte offset `pos`.
fn line_col(s: &str, pos: usize) -> (usize, usize) {
    let mut p = pos.min(s.len());
    while !s.is_char_boundary(p) {
        p -= 1;
    }
    let before = &s[..p];
    let line = before.bytes().filter(|&b| b == b'\n').count() + 1;
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    let col = before[line_start..].chars().count() + 1;
    (line, col)
}

fn err_at(s: &str, pos: usize, msg: &str) -> SvgError {
    let (line, col) = line_col(s, pos);
    SvgError::new(
        SvgErrorCode::Parse,
        format!("XML: {msg} at line {line}, column {col}"),
    )
}

/// Checks that `s[start..end]` contains only XML characters.
fn check_chars(s: &str, start: usize, end: usize) -> Result<(), SvgError> {
    let part = &s[start..end];
    if part.bytes().all(|b| b >= 0x20 || is_ws(b)) {
        if part.is_ascii() {
            return Ok(());
        }
        for (i, ch) in part.char_indices() {
            if !is_xml_char(ch) {
                return Err(err_at(s, start + i, "a non-XML character"));
            }
        }
        return Ok(());
    }
    for (i, ch) in part.char_indices() {
        if !is_xml_char(ch) {
            return Err(err_at(s, start + i, "a non-XML character"));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Cursor and builder

struct Cursor<'a> {
    s: &'a str,
    pos: usize,
}

impl Cursor<'_> {
    #[inline]
    fn at_end(&self) -> bool {
        self.pos >= self.s.len()
    }
    #[inline]
    fn peek(&self) -> Option<u8> {
        self.s.as_bytes().get(self.pos).copied()
    }
    #[inline]
    fn peek_at(&self, k: usize) -> Option<u8> {
        self.s.as_bytes().get(self.pos + k).copied()
    }
    #[inline]
    fn starts_with(&self, p: &str) -> bool {
        self.s.as_bytes()[self.pos..].starts_with(p.as_bytes())
    }
    /// Skips XML whitespace; returns whether any was skipped.
    fn skip_ws(&mut self) -> bool {
        let start = self.pos;
        while let Some(b) = self.peek() {
            if !is_ws(b) {
                break;
            }
            self.pos += 1;
        }
        self.pos > start
    }
    /// Requires at least one whitespace character.
    fn consume_ws(&mut self) -> Result<(), SvgError> {
        if self.at_end() {
            return Err(self.err("unexpected end of input"));
        }
        if !self.skip_ws() {
            return Err(self.err("expected whitespace"));
        }
        Ok(())
    }
    fn expect(&mut self, b: u8, what: &str) -> Result<(), SvgError> {
        if self.peek() == Some(b) {
            self.pos += 1;
            Ok(())
        } else if self.at_end() {
            Err(self.err("unexpected end of input"))
        } else {
            Err(self.err(&format!("expected {what}")))
        }
    }
    fn err(&self, msg: &str) -> SvgError {
        err_at(self.s, self.pos, msg)
    }
    fn err_from(&self, pos: usize, msg: &str) -> SvgError {
        err_at(self.s, pos, msg)
    }
    fn next_char(&self) -> Option<char> {
        self.s[self.pos..].chars().next()
    }
}

struct Builder {
    elements: Vec<XmlElement>,
    namespaces: Vec<String>,
    /// Namespace bindings in scope: (prefix, namespace); prefix `None` = default namespace.
    scopes: Vec<(Option<String>, u32)>,
    /// Open elements: (element index, `scopes.len()` before its declarations).
    stack: Vec<(usize, usize)>,
    /// Entity declarations (first declaration wins).
    entities: Vec<(String, String)>,
    /// Whether the last child of the current element is text that new text may extend.
    text_open: bool,
    ref_depth: u32,
    ref_count: u32,
}

impl Builder {
    fn new() -> Self {
        Builder {
            elements: Vec::new(),
            namespaces: vec![NS_XML.to_string()],
            scopes: Vec::new(),
            stack: Vec::new(),
            entities: Vec::new(),
            text_open: false,
            ref_depth: 0,
            ref_count: 0,
        }
    }

    fn intern(&mut self, uri: &str) -> u32 {
        if let Some(i) = self.namespaces.iter().position(|n| n == uri) {
            return i as u32;
        }
        self.namespaces.push(uri.to_string());
        (self.namespaces.len() - 1) as u32
    }

    /// Resolves a prefix: `None` = unbound prefix; `Some(None)` = no namespace.
    fn resolve(&self, prefix: Option<&str>) -> Option<Option<u32>> {
        if prefix == Some("xml") {
            return Some(Some(0));
        }
        for (p, ns) in self.scopes.iter().rev() {
            if p.as_deref() == prefix {
                return Some(Some(*ns));
            }
        }
        if prefix.is_none() {
            Some(None)
        } else {
            None
        }
    }

    fn entity(&self, name: &str) -> Option<String> {
        self.entities
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.clone())
    }

    fn enter_entity(&mut self, c: &Cursor, pos: usize) -> Result<(), SvgError> {
        if self.ref_depth > 0 {
            if self.ref_count == MAX_ENTITY_REFS {
                return Err(c.err_from(pos, "entity reference loop"));
            }
            self.ref_count += 1;
        }
        if self.ref_depth < MAX_ENTITY_DEPTH {
            self.ref_depth += 1;
            Ok(())
        } else {
            Err(c.err_from(pos, "entity reference loop"))
        }
    }

    fn leave_entity(&mut self) {
        if self.ref_depth > 0 {
            self.ref_depth -= 1;
        }
        if self.ref_depth == 0 {
            self.ref_count = 0;
        }
    }

    fn append_text(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let Some(&(top, _)) = self.stack.last() else {
            return;
        };
        let children = &mut self.elements[top].children;
        if self.text_open {
            if let Some(XmlNode::Text(t)) = children.last_mut() {
                t.push_str(text);
                return;
            }
        }
        children.push(XmlNode::Text(text.to_string()));
        self.text_open = true;
    }
}

// ---------------------------------------------------------------------------------------
// Prolog

fn parse_declaration(c: &mut Cursor) -> Result<(), SvgError> {
    if !c.starts_with("<?xml ") {
        return Ok(());
    }
    c.pos += 5;
    decl_ws(c)?;
    if !c.starts_with("version") {
        return Err(c.err("expected 'version'"));
    }
    parse_pseudo_attr(c)?;
    decl_ws(c)?;
    if c.starts_with("encoding") {
        parse_pseudo_attr(c)?;
        decl_ws(c)?;
    }
    if c.starts_with("standalone") {
        parse_pseudo_attr(c)?;
    }
    c.skip_ws();
    if !c.starts_with("?>") {
        return Err(c.err("expected '?>'"));
    }
    c.pos += 2;
    Ok(())
}

/// Whitespace, unless the declaration ends here.
fn decl_ws(c: &mut Cursor) -> Result<(), SvgError> {
    if !c.skip_ws() && !c.starts_with("?>") && !c.at_end() {
        return Err(c.err("expected whitespace"));
    }
    Ok(())
}

fn parse_pseudo_attr(c: &mut Cursor) -> Result<(), SvgError> {
    consume_qname(c)?;
    c.skip_ws();
    c.expect(b'=', "'='")?;
    c.skip_ws();
    let q = match c.peek() {
        Some(q @ (b'"' | b'\'')) => q,
        None => return Err(c.err("unexpected end of input")),
        _ => return Err(c.err("expected a quote")),
    };
    c.pos += 1;
    loop {
        match c.peek() {
            None => return Err(c.err("unexpected end of input")),
            Some(b) if b == q => break,
            Some(b'<') => return Err(c.err("expected a quote")),
            Some(_) => c.pos += 1,
        }
    }
    c.pos += 1;
    Ok(())
}

fn parse_misc(c: &mut Cursor) -> Result<(), SvgError> {
    loop {
        c.skip_ws();
        if c.starts_with("<!--") {
            parse_comment(c)?;
        } else if c.starts_with("<?") {
            parse_pi(c)?;
        } else {
            return Ok(());
        }
    }
}

fn parse_comment(c: &mut Cursor) -> Result<(), SvgError> {
    let start = c.pos;
    c.pos += 4;
    let Some(k) = c.s[c.pos..].find("-->") else {
        c.pos = c.s.len();
        return Err(c.err("unexpected end of input inside a comment"));
    };
    let (ts, te) = (c.pos, c.pos + k);
    check_chars(c.s, ts, te)?;
    let text = &c.s[ts..te];
    if text.contains("--") || text.ends_with('-') {
        return Err(c.err_from(start, "a comment contains '--'"));
    }
    c.pos = te + 3;
    Ok(())
}

fn parse_pi(c: &mut Cursor) -> Result<(), SvgError> {
    if c.starts_with("<?xml ") {
        return Err(c.err("unexpected XML declaration"));
    }
    c.pos += 2;
    consume_name(c)?;
    c.skip_ws();
    let Some(k) = c.s[c.pos..].find("?>") else {
        c.pos = c.s.len();
        return Err(c.err("unexpected end of input inside a processing instruction"));
    };
    check_chars(c.s, c.pos, c.pos + k)?;
    c.pos += k + 2;
    Ok(())
}

fn parse_doctype(c: &mut Cursor, b: &mut Builder) -> Result<(), SvgError> {
    c.pos += 9;
    c.consume_ws()?;
    consume_name(c)?;
    c.skip_ws();
    parse_external_id(c)?;
    c.skip_ws();
    match c.peek() {
        Some(b'>') => {
            c.pos += 1;
            return Ok(());
        }
        Some(b'[') => c.pos += 1,
        Some(_) => return Err(c.err("expected '[' or '>'")),
        None => return Err(c.err("unexpected end of input")),
    }
    loop {
        c.skip_ws();
        if c.starts_with("<!ENTITY") {
            parse_entity_decl(c, b)?;
        } else if c.starts_with("<!--") {
            parse_comment(c)?;
        } else if c.starts_with("<?") {
            parse_pi(c)?;
        } else if c.starts_with("]") {
            c.pos += 1;
            c.skip_ws();
            c.expect(b'>', "'>'")?;
            return Ok(());
        } else if c.starts_with("<!ELEMENT")
            || c.starts_with("<!ATTLIST")
            || c.starts_with("<!NOTATION")
        {
            let start = c.pos;
            match c.s[c.pos..].find('>') {
                Some(k) => c.pos += k + 1,
                None => return Err(c.err_from(start, "unknown token in the DTD")),
            }
        } else if c.at_end() {
            return Err(c.err("unexpected end of input"));
        } else {
            return Err(c.err("unknown token in the DTD"));
        }
    }
}

/// `SYSTEM "uri"` or `PUBLIC "id" "uri"`; returns whether one was present.
fn parse_external_id(c: &mut Cursor) -> Result<bool, SvgError> {
    let public = c.starts_with("PUBLIC");
    if !public && !c.starts_with("SYSTEM") {
        return Ok(false);
    }
    c.pos += 6;
    c.consume_ws()?;
    skip_literal(c)?;
    if public {
        c.consume_ws()?;
        skip_literal(c)?;
    }
    Ok(true)
}

/// A quoted literal; returns its byte range.
fn skip_literal(c: &mut Cursor) -> Result<(usize, usize), SvgError> {
    let q = match c.peek() {
        Some(q @ (b'"' | b'\'')) => q,
        None => return Err(c.err("unexpected end of input")),
        _ => return Err(c.err("expected a quote")),
    };
    c.pos += 1;
    let start = c.pos;
    match c.s.as_bytes()[c.pos..].iter().position(|&x| x == q) {
        Some(k) => {
            c.pos += k + 1;
            Ok((start, start + k))
        }
        None => {
            c.pos = c.s.len();
            Err(c.err("unexpected end of input"))
        }
    }
}

fn parse_entity_decl(c: &mut Cursor, b: &mut Builder) -> Result<(), SvgError> {
    c.pos += 8;
    c.consume_ws()?;
    let general = if c.peek() == Some(b'%') {
        c.pos += 1;
        c.consume_ws()?;
        false
    } else {
        true
    };
    let name = consume_name(c)?.to_string();
    c.consume_ws()?;
    match c.peek() {
        Some(b'"' | b'\'') => {
            let (vs, ve) = skip_literal(c)?;
            let value = c.s[vs..ve].to_string();
            if !b.entities.iter().any(|(n, _)| *n == name) {
                b.entities.push((name, value));
            }
        }
        Some(b'S' | b'P') => {
            if !parse_external_id(c)? {
                return Err(c.err("invalid external id"));
            }
            if general {
                c.skip_ws();
                if c.starts_with("NDATA") {
                    c.pos += 5;
                    c.consume_ws()?;
                    consume_name(c)?;
                }
            }
        }
        Some(_) => return Err(c.err("expected a quote, SYSTEM or PUBLIC")),
        None => return Err(c.err("unexpected end of input")),
    }
    c.skip_ws();
    c.expect(b'>', "'>'")
}

// ---------------------------------------------------------------------------------------
// Names

/// A `Name` (colons allowed anywhere).
fn consume_name<'a>(c: &mut Cursor<'a>) -> Result<&'a str, SvgError> {
    let start = c.pos;
    match c.next_char() {
        Some(ch) if is_name_start(ch) => c.pos += ch.len_utf8(),
        Some(_) => return Err(c.err("invalid name")),
        None => return Err(c.err("unexpected end of input")),
    }
    while let Some(ch) = c.next_char() {
        if !is_name_char(ch) {
            break;
        }
        c.pos += ch.len_utf8();
    }
    Ok(&c.s[start..c.pos])
}

/// A qualified name; returns it with the byte offset of its local part.
fn consume_qname(c: &mut Cursor) -> Result<(String, usize), SvgError> {
    let start = c.pos;
    let mut colon: Option<usize> = None;
    while let Some(b) = c.peek() {
        if b < 128 {
            if b == b':' {
                if colon.is_some() {
                    return Err(c.err_from(start, "invalid name"));
                }
                colon = Some(c.pos);
                c.pos += 1;
            } else if is_ascii_name_char(b) {
                c.pos += 1;
            } else {
                break;
            }
        } else {
            match c.next_char() {
                Some(ch) if is_name_char(ch) => c.pos += ch.len_utf8(),
                _ => break,
            }
        }
    }
    let q = &c.s[start..c.pos];
    let local = colon.map_or(0, |k| k - start + 1);
    let prefix = if local > 0 { &q[..local - 1] } else { "" };
    if !prefix.is_empty() && !starts_with_name_start(prefix) {
        return Err(c.err_from(start, "invalid name"));
    }
    if !starts_with_name_start(&q[local..]) {
        return Err(c.err_from(
            start,
            if c.at_end() {
                "unexpected end of input"
            } else {
                "invalid name"
            },
        ));
    }
    Ok((q.to_string(), local))
}

fn prefix_of(qname: &str, local: usize) -> Option<&str> {
    if local == 0 {
        return None;
    }
    let p = &qname[..local - 1];
    if p.is_empty() {
        None
    } else {
        Some(p)
    }
}

// ---------------------------------------------------------------------------------------
// Elements and content

fn parse_start_tag(c: &mut Cursor, b: &mut Builder) -> Result<(), SvgError> {
    let tag_start = c.pos;
    c.pos += 1;
    let (qname, local) = consume_qname(c)?;
    // (qname, local offset, value start, value end, attribute start)
    let mut raw: Vec<(String, usize, usize, usize, usize)> = Vec::new();
    let self_closing;
    loop {
        let had_ws = c.skip_ws();
        match c.peek() {
            None => return Err(c.err("unexpected end of input")),
            Some(b'/') => {
                c.pos += 1;
                c.expect(b'>', "'>'")?;
                self_closing = true;
                break;
            }
            Some(b'>') => {
                c.pos += 1;
                self_closing = false;
                break;
            }
            Some(_) => {
                if !had_ws {
                    return Err(c.err("expected whitespace"));
                }
                let astart = c.pos;
                let (aq, al) = consume_qname(c)?;
                c.skip_ws();
                c.expect(b'=', "'='")?;
                c.skip_ws();
                let q = match c.peek() {
                    Some(q @ (b'"' | b'\'')) => q,
                    None => return Err(c.err("unexpected end of input")),
                    _ => return Err(c.err("expected a quote")),
                };
                c.pos += 1;
                let vs = c.pos;
                loop {
                    match c.peek() {
                        None => return Err(c.err("unexpected end of input")),
                        Some(x) if x == q => break,
                        Some(b'<') => return Err(c.err("'<' is not allowed in attribute values")),
                        Some(_) => c.pos += 1,
                    }
                }
                let ve = c.pos;
                check_chars(c.s, vs, ve)?;
                c.pos += 1;
                if raw.iter().any(|r| r.0 == aq) {
                    return Err(c.err_from(astart, &format!("duplicated attribute '{aq}'")));
                }
                raw.push((aq, al, vs, ve, astart));
            }
        }
    }

    // Namespace declarations.
    let scopes_before = b.scopes.len();
    for (aq, al, vs, ve, astart) in &raw {
        let is_default = aq == "xmlns";
        let prefix = prefix_of(aq, *al);
        if !is_default && prefix != Some("xmlns") {
            continue;
        }
        let value = normalize_attr(c, b, *vs, *ve)?;
        if is_default {
            if value == NS_XML || value == NS_XMLNS {
                return Err(c.err_from(*astart, "invalid default namespace"));
            }
            let ns = b.intern(&value);
            b.scopes.push((None, ns));
            continue;
        }
        let name = &aq[*al..];
        if name == "xml" {
            if value != NS_XML {
                return Err(c.err_from(
                    *astart,
                    "the 'xml' prefix must be bound to the XML namespace",
                ));
            }
            continue;
        }
        if name == "xmlns" {
            return Err(c.err_from(*astart, "the 'xmlns' prefix must not be declared"));
        }
        if value == NS_XML || value == NS_XMLNS {
            return Err(c.err_from(*astart, "a reserved namespace is bound to another prefix"));
        }
        if b.scopes[scopes_before..]
            .iter()
            .any(|(p, _)| p.as_deref() == Some(name))
        {
            return Err(c.err_from(
                *astart,
                &format!("namespace prefix '{name}' is declared twice"),
            ));
        }
        let ns = b.intern(&value);
        b.scopes.push((Some(name.to_string()), ns));
    }

    // The element's namespace.
    let eprefix = prefix_of(&qname, local);
    if eprefix == Some("xmlns") {
        return Err(c.err_from(tag_start, "'xmlns' cannot be used as an element prefix"));
    }
    let Some(ens) = b.resolve(eprefix) else {
        return Err(c.err_from(
            tag_start,
            &format!("unknown namespace prefix '{}'", eprefix.unwrap_or("")),
        ));
    };

    // Attributes.
    let mut attrs: Vec<XmlAttr> = Vec::with_capacity(raw.len());
    for (aq, al, vs, ve, astart) in raw {
        let prefix = prefix_of(&aq, al);
        if aq == "xmlns" || prefix == Some("xmlns") {
            continue;
        }
        let ns = match prefix {
            None => None,
            Some(p) => match b.resolve(Some(p)) {
                Some(ns) => ns,
                None => return Err(c.err_from(astart, &format!("unknown namespace prefix '{p}'"))),
            },
        };
        if ns.is_some()
            && attrs
                .iter()
                .any(|a| a.ns == ns && a.local_name() == &aq[al..])
        {
            return Err(c.err_from(astart, &format!("duplicated attribute '{aq}'")));
        }
        let value = normalize_attr(c, b, vs, ve)?;
        attrs.push(XmlAttr {
            qname: aq,
            local: al,
            ns,
            value,
        });
    }

    let idx = b.elements.len();
    if idx >= MAX_ELEMENTS {
        return Err(SvgError::new(
            SvgErrorCode::Limit,
            format!("XML: more than {MAX_ELEMENTS} elements"),
        ));
    }
    if b.stack.len() + 1 > MAX_DEPTH {
        return Err(SvgError::new(
            SvgErrorCode::Limit,
            format!("XML: elements nested deeper than {MAX_DEPTH} levels"),
        ));
    }
    let parent = b.stack.last().map(|&(p, _)| p);
    if let Some(p) = parent {
        b.elements[p].children.push(XmlNode::Element(idx));
    }
    b.elements.push(XmlElement {
        qname,
        local,
        ns: ens,
        attrs,
        parent,
        children: Vec::new(),
    });
    b.text_open = false;
    if self_closing {
        b.scopes.truncate(scopes_before);
    } else {
        b.stack.push((idx, scopes_before));
    }
    Ok(())
}

fn parse_end_tag(c: &mut Cursor, b: &mut Builder, base: usize) -> Result<(), SvgError> {
    let start = c.pos;
    c.pos += 2;
    let (qname, _) = consume_qname(c)?;
    c.skip_ws();
    c.expect(b'>', "'>'")?;
    if b.stack.len() <= base {
        return Err(c.err_from(start, &format!("unexpected closing tag '</{qname}>'")));
    }
    let (top, scopes_before) = *b.stack.last().expect("non-empty stack");
    if b.elements[top].qname != qname {
        let open = &b.elements[top].qname;
        return Err(c.err_from(start, &format!("expected '</{open}>', found '</{qname}>'")));
    }
    b.stack.pop();
    b.scopes.truncate(scopes_before);
    b.text_open = false;
    Ok(())
}

fn parse_content(
    c: &mut Cursor,
    b: &mut Builder,
    base: usize,
    in_entity: bool,
) -> Result<(), SvgError> {
    loop {
        let Some(ch) = c.peek() else {
            if in_entity {
                if b.stack.len() > base {
                    return Err(c.err("an element is not closed inside the entity"));
                }
                return Ok(());
            }
            return Err(c.err("unexpected end of input (unclosed element)"));
        };
        if ch != b'<' {
            parse_text(c, b)?;
            continue;
        }
        match c.peek_at(1) {
            Some(b'!') => {
                if c.starts_with("<!--") {
                    parse_comment(c)?;
                    b.text_open = false;
                } else if c.starts_with("<![CDATA[") {
                    let text = parse_cdata(c)?;
                    b.append_text(&text);
                } else {
                    return Err(c.err("unknown markup"));
                }
            }
            Some(b'?') => {
                parse_pi(c)?;
                b.text_open = false;
            }
            Some(b'/') => {
                parse_end_tag(c, b, base)?;
                if !in_entity && b.stack.is_empty() {
                    return Ok(());
                }
            }
            Some(_) => parse_start_tag(c, b)?,
            None => return Err(c.err("unexpected end of input")),
        }
    }
}

fn parse_cdata(c: &mut Cursor) -> Result<String, SvgError> {
    c.pos += 9;
    let Some(k) = c.s[c.pos..].find("]]>") else {
        c.pos = c.s.len();
        return Err(c.err("unexpected end of input inside CDATA"));
    };
    let (ts, te) = (c.pos, c.pos + k);
    check_chars(c.s, ts, te)?;
    c.pos = te + 3;
    Ok(normalize_newlines(&c.s[ts..te]))
}

fn normalize_newlines(s: &str) -> String {
    if !s.contains('\r') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(ch) = it.next() {
        if ch == '\r' {
            out.push('\n');
            if it.peek() == Some(&'\n') {
                it.next();
            }
        } else {
            out.push(ch);
        }
    }
    out
}

enum Ref<'a> {
    Char(char),
    Entity(&'a str),
}

/// Parses a reference at `s[i] == '&'`; returns it and the position after the `;`.
fn parse_reference(s: &str, i: usize) -> Option<(Ref<'_>, usize)> {
    let bytes = s.as_bytes();
    let mut j = i + 1;
    if bytes.get(j) == Some(&b'#') {
        j += 1;
        let hex = bytes.get(j) == Some(&b'x');
        if hex {
            j += 1;
        }
        let ds = j;
        while j < bytes.len()
            && (if hex {
                bytes[j].is_ascii_hexdigit()
            } else {
                bytes[j].is_ascii_digit()
            })
        {
            j += 1;
        }
        let n = u32::from_str_radix(&s[ds..j], if hex { 16 } else { 10 }).ok()?;
        let ch = char::from_u32(n).unwrap_or('\u{FFFD}');
        if !is_xml_char(ch) || bytes.get(j) != Some(&b';') {
            return None;
        }
        return Some((Ref::Char(ch), j + 1));
    }
    let ns = j;
    let first = s[j..].chars().next()?;
    if !is_name_start(first) {
        return None;
    }
    j += first.len_utf8();
    while let Some(ch) = s[j..].chars().next() {
        if !is_name_char(ch) {
            break;
        }
        j += ch.len_utf8();
    }
    if bytes.get(j) != Some(&b';') {
        return None;
    }
    let name = &s[ns..j];
    let r = match name {
        "quot" => Ref::Char('"'),
        "amp" => Ref::Char('&'),
        "apos" => Ref::Char('\''),
        "lt" => Ref::Char('<'),
        "gt" => Ref::Char('>'),
        _ => Ref::Entity(name),
    };
    Some((r, j + 1))
}

fn parse_text(c: &mut Cursor, b: &mut Builder) -> Result<(), SvgError> {
    let start = c.pos;
    let end = c.s.as_bytes()[start..]
        .iter()
        .position(|&x| x == b'<')
        .map_or(c.s.len(), |k| start + k);
    let raw = &c.s[start..end];
    if let Some(k) = raw.find("]]>") {
        return Err(c.err_from(start + k, "']]>' is not allowed in character data"));
    }
    check_chars(c.s, start, end)?;
    if !raw.bytes().any(|x| x == b'&' || x == b'\r') {
        b.append_text(raw);
        c.pos = end;
        return Ok(());
    }
    let mut buf = String::with_capacity(raw.len());
    let bytes = c.s.as_bytes();
    let mut i = start;
    while i < end {
        let x = bytes[i];
        if x == b'&' {
            let Some((r, next)) = parse_reference(c.s, i) else {
                return Err(c.err_from(i, "malformed entity reference"));
            };
            match r {
                Ref::Char(ch) => {
                    if b.ref_depth > 0 && ch == '\r' {
                        buf.push('\n');
                    } else {
                        buf.push(ch);
                    }
                }
                Ref::Entity(name) => {
                    let Some(value) = b.entity(name) else {
                        return Err(c.err_from(i, &format!("unknown entity reference '&{name};'")));
                    };
                    b.append_text(&buf);
                    buf.clear();
                    b.enter_entity(c, i)?;
                    let mut ec = Cursor { s: &value, pos: 0 };
                    let base = b.stack.len();
                    parse_content(&mut ec, b, base, true).map_err(|e| SvgError {
                        code: e.code,
                        message: format!("in entity '&{name};': {}", e.message),
                    })?;
                    b.leave_entity();
                }
            }
            i = next;
        } else if x == b'\r' {
            buf.push('\n');
            i += 1;
            if i < end && bytes[i] == b'\n' {
                i += 1;
            }
        } else {
            let k = bytes[i..end]
                .iter()
                .position(|&y| y == b'&' || y == b'\r')
                .map_or(end, |k| i + k);
            buf.push_str(&c.s[i..k]);
            i = k;
        }
    }
    b.append_text(&buf);
    c.pos = end;
    Ok(())
}

/// Attribute-value normalization of `c.s[vs..ve]` (XML 1.0 §3.3.3, as roxmltree).
fn normalize_attr(c: &Cursor, b: &mut Builder, vs: usize, ve: usize) -> Result<String, SvgError> {
    let raw = &c.s[vs..ve];
    if !raw
        .bytes()
        .any(|x| matches!(x, b'&' | b'\t' | b'\n' | b'\r'))
    {
        return Ok(raw.to_string());
    }
    let mut out = String::with_capacity(raw.len());
    normalize_into(c, raw, vs, &mut out, b)?;
    Ok(out)
}

fn normalize_into(
    c: &Cursor,
    s: &str,
    base: usize,
    out: &mut String,
    b: &mut Builder,
) -> Result<(), SvgError> {
    let bytes = s.as_bytes();
    let mut i = 0;
    // Error positions are only meaningful for the top level (base = position in c.s).
    let top = b.ref_depth == 0;
    let pos_of = |i: usize| if top { base + i } else { base };
    while i < bytes.len() {
        let x = bytes[i];
        match x {
            b'&' => {
                let Some((r, next)) = parse_reference(s, i) else {
                    return Err(c.err_from(pos_of(i), "malformed entity reference"));
                };
                match r {
                    Ref::Char(ch) => {
                        if b.ref_depth > 0 {
                            if ch == '<' {
                                return Err(c.err_from(
                                    pos_of(i),
                                    "'<' is not allowed in attribute values",
                                ));
                            }
                            out.push(if matches!(ch, '\t' | '\n' | '\r') {
                                ' '
                            } else {
                                ch
                            });
                        } else {
                            out.push(ch);
                        }
                    }
                    Ref::Entity(name) => {
                        let Some(value) = b.entity(name) else {
                            return Err(c.err_from(
                                pos_of(i),
                                &format!("unknown entity reference '&{name};'"),
                            ));
                        };
                        let p = pos_of(i);
                        b.enter_entity(c, p)?;
                        normalize_into(c, &value, p, out, b)?;
                        b.leave_entity();
                    }
                }
                i = next;
            }
            b'\r' => {
                if bytes.get(i + 1) != Some(&b'\n') {
                    out.push(' ');
                }
                i += 1;
            }
            b'\t' | b'\n' => {
                out.push(' ');
                i += 1;
            }
            _ => {
                let k = bytes[i..]
                    .iter()
                    .position(|&y| matches!(y, b'&' | b'\t' | b'\n' | b'\r'))
                    .map_or(bytes.len(), |k| i + k);
                out.push_str(&s[i..k]);
                i = k;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Differential tests against roxmltree (dev-dependency), the parser whose acceptance
    //! rules we mirror.

    use super::*;

    /// Our tree as comparable lines.
    fn ours(doc: &XmlDoc) -> Vec<String> {
        let mut out = Vec::new();
        for (i, e) in doc.elements.iter().enumerate() {
            let ns = doc.ns_uri(e.ns).unwrap_or("");
            let mut attrs: Vec<String> = e
                .attrs
                .iter()
                .map(|a| {
                    format!(
                        "{}|{}={:?}",
                        doc.ns_uri(a.ns).unwrap_or(""),
                        a.local_name(),
                        a.value
                    )
                })
                .collect();
            attrs.sort();
            out.push(format!(
                "E{i} {{{ns}}}{} parent={:?} {:?}",
                e.local_name(),
                e.parent,
                attrs
            ));
            for c in &e.children {
                match c {
                    XmlNode::Element(k) => out.push(format!("  child E{k}")),
                    XmlNode::Text(t) => out.push(format!("  text {t:?}")),
                }
            }
        }
        out
    }

    /// roxmltree's tree in the same format.
    fn theirs(doc: &roxmltree::Document) -> Vec<String> {
        // Test-only lookup table; keys are roxmltree node ids (no output depends on its order).
        let mut index = std::collections::BTreeMap::new();
        let mut order = Vec::new();
        for n in doc.root().descendants().filter(|n| n.is_element()) {
            index.insert(n.id().get(), order.len());
            order.push(n);
        }
        let mut out = Vec::new();
        for (i, n) in order.iter().enumerate() {
            let ns = n.tag_name().namespace().unwrap_or("");
            let mut attrs: Vec<String> = n
                .attributes()
                .map(|a| {
                    format!(
                        "{}|{}={:?}",
                        a.namespace().unwrap_or(""),
                        a.name(),
                        a.value()
                    )
                })
                .collect();
            attrs.sort();
            let parent = n.parent_element().map(|p| index[&p.id().get()]);
            out.push(format!(
                "E{i} {{{ns}}}{} parent={parent:?} {attrs:?}",
                n.tag_name().name()
            ));
            for c in n.children() {
                if c.is_element() {
                    out.push(format!("  child E{}", index[&c.id().get()]));
                } else if c.is_text() {
                    out.push(format!("  text {:?}", c.text().unwrap_or("")));
                }
            }
        }
        out
    }

    fn compare(input: &str) -> Result<(), String> {
        let opt = roxmltree::ParsingOptions {
            allow_dtd: true,
            ..Default::default()
        };
        let r = roxmltree::Document::parse_with_options(input, opt);
        let o = parse_xml(input);
        match (&o, &r) {
            (Ok(a), Ok(b)) => {
                let (x, y) = (ours(a), theirs(b));
                if x != y {
                    return Err(format!(
                        "trees differ for {input:?}:\nours   {x:#?}\ntheirs {y:#?}"
                    ));
                }
                Ok(())
            }
            (Err(_), Err(_)) => Ok(()),
            (Ok(_), Err(e)) => Err(format!("we accept, roxmltree rejects ({e}): {input:?}")),
            // The one intended deviation: a namespace declaration repeated in one start tag
            // violates XML 1.0 "Unique Att Spec"; roxmltree does not check `xmlns`/`xmlns:xml`.
            (Err(e), Ok(_)) if e.message.contains("duplicated attribute 'xmlns") => Ok(()),
            (Err(e), Ok(_)) => Err(format!("we reject ({e}), roxmltree accepts: {input:?}")),
        }
    }

    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            // xorshift64*
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
        fn pick<'a>(&mut self, xs: &[&'a str]) -> &'a str {
            xs[self.below(xs.len())]
        }
    }

    const NAMES: &[&str] = &[
        "svg", "g", "rect", "p:rect", "q:x", "a", "élan", "x-1", "_u", "x.y", "zz:a:b", "1bad",
        ":c", "xmlns:z",
    ];
    const ATTRS: &[&str] = &[
        "a=\"1\"",
        "b='two'",
        "p:c=\"3\"",
        "xmlns=\"urn:d\"",
        "xmlns:p=\"urn:p\"",
        "xmlns:q='urn:q'",
        "xml:space=\"preserve\"",
        "e=\"&amp;&lt;&#65;&#x42;\"",
        "f=\"a\tb\nc\r\nd\"",
        "g=\"&ent;\"",
        "h=\"&mark;\"",
        "i=\"&#10;\"",
        "j=\"<\"",
        "a=\"dup\"",
        "k=\"&nope;\"",
        "l=\"&#0;\"",
        "m=\"&#xD800;\"",
        "n = \"spaced\"",
        "o=unquoted",
        "xmlns:xml=\"http://www.w3.org/XML/1998/namespace\"",
        "xmlns:r=\"\"",
        "s=\"&#x110000;\"",
        "t=\"&loop;\"",
    ];
    const TEXT: &[&str] = &[
        "hello",
        " ",
        "\n  ",
        "a&amp;b",
        "&lt;",
        "&#x263A;",
        "&ent;",
        "&mark;",
        "x]]>y",
        "&",
        "&nope;",
        "a\r\nb\rc",
        "<![CDATA[c<d]]>",
        "<!-- c -->",
        "<!-- a -- b -->",
        "<?pi data?>",
        "<?xml version='1.0'?>",
        "&#13;",
        "\u{1}",
        "é",
        "&loop;",
    ];

    fn element(r: &mut Rng, depth: usize, out: &mut String) {
        let name = r.pick(NAMES);
        out.push('<');
        out.push_str(name);
        for _ in 0..r.below(4) {
            out.push(' ');
            out.push_str(r.pick(ATTRS));
        }
        if depth > 3 || r.below(4) == 0 {
            out.push_str("/>");
            return;
        }
        out.push('>');
        for _ in 0..r.below(4) {
            if r.below(2) == 0 {
                out.push_str(r.pick(TEXT));
            } else {
                element(r, depth + 1, out);
            }
        }
        out.push_str("</");
        out.push_str(if r.below(20) == 0 { "other" } else { name });
        out.push('>');
    }

    fn document(r: &mut Rng) -> String {
        let mut s = String::new();
        if r.below(3) == 0 {
            s.push_str(r.pick(&[
                "<?xml version=\"1.0\"?>",
                "\u{FEFF}",
                "<?xml version='1.0' encoding='utf-8' standalone='no' ?>",
                "<?xml encoding='x'?>",
                "  ",
            ]));
        }
        if r.below(3) == 0 {
            s.push_str(r.pick(&[
                "<!DOCTYPE svg [<!ENTITY ent \"E\"><!ENTITY mark \"<b>m</b>\"><!ENTITY loop \"&loop;\">]>",
                "<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">",
                "<!DOCTYPE svg [<!ELEMENT svg ANY><!-- c --><!ENTITY % pe \"x\"><!ENTITY ent SYSTEM \"x.ent\">]>",
                "<!DOCTYPE svg [<!ENTITY ent 'a&#38;b'>]>",
            ]));
        }
        if r.below(4) == 0 {
            s.push_str("<!-- lead -->");
        }
        element(r, 0, &mut s);
        if r.below(5) == 0 {
            s.push_str(r.pick(&["<!-- tail -->", " ", "<?pi?>", "<x/>", "text"]));
        }
        if r.below(6) == 0 && !s.is_empty() {
            // Mutate: truncate or insert at a char boundary.
            let mut k = r.below(s.len());
            while !s.is_char_boundary(k) {
                k -= 1;
            }
            if r.below(2) == 0 {
                s.truncate(k);
            } else {
                s.insert_str(
                    k,
                    r.pick(&["<", ">", "&", "\"", "'", "]]>", "<!--", "/", "=", " "]),
                );
            }
        }
        s
    }

    #[test]
    fn matches_roxmltree_on_handwritten_cases() {
        let accepted = [
            "<svg/>",
            "\u{FEFF}<svg/>",
            "<?xml version=\"1.0\"?><svg/>",
            "<svg><!-- c --><?pi x?></svg>",
            "<svg a='1' b=\"2\" xmlns='urn:x' xmlns:p='urn:p' p:c='3'/>",
            "<svg>a<![CDATA[b]]>c<!--x-->d</svg>",
            "<!DOCTYPE s [<!ENTITY m \"<g id='q'>in</g>\">]><svg>a&m;b</svg>",
            "<!DOCTYPE s [<!ENTITY a \"x\"><!ENTITY b \"&a;&a;\">]><svg t='&b;'>&b;</svg>",
            "<svg a=\"x&#10;y&#9;z\" b=\"p\tq\nr\r\ns\"/>",
            "<svg>a\r\nb\rc&#13;d</svg>",
            "<svg :a='1'/>",
            "<s:svg xmlns:s='http://www.w3.org/2000/svg'><s:rect s:fill='red'/></s:svg>",
            "<svg xmlns='urn:a'><g xmlns=''><rect/></g></svg>",
            "<svg>&#x110000;&#xD800;</svg>",
            "<svg></svg >",
            "<svg\ta='1'\n/>",
            "<!DOCTYPE svg SYSTEM 'x.dtd'><svg/>",
        ];
        for c in accepted {
            compare(c).unwrap();
            assert!(parse_xml(c).is_ok(), "{c:?}");
        }
        let rejected = [
            "",
            "abc<svg/>",
            "<svg/>abc",
            "<svg/><svg/>",
            "<svg><g></svg>",
            "<svg a='1' a='2'/>",
            "<svg x:a='1'/>",
            "<svg>&nbsp;</svg>",
            "<svg><!-- a -- b --></svg>",
            "<svg>\u{1}</svg>",
            "<svg a='<'/>",
            "<svg>a ]]> b</svg>",
            "<svg>a & b</svg>",
            "<svg><?xml version='1.0'?></svg>",
            "<svg a='1'b='2'/>",
            "<svg a=1/>",
            "<svg/><!DOCTYPE x>",
            "<!DOCTYPE svg [<!ENTITY % p \"x\"> %p;]><svg/>",
            "<!DOCTYPE s [<!ENTITY e SYSTEM \"foo.xml\">]><svg>&e;</svg>",
            "<svg>&#0;</svg>",
            "<1svg/>",
            "<!doctype svg><svg/>",
            "<svg>&#X41;</svg>",
            "<svg a='&#;'/>",
            "<svg>\u{FFFE}</svg>",
            "<a:svg xmlns:a='u' xmlns:b='u'></b:svg>",
            "<?xml encoding='utf-8'?><svg/>",
            "<svg><!-- a ---></svg>",
            "<!DOCTYPE s [<!ENTITY b \"&zz;\">]><svg>&b;</svg>",
            "<svg xmlns='urn:a' xmlns='urn:a'/>",
        ];
        for c in rejected {
            compare(c).unwrap();
            assert!(parse_xml(c).is_err(), "{c:?}");
        }
    }

    #[test]
    fn matches_roxmltree_on_random_documents() {
        let mut r = Rng(0x9E37_79B9_7F4A_7C15);
        let mut failures = Vec::new();
        let (mut ok, mut err) = (0, 0);
        for _ in 0..20_000 {
            let doc = document(&mut r);
            match compare(&doc) {
                Ok(()) => {
                    if parse_xml(&doc).is_ok() {
                        ok += 1;
                    } else {
                        err += 1;
                    }
                }
                Err(e) => failures.push(e),
            }
        }
        assert!(
            ok > 1000 && err > 1000,
            "corpus too one-sided: {ok} ok, {err} errors"
        );
        let short: Vec<String> = failures
            .iter()
            .map(|f| f.lines().next().unwrap_or("").chars().take(300).collect())
            .collect();
        assert!(
            failures.is_empty(),
            "{} mismatches:\n{}",
            failures.len(),
            short.join("\n")
        );
    }
}
