//! Lengths with units (spec §2.1): numbers are px; strings `<n>px`, `<n>pt`, `<n>em`.

use serde_json::Value;

/// A length before resolution against a font size.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Length {
    Px(f64),
    Em(f64),
}

impl Length {
    /// Parse a JSON value (number or unit string). Returns `None` for invalid input.
    pub fn from_value(v: &Value) -> Option<Length> {
        match v {
            Value::Number(n) => n.as_f64().map(Length::Px),
            Value::String(s) => Length::parse(s),
            _ => None,
        }
    }

    /// Parse `"12px"`, `"9pt"`, `"0.3em"`.
    pub fn parse(s: &str) -> Option<Length> {
        let s = s.trim();
        let (num, unit) = if let Some(n) = s.strip_suffix("px") {
            (n, "px")
        } else if let Some(n) = s.strip_suffix("pt") {
            (n, "pt")
        } else if let Some(n) = s.strip_suffix("em") {
            (n, "em")
        } else {
            return None;
        };
        if num.is_empty() || num.contains(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-')) {
            return None;
        }
        let x: f64 = num.parse().ok()?;
        if !x.is_finite() {
            return None;
        }
        Some(match unit {
            "px" => Length::Px(x),
            "pt" => Length::Px(x * 4.0 / 3.0),
            _ => Length::Em(x),
        })
    }

    /// Resolve to pixels for a label with font size `em` (px).
    #[inline]
    pub fn px(&self, em: f64) -> f64 {
        match self {
            Length::Px(v) => *v,
            Length::Em(v) => v * em,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_units() {
        assert_eq!(Length::parse("12px"), Some(Length::Px(12.0)));
        assert_eq!(Length::parse("9pt"), Some(Length::Px(12.0)));
        assert_eq!(Length::parse("0.5em").unwrap().px(12.0), 6.0);
        assert_eq!(Length::parse(".5em").unwrap().px(10.0), 5.0);
        assert_eq!(Length::parse("3 px"), None);
        assert_eq!(Length::parse("3"), None);
        assert_eq!(Length::from_value(&serde_json::json!(4)), Some(Length::Px(4.0)));
    }
}
