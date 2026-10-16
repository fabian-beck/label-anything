//! Tokenizer for `spec/expr.peg`. Works on code points so that offsets are code-point
//! offsets (identical to the TypeScript implementation, which iterates code points).

use crate::error::ExprError;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Tok {
    Num(f64),
    Str(String),
    Ident(String),
    True,
    False,
    Null,
    In,
    Not,
    OrOr,
    AndAnd,
    Bang,
    EqEq,
    NotEq,
    Le,
    Ge,
    Lt,
    Gt,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Dot,
    LParen,
    RParen,
    LBracket,
    RBracket,
    Comma,
    Eof,
    /// A lexical error at this position; reported when the parser reaches it, so the
    /// first error in reading order wins.
    Error,
}

#[derive(Debug, Clone)]
pub(crate) struct Token {
    pub tok: Tok,
    pub offset: usize,
}

pub(crate) struct Lexed {
    pub tokens: Vec<Token>,
    pub error: Option<ExprError>,
}

pub(crate) fn describe(tok: &Tok) -> String {
    let s = match tok {
        Tok::Num(_) => "a number",
        Tok::Str(_) => "a string",
        Tok::Ident(name) => return format!("identifier '{name}'"),
        Tok::True => "'true'",
        Tok::False => "'false'",
        Tok::Null => "'null'",
        Tok::In => "'in'",
        Tok::Not => "'not'",
        Tok::OrOr => "'||'",
        Tok::AndAnd => "'&&'",
        Tok::Bang => "'!'",
        Tok::EqEq => "'=='",
        Tok::NotEq => "'!='",
        Tok::Le => "'<='",
        Tok::Ge => "'>='",
        Tok::Lt => "'<'",
        Tok::Gt => "'>'",
        Tok::Plus => "'+'",
        Tok::Minus => "'-'",
        Tok::Star => "'*'",
        Tok::Slash => "'/'",
        Tok::Percent => "'%'",
        Tok::Dot => "'.'",
        Tok::LParen => "'('",
        Tok::RParen => "')'",
        Tok::LBracket => "'['",
        Tok::RBracket => "']'",
        Tok::Comma => "','",
        Tok::Eof => "end of input",
        Tok::Error => "an invalid token",
    };
    s.to_string()
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Length of the longest prefix at position `i` matching the grammar's Number rule
/// (`[0-9]+ ('.' [0-9]+)? ([eE] [+-]? [0-9]+)?  /  '.' [0-9]+ ([eE] [+-]? [0-9]+)?`);
/// 0 if there is none. `at(k)` is the ASCII character at position `k` (0 past the end or
/// for non-ASCII characters).
pub(crate) fn number_len_by(at: impl Fn(usize) -> u8, i: usize) -> usize {
    let digit = |k: usize| at(k).is_ascii_digit();
    let mut k = i;
    while digit(k) {
        k += 1;
    }
    let int_digits = k - i;
    if at(k) == b'.' && digit(k + 1) {
        k += 1;
        while digit(k) {
            k += 1;
        }
    } else if int_digits == 0 {
        return 0;
    }
    if at(k) == b'e' || at(k) == b'E' {
        let mut e = k + 1;
        if at(e) == b'+' || at(e) == b'-' {
            e += 1;
        }
        if digit(e) {
            while digit(e) {
                e += 1;
            }
            k = e;
        }
    }
    k - i
}

fn hex4(s: &[char], at: usize) -> Option<u32> {
    if at + 4 > s.len() {
        return None;
    }
    let mut v = 0u32;
    for &c in &s[at..at + 4] {
        v = v * 16 + c.to_digit(16)?;
    }
    Some(v)
}

fn lex_string(s: &[char], i: &mut usize) -> Result<Tok, ExprError> {
    let start = *i;
    let quote = s[start];
    *i += 1;
    let mut out = String::new();
    loop {
        if *i >= s.len() {
            return Err(ExprError::syntax(start, "unterminated string"));
        }
        let c = s[*i];
        if c == quote {
            *i += 1;
            return Ok(Tok::Str(out));
        }
        if c != '\\' {
            out.push(c);
            *i += 1;
            continue;
        }
        if *i + 1 >= s.len() {
            return Err(ExprError::syntax(start, "unterminated string"));
        }
        let bs = *i;
        match s[bs + 1] {
            'n' => out.push('\n'),
            't' => out.push('\t'),
            'u' => {
                let cp = hex4(s, bs + 2).ok_or_else(|| {
                    ExprError::syntax(bs, "invalid \\u escape: expected 4 hex digits")
                })?;
                let unpaired = || ExprError::syntax(bs, "invalid \\u escape: unpaired surrogate");
                if (0xD800..0xDC00).contains(&cp) {
                    let lo = if bs + 7 < s.len() && s[bs + 6] == '\\' && s[bs + 7] == 'u' {
                        hex4(s, bs + 8)
                    } else {
                        None
                    };
                    match lo {
                        Some(lo) if (0xDC00..0xE000).contains(&lo) => {
                            let cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                            out.push(char::from_u32(cp).ok_or_else(unpaired)?);
                            *i = bs + 12;
                            continue;
                        }
                        _ => return Err(unpaired()),
                    }
                }
                out.push(char::from_u32(cp).ok_or_else(unpaired)?);
                *i = bs + 6;
                continue;
            }
            other => out.push(other),
        }
        *i = bs + 2;
    }
}

fn unexpected_char(c: char, at: usize) -> ExprError {
    let hint = match c {
        '=' => " (use '==' to compare)",
        '&' => " (use '&&')",
        '|' => " (use '||')",
        _ => "",
    };
    ExprError::syntax(at, format!("unexpected character '{c}'{hint}"))
}

pub(crate) fn lex(s: &[char]) -> Lexed {
    let mut tokens = Vec::new();
    let n = s.len();
    let at = |k: usize| {
        if k < n && s[k].is_ascii() {
            s[k] as u8
        } else {
            0
        }
    };
    let number_len = |i: usize| number_len_by(at, i);
    let mut i = 0;
    loop {
        while i < n && matches!(s[i], ' ' | '\t' | '\r' | '\n') {
            i += 1;
        }
        if i >= n {
            tokens.push(Token {
                tok: Tok::Eof,
                offset: n,
            });
            return Lexed {
                tokens,
                error: None,
            };
        }
        let start = i;
        let c = s[i];
        let next = if i + 1 < n { Some(s[i + 1]) } else { None };
        let res: Result<Tok, ExprError> = match c {
            '0'..='9' | '.' if number_len(i) > 0 => {
                let len = number_len(i);
                let text: String = s[i..i + len].iter().collect();
                i += len;
                match text.parse::<f64>() {
                    Ok(v) if v.is_finite() => Ok(Tok::Num(v)),
                    _ => Err(ExprError::syntax(start, "number out of range")),
                }
            }
            '"' | '\'' => lex_string(s, &mut i),
            c if is_ident_start(c) => {
                while i < n && is_ident_char(s[i]) {
                    i += 1;
                }
                let word: String = s[start..i].iter().collect();
                Ok(match word.as_str() {
                    "true" => Tok::True,
                    "false" => Tok::False,
                    "null" => Tok::Null,
                    "in" => Tok::In,
                    "not" => Tok::Not,
                    _ => Tok::Ident(word),
                })
            }
            _ => {
                let (tok, len) = match (c, next) {
                    ('|', Some('|')) => (Some(Tok::OrOr), 2),
                    ('&', Some('&')) => (Some(Tok::AndAnd), 2),
                    ('=', Some('=')) => (Some(Tok::EqEq), 2),
                    ('!', Some('=')) => (Some(Tok::NotEq), 2),
                    ('<', Some('=')) => (Some(Tok::Le), 2),
                    ('>', Some('=')) => (Some(Tok::Ge), 2),
                    ('!', _) => (Some(Tok::Bang), 1),
                    ('<', _) => (Some(Tok::Lt), 1),
                    ('>', _) => (Some(Tok::Gt), 1),
                    ('+', _) => (Some(Tok::Plus), 1),
                    ('-', _) => (Some(Tok::Minus), 1),
                    ('*', _) => (Some(Tok::Star), 1),
                    ('/', _) => (Some(Tok::Slash), 1),
                    ('%', _) => (Some(Tok::Percent), 1),
                    ('.', _) => (Some(Tok::Dot), 1),
                    ('(', _) => (Some(Tok::LParen), 1),
                    (')', _) => (Some(Tok::RParen), 1),
                    ('[', _) => (Some(Tok::LBracket), 1),
                    (']', _) => (Some(Tok::RBracket), 1),
                    (',', _) => (Some(Tok::Comma), 1),
                    _ => (None, 0),
                };
                i += len;
                tok.ok_or_else(|| unexpected_char(c, start))
            }
        };
        match res {
            Ok(tok) => tokens.push(Token { tok, offset: start }),
            Err(e) => {
                tokens.push(Token {
                    tok: Tok::Error,
                    offset: e.offset,
                });
                return Lexed {
                    tokens,
                    error: Some(e),
                };
            }
        }
    }
}
