//! Label measurement and label variants (spec §5.1–5.4).

use crate::env::{Env, FontSpec};
use crate::geom::Rect;
use crate::math::maxf;
use crate::model::{FixedKind, FontSel, Item, LabelShape, LabelSpec, PartSpec, TextSpec, Truncate};
use la_text::{FontBook, WrapOptions};
use std::sync::OnceLock;

/// The bundled font book (parsed once).
pub fn bundled_fonts() -> &'static FontBook {
    static B: OnceLock<FontBook> = OnceLock::new();
    B.get_or_init(FontBook::with_bundled)
}

/// Load the font files referenced by the items into a font book (bundled fonts first).
/// Returns `None` when no item references a font file. Font families named `default` that
/// carry a file are renamed so they never shadow the bundled font for other labels.
pub fn user_fonts(
    model: &mut crate::model::Model,
    env: &dyn Env,
) -> Result<Option<FontBook>, (String, String)> {
    use crate::model::{LabelSpec, PartSpec};
    let mut book: Option<FontBook> = None;
    let mut loaded: Vec<(String, String)> = Vec::new(); // (file, family)
    for (i, item) in model.items.iter_mut().enumerate() {
        let crate::model::Item {
            font, label, raw, ..
        } = item;
        // (composite part index, font)
        let mut fonts: Vec<(Option<usize>, &mut FontSel)> = vec![(None, font)];
        match label {
            LabelSpec::Text(t) => fonts.push((None, &mut t.font)),
            LabelSpec::Composite { parts, .. } => {
                for (k, p) in parts.iter_mut().enumerate() {
                    if let PartSpec::Text(t) = p {
                        fonts.push((Some(k), &mut t.font));
                    }
                }
            }
            _ => {}
        }
        for (part, f) in fonts {
            let Some(file) = f.file.clone() else { continue };
            if let Some((_, fam)) = loaded.iter().find(|(fl, _)| *fl == file) {
                f.family = fam.clone();
                continue;
            }
            let ptr = font_file_ptr(raw, i, part, &file);
            let bytes = if file.starts_with("data:") {
                crate::model::data_url_bytes(&file)
                    .ok_or_else(|| (ptr.clone(), "invalid data URL".to_string()))?
            } else {
                env.read_file(&file).map_err(|e| (ptr.clone(), e))?
            };
            let family = if f.family.eq_ignore_ascii_case("default") {
                format!("user-font-{}", loaded.len())
            } else {
                f.family.clone()
            };
            let b = book.get_or_insert_with(FontBook::with_bundled);
            b.register(&family, f.weight, f.italic, bytes)
                .map_err(|e| (ptr, e.to_string()))?;
            f.family = family.clone();
            loaded.push((file, family));
        }
    }
    Ok(book)
}

/// Where the font file of item `i` (of its composite part `part`) is set: the part's or
/// the label's `font.file` when it names `file`, else `defaults.font.file`.
fn font_file_ptr(raw: &serde_json::Value, i: usize, part: Option<usize>, file: &str) -> String {
    let names =
        |v: &serde_json::Value| v.pointer("/font/file").and_then(|f| f.as_str()) == Some(file);
    if let Some(k) = part {
        if raw.pointer(&format!("/label/parts/{k}")).is_some_and(names) {
            return format!("/items/{i}/label/parts/{k}/font/file");
        }
    }
    if raw.get("label").is_some_and(names) {
        return format!("/items/{i}/label/font/file");
    }
    "/defaults/font/file".to_string()
}

/// Text measurement with the host callback first, then the font book.
pub struct Measurer<'a> {
    pub fonts: &'a FontBook,
    pub env: &'a dyn Env,
    /// "auto" | "simple" | "full"
    pub shaping: &'a str,
}

impl<'a> Measurer<'a> {
    pub fn width(&self, font: &FontSel, scale: f64, text: &str) -> f64 {
        let spec = font.spec(scale);
        if let Some(m) = self.env.measure(text, &spec) {
            return m.width;
        }
        let f = self
            .fonts
            .font(self.fonts.resolve(&font.family, font.weight, font.italic));
        let full = match self.shaping {
            "full" => true,
            "auto" => la_text::needs_complex_shaping(text),
            _ => false,
        };
        if full {
            f.width_shaped(text, spec.size)
        } else {
            f.width(text, spec.size)
        }
    }

    /// The measure for wrapping and truncating `text`: `width`, a closure over
    /// [`Measurer::width`], unless that measures every string they produce with simple
    /// shaping — no host measurement, and shaping `simple`, or `auto` for a text without
    /// complex scripts (its lines, prefixes and `…` have none either). Then the font itself,
    /// which measures each candidate line in constant time with identical widths.
    pub fn wrap_measure<'m>(
        &'m self,
        font: &FontSel,
        scale: f64,
        text: &str,
        width: &'m dyn Fn(&str) -> f64,
    ) -> la_text::Measure<'m> {
        let simple = !self.env.has_measure_callback()
            && match self.shaping {
                "full" => false,
                "auto" => !la_text::needs_complex_shaping(text),
                _ => true,
            };
        if !simple {
            return la_text::Measure::Callback(width);
        }
        la_text::Measure::Font {
            font: self
                .fonts
                .font(self.fonts.resolve(&font.family, font.weight, font.italic)),
            size: font.spec(scale).size,
        }
    }

    /// The ink of `text` in px (spec §5.2): how far its glyphs reach above and below the
    /// baseline (the bounds of their outlines, `LAvb`), when the text is measured with
    /// simple shaping, its font has glyph bounds and a glyph of it has an outline; else
    /// `None`. For boxes whose vertical metrics are the font's, not the host's.
    pub fn ink(&self, font: &FontSel, scale: f64, text: &str) -> Option<(f64, f64)> {
        if match self.shaping {
            "full" => true,
            "auto" => la_text::needs_complex_shaping(text),
            _ => false,
        } {
            return None;
        }
        let spec = font.spec(scale);
        let f = self
            .fonts
            .font(self.fonts.resolve(&font.family, font.weight, font.italic));
        let (y0, y1) = f.ink_units(text)?;
        let upm = f.units_per_em() as f64;
        Some((y1 as f64 * spec.size / upm, -(y0 as f64) * spec.size / upm))
    }

    /// (ascent, descent) in px, both positive, and whether the host measured them.
    pub fn vmetrics(&self, font: &FontSel, scale: f64) -> (f64, f64, bool) {
        let spec: FontSpec = font.spec(scale);
        if let Some(m) = self.env.measure("", &spec) {
            return (m.ascent, m.descent, true);
        }
        let f = self
            .fonts
            .font(self.fonts.resolve(&font.family, font.weight, font.italic));
        let upm = f.units_per_em() as f64;
        (
            f.ascender() as f64 * spec.size / upm,
            -(f.descender() as f64) * spec.size / upm,
            false,
        )
    }
}

/// Resolved text of a variant.
#[derive(Clone, Debug, PartialEq)]
pub struct TextLayout {
    pub lines: Vec<String>,
    pub widths: Vec<f64>,
    /// Baseline of each line relative to the box top.
    pub baselines: Vec<f64>,
    pub x_offset: f64,
    pub font_size: f64,
    pub scale: f64,
    /// "original", "alternative:N", "truncated", "group"
    pub used: String,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PartKind {
    Text,
    Icon,
    Box,
}

impl PartKind {
    pub fn name(self) -> &'static str {
        match self {
            PartKind::Text => "text",
            PartKind::Icon => "icon",
            PartKind::Box => "box",
        }
    }
}

/// A part of a composite label, relative to the label box's top-left corner.
#[derive(Clone, Debug, PartialEq)]
pub struct PartLayout {
    pub kind: PartKind,
    pub rect: Rect,
    pub text: Option<TextLayout>,
}

/// One concrete label shape (spec §5.4).
#[derive(Clone, Debug, PartialEq)]
pub struct Variant {
    /// Box size including padding.
    pub w: f64,
    pub h: f64,
    /// Degradation level: 0 = normal, k = created by ladder step k-1.
    pub level: u8,
    /// Shape penalty (multiplied by `weights.shape`).
    pub penalty: f64,
    pub text: Option<TextLayout>,
    pub parts: Vec<PartLayout>,
    pub shape: LabelShape,
    /// Degradation steps this variant embodies (for `degrade_steps`).
    pub steps: Vec<String>,
    pub scale: f64,
}

impl Variant {
    pub fn lines(&self) -> usize {
        self.text.as_ref().map(|t| t.lines.len()).unwrap_or(1)
    }
}

/// The variant that shrunk variant `vi` was made from by the ladder's `shrink` step: the
/// first at scale 1 with the same text (lines, origin and truncation), or the first at
/// scale 1 of a label without text; `vi` itself when it is not shrunk (spec §6.6, §6.8).
pub fn full_size(variants: &[Variant], vi: usize) -> usize {
    let v = &variants[vi];
    if v.scale >= 1.0 {
        return vi;
    }
    let same_text = |e: &Variant| match (&e.text, &v.text) {
        (Some(a), Some(b)) => a.lines == b.lines && a.used == b.used && a.truncated == b.truncated,
        (None, None) => true,
        _ => false,
    };
    variants
        .iter()
        .position(|e| e.scale == 1.0 && same_text(e))
        .unwrap_or(vi)
}

/// Build a text variant from lines.
fn text_variant(
    m: &Measurer,
    spec: &TextSpec,
    pad: f64,
    scale: f64,
    lines: Vec<String>,
    used: &str,
    truncated: bool,
) -> Variant {
    let (asc, desc, host) = m.vmetrics(&spec.font, scale);
    // the box fits the ink: from the top of the first line's glyphs to the bottom of the
    // last line's, where their bounds are known and the font gives the vertical metrics
    // (spec §5.2)
    let ink = |l: &String| {
        if host {
            None
        } else {
            m.ink(&spec.font, scale, l)
        }
    };
    let top = lines.first().and_then(ink).map_or(asc, |ink| ink.0);
    let bottom = lines.last().and_then(ink).map_or(desc, |ink| ink.1);
    let size = spec.font.size * scale;
    let pitch = spec.font.line_height * size;
    let widths: Vec<f64> = lines
        .iter()
        .map(|l| m.width(&spec.font, scale, l))
        .collect();
    let mut wmax = 0.0;
    for &w in &widths {
        wmax = maxf(wmax, w);
    }
    let n = lines.len().max(1);
    let content_h = top + bottom + (n as f64 - 1.0) * pitch;
    let p = pad * scale;
    let baselines = (0..n).map(|i| p + top + i as f64 * pitch).collect();
    Variant {
        w: wmax + 2.0 * p,
        h: content_h + 2.0 * p,
        level: 0,
        penalty: 0.0,
        text: Some(TextLayout {
            lines,
            widths,
            baselines,
            x_offset: p,
            font_size: size,
            scale,
            used: used.to_string(),
            truncated,
        }),
        parts: vec![],
        shape: LabelShape::Rect,
        steps: vec![],
        scale,
    }
}

fn to_wrap_opts(spec: &TextSpec, scale: f64) -> Option<WrapOptions> {
    spec.wrap.as_ref().map(|w| WrapOptions {
        max_width: w.max_width.map(|x| x * scale),
        max_lines: w.max_lines,
        balance: w.balance,
        truncate: match spec.truncate {
            Truncate::None => la_text::Truncate::None,
            Truncate::End => la_text::Truncate::End,
            Truncate::Middle => la_text::Truncate::Middle,
        },
    })
}

/// The lines of a text broken by line feeds (hard breaks, spec §5.3; a `\r` before a
/// line feed is dropped), or `None` when it has none.
fn hard_lines(text: &str) -> Option<Vec<String>> {
    if !text.contains('\n') {
        return None;
    }
    Some(
        text.split('\n')
            .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
            .collect(),
    )
}

/// Normal-level variants of one text (original or alternative).
fn text_variants(
    m: &Measurer,
    spec: &TextSpec,
    text: &str,
    pad: f64,
    scale: f64,
    used: &str,
) -> Vec<Variant> {
    if let Some((w, h, lines)) = &spec.explicit {
        let p = pad * scale;
        let n = lines.len().max(1) as f64;
        let line_h = h * scale / n;
        let baselines = (0..lines.len().max(1))
            .map(|i| p + line_h * (i as f64 + 0.8))
            .collect();
        return vec![Variant {
            w: w * scale + 2.0 * p,
            h: h * scale + 2.0 * p,
            level: 0,
            penalty: 0.0,
            text: Some(TextLayout {
                lines: lines.clone(),
                widths: vec![w * scale; lines.len().max(1)],
                baselines,
                x_offset: p,
                font_size: spec.font.size * scale,
                scale,
                used: used.to_string(),
                truncated: false,
            }),
            parts: vec![],
            shape: LabelShape::Rect,
            steps: vec![],
            scale,
        }];
    }
    if let Some(lines) = hard_lines(text) {
        // the author's lines: never wrapped or truncated
        return vec![text_variant(m, spec, pad, scale, lines, used, false)];
    }
    let measure = |s: &str| m.width(&spec.font, scale, s);
    match to_wrap_opts(spec, scale) {
        None => vec![text_variant(
            m,
            spec,
            pad,
            scale,
            vec![text.to_string()],
            used,
            false,
        )],
        Some(opts) => la_text::wrap_variants(
            text,
            &opts,
            m.wrap_measure(&spec.font, scale, text, &measure),
        )
        .into_iter()
        .map(|tv| {
            let u = if tv.truncated { "truncated" } else { used };
            let mut v = text_variant(m, spec, pad, scale, tv.lines, u, tv.truncated);
            v.penalty += 0.25 * (v.lines() as f64 - 1.0) + if tv.truncated { 1.0 } else { 0.0 };
            if v.lines() > 1 {
                v.steps.push("wrap".into());
            }
            if tv.truncated {
                v.steps.push("truncate".into());
            }
            v
        })
        .collect(),
    }
}

/// Narrowest line of a `wrap` step variant, in em of the label's font (spec §5.3).
const MIN_WRAP_LINE_EM: f64 = 1.5;

/// Variants for the `wrap` ladder step.
fn extra_wrap(
    m: &Measurer,
    spec: &TextSpec,
    text: &str,
    pad: f64,
    scale: f64,
    used: &str,
    wrap_max_lines: usize,
) -> Vec<Variant> {
    if spec.explicit.is_some() || text.contains('\n') {
        return vec![];
    }
    let width = |s: &str| m.width(&spec.font, scale, s);
    let measure = m.wrap_measure(&spec.font, scale, text, &width);
    let normal_max = match &spec.wrap {
        Some(w) => {
            // lines beyond the normal variants, up to max_lines
            let opts = to_wrap_opts(spec, scale).unwrap();
            let normal = la_text::wrap_variants(text, &opts, measure);
            let have = normal.iter().map(|v| v.lines.len()).max().unwrap_or(1);
            let mut out = Vec::new();
            for n in (have + 1)..=w.max_lines {
                let lines = la_text::balanced_wrap(text, n, opts.max_width, measure);
                if lines.len() > have
                    && !out
                        .iter()
                        .any(|v: &Variant| v.text.as_ref().map(|t| &t.lines) == Some(&lines))
                {
                    let mut v = text_variant(m, spec, pad, scale, lines, used, false);
                    v.penalty += 0.25 * (v.lines() as f64 - 1.0);
                    v.steps.push("wrap".into());
                    out.push(v);
                }
            }
            return out;
        }
        None => wrap_max_lines,
    };
    // no line narrower than MIN_WRAP_LINE_EM: `France / 3` strands the 3 (spec §5.3)
    let min_line = MIN_WRAP_LINE_EM * spec.font.size * scale;
    la_text::extra_wrap_variants(text, normal_max, measure)
        .into_iter()
        .filter(|tv| tv.widths.iter().all(|&w| w >= min_line))
        .map(|tv| {
            let mut v = text_variant(m, spec, pad, scale, tv.lines, used, tv.truncated);
            v.penalty += 0.25 * (v.lines() as f64 - 1.0);
            v.steps.push("wrap".into());
            v
        })
        .collect()
}

/// Truncated single-line variants for the `truncate` ladder step.
fn truncated(m: &Measurer, spec: &TextSpec, text: &str, pad: f64, scale: f64) -> Vec<Variant> {
    if spec.explicit.is_some() || text.contains('\n') {
        return vec![];
    }
    let measure = |s: &str| m.width(&spec.font, scale, s);
    let full = measure(text);
    let target = spec
        .wrap
        .as_ref()
        .and_then(|w| w.max_width)
        .map(|x| x * scale)
        .unwrap_or(full * 0.6);
    if target >= full {
        return vec![];
    }
    let wrap_measure = m.wrap_measure(&spec.font, scale, text, &measure);
    let mut out = Vec::new();
    for lines in [
        vec![la_text::truncate_end(text, target, wrap_measure)],
        la_text::truncate_middle(text, target, 1, wrap_measure),
    ] {
        if !out
            .iter()
            .any(|v: &Variant| v.text.as_ref().map(|t| &t.lines) == Some(&lines))
        {
            let mut v = text_variant(m, spec, pad, scale, lines, "truncated", true);
            v.penalty += 1.0;
            v.steps.push("truncate".into());
            out.push(v);
        }
    }
    out
}

fn fixed_variant(
    kind: FixedKind,
    w: f64,
    h: f64,
    shape: &LabelShape,
    pad: f64,
    scale: f64,
) -> Variant {
    let p = pad * scale;
    let shape = match shape {
        LabelShape::Polygon(pts) => LabelShape::Polygon(
            pts.iter()
                .map(|q| *q * scale + crate::geom::P::new(p, p))
                .collect(),
        ),
        LabelShape::Rounded(r) => LabelShape::Rounded(r * scale),
        s => s.clone(),
    };
    Variant {
        w: w * scale + 2.0 * p,
        h: h * scale + 2.0 * p,
        level: 0,
        penalty: 0.0,
        text: None,
        parts: vec![PartLayout {
            kind: if kind == FixedKind::Icon {
                PartKind::Icon
            } else {
                PartKind::Box
            },
            rect: Rect::new(p, p, p + w * scale, p + h * scale),
            text: None,
        }],
        // The collision shape is relative to the padded box: a circle icon becomes the
        // circle inscribed in the box, a rounded box keeps its radius grown by the padding.
        shape: match shape {
            LabelShape::Rounded(r) => LabelShape::Rounded(r + p),
            s => s,
        },
        steps: vec![],
        scale,
    }
}

fn composite_variant(
    m: &Measurer,
    row: bool,
    gap: f64,
    align: &str,
    parts: &[PartSpec],
    pad: f64,
    scale: f64,
) -> Variant {
    // measure parts
    let mut sizes = Vec::with_capacity(parts.len());
    for part in parts {
        match part {
            PartSpec::Text(t) => {
                let (asc, desc, _) = m.vmetrics(&t.font, scale);
                let w = m.width(&t.font, scale, &t.text);
                sizes.push((w, asc + desc, Some((t, asc))));
            }
            PartSpec::Fixed { w, h, .. } => sizes.push((w * scale, h * scale, None)),
        }
    }
    let gap = gap * scale;
    let p = pad * scale;
    let (mut main, mut cross) = (0.0, 0.0);
    for (i, (w, h, _)) in sizes.iter().enumerate() {
        let (a, b) = if row { (*w, *h) } else { (*h, *w) };
        main += a + if i > 0 { gap } else { 0.0 };
        cross = maxf(cross, b);
    }
    let mut out_parts = Vec::with_capacity(parts.len());
    let mut cursor = 0.0;
    for (i, ((w, h, t), spec)) in sizes.iter().zip(parts).enumerate() {
        if i > 0 {
            cursor += gap;
        }
        let (a, b) = if row { (*w, *h) } else { (*h, *w) };
        let off = match align {
            "start" => 0.0,
            "end" => cross - b,
            _ => (cross - b) * 0.5,
        };
        let (x, y) = if row {
            (p + cursor, p + off)
        } else {
            (p + off, p + cursor)
        };
        let rect = Rect::new(x, y, x + w, y + h);
        let text = t.map(|(ts, asc)| TextLayout {
            lines: vec![ts.text.clone()],
            widths: vec![*w],
            baselines: vec![y + asc],
            x_offset: x,
            font_size: ts.font.size * scale,
            scale,
            used: "original".into(),
            truncated: false,
        });
        let kind = match spec {
            PartSpec::Text(_) => PartKind::Text,
            PartSpec::Fixed {
                kind: FixedKind::Icon,
                ..
            } => PartKind::Icon,
            PartSpec::Fixed { .. } => PartKind::Box,
        };
        out_parts.push(PartLayout { kind, rect, text });
        cursor += a;
    }
    let (w, h) = if row { (main, cross) } else { (cross, main) };
    Variant {
        w: w + 2.0 * p,
        h: h + 2.0 * p,
        level: 0,
        penalty: 0.0,
        text: None,
        parts: out_parts,
        shape: LabelShape::Rect,
        steps: vec![],
        scale,
    }
}

/// Normal (level-0) variants of an item.
pub fn base_variants(m: &Measurer, item: &Item) -> Vec<Variant> {
    variants_at_scale(m, item, 1.0, false)
}

fn variants_at_scale(
    m: &Measurer,
    item: &Item,
    scale: f64,
    with_alternatives: bool,
) -> Vec<Variant> {
    let pad = item.len.padding;
    match &item.label {
        LabelSpec::Text(spec) => {
            let mut v = text_variants(m, spec, &spec.text, pad, scale, "original");
            if with_alternatives {
                for (k, alt) in spec.alternatives.iter().enumerate() {
                    for mut a in
                        text_variants(m, spec, alt, pad, scale, &format!("alternative:{k}"))
                    {
                        a.penalty += 0.5 * (k as f64 + 1.0);
                        a.steps.insert(0, "alternatives".into());
                        v.push(a);
                    }
                }
            }
            v
        }
        LabelSpec::Fixed { kind, w, h, shape } => {
            vec![fixed_variant(*kind, *w, *h, shape, pad, scale)]
        }
        LabelSpec::Composite {
            row,
            gap,
            align,
            parts,
        } => vec![composite_variant(
            m,
            *row,
            gap.px(item.em()),
            align,
            parts,
            pad,
            scale,
        )],
    }
}

/// Variants added by one ladder step, given the variants that exist so far.
pub fn ladder_variants(
    m: &Measurer,
    item: &Item,
    step: &crate::model::opts::Step,
    existing: &[Variant],
    min_scale: f64,
    wrap_max_lines: usize,
) -> Vec<Variant> {
    use crate::model::opts::Step;
    let pad = item.len.padding;
    let dedup = |out: Vec<Variant>| -> Vec<Variant> {
        let mut res: Vec<Variant> = Vec::new();
        for v in out {
            let dup = existing
                .iter()
                .chain(res.iter())
                .any(|e| e.text.is_some() && e.text == v.text && e.w == v.w && e.h == v.h);
            if !dup {
                res.push(v);
            }
        }
        res
    };
    match (step, &item.label) {
        (Step::Alternatives, LabelSpec::Text(spec)) => {
            let mut out = Vec::new();
            for (k, alt) in spec.alternatives.iter().enumerate() {
                for mut a in text_variants(m, spec, alt, pad, 1.0, &format!("alternative:{k}")) {
                    a.penalty += 0.5 * (k as f64 + 1.0);
                    a.steps.insert(0, "alternatives".into());
                    out.push(a);
                }
            }
            dedup(out)
        }
        (Step::Wrap, LabelSpec::Text(spec)) => {
            let mut out = extra_wrap(m, spec, &spec.text, pad, 1.0, "original", wrap_max_lines);
            for (k, alt) in spec.alternatives.iter().enumerate() {
                if existing.iter().any(|e| {
                    e.text
                        .as_ref()
                        .map(|t| t.used == format!("alternative:{k}"))
                        .unwrap_or(false)
                }) {
                    for mut a in extra_wrap(
                        m,
                        spec,
                        alt,
                        pad,
                        1.0,
                        &format!("alternative:{k}"),
                        wrap_max_lines,
                    ) {
                        a.penalty += 0.5 * (k as f64 + 1.0);
                        a.steps.insert(0, "alternatives".into());
                        out.push(a);
                    }
                }
            }
            dedup(out)
        }
        (Step::Truncate, LabelSpec::Text(spec)) => dedup(truncated(m, spec, &spec.text, pad, 1.0)),
        (Step::Shrink(f), _) => {
            // never below min_scale of the size before a smaller font class (spec §9.4)
            let min_scale = min_scale / item.class_scale.min(1.0);
            let mut out = Vec::new();
            let mut s = *f;
            let mut k = 0;
            while s >= min_scale - 1e-12 && s < 1.0 && k < 8 {
                for e in existing.iter().filter(|e| e.scale == 1.0) {
                    if let Some(mut v) = rescale(m, item, e, s) {
                        v.penalty = e.penalty + 2.0 * (1.0 - s);
                        v.steps = e.steps.clone();
                        v.steps.push(format!("shrink:{}", trim_float(s)));
                        out.push(v);
                    }
                }
                s *= f;
                k += 1;
            }
            dedup(out)
        }
        _ => vec![],
    }
}

fn trim_float(x: f64) -> String {
    let s = format!("{:.4}", x);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// The same variant at another font scale.
fn rescale(m: &Measurer, item: &Item, v: &Variant, s: f64) -> Option<Variant> {
    let pad = item.len.padding;
    match &item.label {
        LabelSpec::Text(spec) => {
            let t = v.text.as_ref()?;
            if spec.explicit.is_some() {
                return text_variants(m, spec, &spec.text, pad, s, &t.used)
                    .into_iter()
                    .next();
            }
            Some(text_variant(
                m,
                spec,
                pad,
                s,
                t.lines.clone(),
                &t.used,
                t.truncated,
            ))
        }
        LabelSpec::Fixed { kind, w, h, shape } => Some(fixed_variant(*kind, *w, *h, shape, pad, s)),
        LabelSpec::Composite {
            row,
            gap,
            align,
            parts,
        } => Some(composite_variant(
            m,
            *row,
            gap.px(item.em()),
            align,
            parts,
            pad,
            s,
        )),
    }
}

/// Label area in em² of the first variant (priority term `label_size`).
pub fn label_size_em2(item: &Item, variants: &[Variant]) -> f64 {
    let em = item.em();
    variants
        .first()
        .map(|v| v.w * v.h / (em * em))
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::{BasicEnv, Env};

    /// An environment that declares a host measurement callback.
    struct HostMeasure;

    impl Env for HostMeasure {}

    #[test]
    fn wrap_measure_uses_the_font_for_simple_shaping_without_host_measurement() {
        let font = FontSel {
            family: "default".into(),
            weight: 400,
            italic: false,
            size: 12.0,
            line_height: 1.2,
            file: None,
        };
        let width = |_: &str| 0.0;
        let prepared = |env: &dyn Env, shaping: &str, text: &str| {
            let m = Measurer {
                fonts: bundled_fonts(),
                env,
                shaping,
            };
            match m.wrap_measure(&font, 1.5, text, &width) {
                la_text::Measure::Font { size, .. } => {
                    assert_eq!(size, 18.0);
                    true
                }
                la_text::Measure::Callback(_) => false,
            }
        };
        let hebrew = "\u{5e9}\u{5dc}\u{5d5}\u{5dd}";
        assert!(prepared(&BasicEnv, "auto", "org.example.Foo"));
        assert!(prepared(&BasicEnv, "simple", "org.example.Foo"));
        assert!(prepared(&BasicEnv, "simple", hebrew));
        assert!(!prepared(&BasicEnv, "auto", hebrew));
        assert!(!prepared(&BasicEnv, "full", "org.example.Foo"));
        assert!(!prepared(&HostMeasure, "simple", "org.example.Foo"));
    }
}
