//! Numbers, lengths and number lists (SVG micro-syntax). Mirrors `num.ts`.

/// SVG whitespace (space, tab, CR, LF, FF).
#[inline]
pub(crate) fn is_wsp(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0C)
}

pub(crate) fn skip_wsp(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && is_wsp(b[i]) {
        i += 1;
    }
    i
}

/// Skips `wsp* ,? wsp*`.
pub(crate) fn skip_comma_wsp(b: &[u8], i: usize) -> usize {
    let mut i = skip_wsp(b, i);
    if i < b.len() && b[i] == b',' {
        i = skip_wsp(b, i + 1);
    }
    i
}

/// Scans an SVG/CSS number at `i`: `[+-]? (digits ('.' digits?)? | '.' digits) ([eE][+-]?digits)?`.
/// An exponent marker without digits is not consumed. Returns the (finite) value and the
/// position after the number.
pub(crate) fn scan_number(b: &[u8], i: usize) -> Option<(f64, usize)> {
    let n = b.len();
    let start = i;
    let mut i = i;
    if i < n && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let int_start = i;
    while i < n && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut digits = i > int_start;
    if i < n && b[i] == b'.' {
        let f = i + 1;
        let mut j = f;
        while j < n && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > f {
            digits = true;
            i = j;
        } else if digits {
            i = f;
        }
    }
    if !digits {
        return None;
    }
    if i < n && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < n && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let ds = j;
        while j < n && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > ds {
            i = j;
        }
    }
    let text = std::str::from_utf8(&b[start..i]).ok()?;
    let v: f64 = text.parse().ok()?;
    if v.is_finite() {
        Some((v, i))
    } else {
        None
    }
}

/// Parses a complete number (surrounding whitespace allowed).
pub(crate) fn parse_number(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let i = skip_wsp(b, 0);
    let (v, j) = scan_number(b, i)?;
    if skip_wsp(b, j) == b.len() {
        Some(v)
    } else {
        None
    }
}

/// Numbers separated by comma-wsp; stops at the first error and returns what was read
/// plus whether the whole string was consumed.
pub(crate) fn parse_number_list(s: &str) -> (Vec<f64>, bool) {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = skip_wsp(b, 0);
    while i < b.len() {
        match scan_number(b, i) {
            Some((v, j)) => {
                out.push(v);
                i = skip_comma_wsp(b, j);
            }
            None => return (out, false),
        }
    }
    (out, true)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Unit {
    None,
    Px,
    Pt,
    Pc,
    In,
    Cm,
    Mm,
    Em,
    Ex,
    Rem,
    Percent,
}

pub(crate) const PT: f64 = 4.0 / 3.0;
pub(crate) const PC: f64 = 16.0;
pub(crate) const IN: f64 = 96.0;
pub(crate) const CM: f64 = 96.0 / 2.54;
pub(crate) const MM: f64 = 96.0 / 25.4;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Length {
    pub v: f64,
    pub unit: Unit,
}

impl Length {
    pub(crate) const fn px(v: f64) -> Length {
        Length {
            v,
            unit: Unit::None,
        }
    }

    /// Resolves to user units; `em` uses `font_size`, `%` uses `percent_ref`.
    pub(crate) fn resolve(&self, font_size: f64, percent_ref: f64) -> f64 {
        let v = self.v;
        match self.unit {
            Unit::None | Unit::Px => v,
            Unit::Pt => v * PT,
            Unit::Pc => v * PC,
            Unit::In => v * IN,
            Unit::Cm => v * CM,
            Unit::Mm => v * MM,
            Unit::Em => v * font_size,
            Unit::Ex => v * font_size / 2.0,
            Unit::Rem => v * 16.0,
            Unit::Percent => v * percent_ref / 100.0,
        }
    }
}

pub(crate) fn parse_unit(s: &str) -> Option<Unit> {
    let u = s.to_ascii_lowercase();
    Some(match u.as_str() {
        "" => Unit::None,
        "px" => Unit::Px,
        "pt" => Unit::Pt,
        "pc" => Unit::Pc,
        "in" => Unit::In,
        "cm" => Unit::Cm,
        "mm" => Unit::Mm,
        "em" => Unit::Em,
        "ex" => Unit::Ex,
        "rem" => Unit::Rem,
        "%" => Unit::Percent,
        _ => return None,
    })
}

/// Parses a single length (`10`, `10px`, `2.5em`, `50%`).
pub(crate) fn parse_length(s: &str) -> Option<Length> {
    let b = s.as_bytes();
    let i = skip_wsp(b, 0);
    let (v, j) = scan_number(b, i)?;
    let rest = s[j..].trim_end_matches(|c: char| c.is_ascii() && is_wsp(c as u8));
    let unit = parse_unit(rest)?;
    Some(Length { v, unit })
}

/// The first length of a whitespace/comma separated list (`x="10 20 30"`).
pub(crate) fn parse_first_length(s: &str) -> Option<Length> {
    let b = s.as_bytes();
    let i = skip_wsp(b, 0);
    let mut j = i;
    while j < b.len() && !is_wsp(b[j]) && b[j] != b',' {
        j += 1;
    }
    parse_length(&s[i..j])
}
