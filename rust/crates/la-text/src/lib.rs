//! TEMPORARY placeholder for the API developed on the text branch (replaced on merge).
//! Widths are approximated as 0.55 em per code point; wrapping is greedy.

#[derive(Debug, Clone)]
pub enum TextError {
    Invalid(String),
    Unsupported(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FontId(pub usize);

pub struct Font {
    upm: u16,
}
impl Font {
    pub fn from_bytes(_data: Vec<u8>) -> Result<Font, TextError> {
        Ok(Font { upm: 1000 })
    }
    pub fn units_per_em(&self) -> u16 {
        self.upm
    }
    pub fn ascender(&self) -> i16 {
        1069
    }
    pub fn descender(&self) -> i16 {
        -293
    }
    pub fn line_gap(&self) -> i16 {
        0
    }
    pub fn advance_units(&self, text: &str) -> i64 {
        text.chars().count() as i64 * 550
    }
    pub fn width(&self, text: &str, size: f64) -> f64 {
        self.advance_units(text) as f64 * size / self.upm as f64
    }
    pub fn width_shaped(&self, text: &str, size: f64) -> f64 {
        self.width(text, size)
    }
}

pub struct FontBook {
    fonts: Vec<(String, u16, bool, Font)>,
}
impl FontBook {
    pub fn with_bundled() -> FontBook {
        FontBook {
            fonts: vec![
                ("default".into(), 400, false, Font { upm: 1000 }),
                ("default".into(), 700, false, Font { upm: 1000 }),
            ],
        }
    }
    pub fn empty() -> FontBook {
        FontBook { fonts: vec![] }
    }
    pub fn register(
        &mut self,
        family: &str,
        weight: u16,
        italic: bool,
        data: Vec<u8>,
    ) -> Result<FontId, TextError> {
        self.fonts
            .push((family.to_string(), weight, italic, Font::from_bytes(data)?));
        Ok(FontId(self.fonts.len() - 1))
    }
    pub fn resolve(&self, _family: &str, weight: u16, _italic: bool) -> FontId {
        FontId(if weight >= 600 && self.fonts.len() > 1 {
            1
        } else {
            0
        })
    }
    pub fn font(&self, id: FontId) -> &Font {
        &self.fonts[id.0].3
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shaping {
    Simple,
    Full,
    Auto,
}
pub fn needs_complex_shaping(_text: &str) -> bool {
    false
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Truncate {
    None,
    End,
    Middle,
}
pub struct WrapOptions {
    pub max_width: Option<f64>,
    pub max_lines: usize,
    pub balance: bool,
    pub truncate: Truncate,
}
#[derive(Clone, Debug, PartialEq)]
pub struct TextVariant {
    pub lines: Vec<String>,
    pub widths: Vec<f64>,
    pub truncated: bool,
}

pub fn break_opportunities(text: &str) -> Vec<usize> {
    text.chars()
        .enumerate()
        .filter(|(_, c)| *c == ' ')
        .map(|(i, _)| i)
        .collect()
}
pub fn greedy_wrap(text: &str, max_width: f64, measure: &dyn Fn(&str) -> f64) -> Vec<String> {
    let mut lines = Vec::new();
    let mut cur = String::new();
    for w in text.split(' ') {
        let cand = if cur.is_empty() {
            w.to_string()
        } else {
            format!("{cur} {w}")
        };
        if !cur.is_empty() && measure(&cand) > max_width {
            lines.push(std::mem::take(&mut cur));
            cur = w.to_string();
        } else {
            cur = cand;
        }
    }
    lines.push(cur);
    lines
}
pub fn balanced_wrap(
    text: &str,
    n_lines: usize,
    max_width: Option<f64>,
    measure: &dyn Fn(&str) -> f64,
) -> Vec<String> {
    let total = measure(text);
    let w = max_width.unwrap_or(total / n_lines as f64 + 1.0);
    greedy_wrap(text, w, measure)
}
pub fn truncate_end(text: &str, max_width: f64, measure: &dyn Fn(&str) -> f64) -> String {
    let cs: Vec<char> = text.chars().collect();
    for n in (0..=cs.len()).rev() {
        let s: String = cs[..n].iter().collect::<String>() + "…";
        if measure(&s) <= max_width {
            return s;
        }
    }
    "…".into()
}
pub fn truncate_middle(
    text: &str,
    max_width: f64,
    _max_lines: usize,
    measure: &dyn Fn(&str) -> f64,
) -> Vec<String> {
    vec![truncate_end(text, max_width, measure)]
}
pub fn wrap_variants(
    text: &str,
    opts: &WrapOptions,
    measure: &dyn Fn(&str) -> f64,
) -> Vec<TextVariant> {
    let lines = match opts.max_width {
        Some(m) => greedy_wrap(text, m, measure),
        None => vec![text.to_string()],
    };
    let widths = lines.iter().map(|l| measure(l)).collect();
    vec![TextVariant {
        lines,
        widths,
        truncated: false,
    }]
}
pub fn extra_wrap_variants(
    text: &str,
    max_lines: usize,
    measure: &dyn Fn(&str) -> f64,
) -> Vec<TextVariant> {
    (2..=max_lines)
        .map(|n| {
            let lines = balanced_wrap(text, n, None, measure);
            let widths = lines.iter().map(|l| measure(l)).collect();
            TextVariant {
                lines,
                widths,
                truncated: false,
            }
        })
        .filter(|v| v.lines.len() > 1)
        .collect()
}
