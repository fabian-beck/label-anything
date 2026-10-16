//! Style properties, the cascade and computed values. Mirrors `style.ts`.
//!
//! Cascade (lowest to highest): presentation attributes < `<style>` rules (by specificity,
//! then source order) < inline `style` < `!important` rules < inline `!important`.
//! Invalid values are dropped at cascade time (the next lower declaration applies).

use std::rc::Rc;

use crate::color::{parse_alpha, parse_paint, PaintSpec};
use crate::css::Decl;
use crate::num::{parse_length, parse_number, Length, Unit, CM, IN, MM, PC, PT};

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Spec<T> {
    Inherit,
    Initial,
    Val(T),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum FontSize {
    /// Absolute size in user units.
    Abs(f64),
    /// Factor of the parent's font size (`em`, `%`).
    Rel(f64),
    Larger,
    Smaller,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum FontWeight {
    Abs(u16),
    Bolder,
    Lighter,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Anchor {
    Start,
    Middle,
    End,
}

/// `dominant-baseline`, bucketed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Baseline {
    /// `auto`, `alphabetic` (y is the alphabetic baseline).
    Alphabetic,
    /// `middle`, `central`, `mathematical` (y is the vertical centre of the box).
    Middle,
    /// `hanging`, `text-top`, `text-before-edge` (y is the top of the box).
    Hanging,
    /// `ideographic`, `text-bottom`, `text-after-edge` (y is the bottom of the box).
    Bottom,
}

/// Specified values of one element (after the cascade, before inheritance).
#[derive(Clone, Debug, Default)]
pub(crate) struct Specified {
    /// Paint alpha (`None` = no paint), `url(#…)` references already resolved.
    pub fill: Option<Spec<Option<f64>>>,
    pub fill_opacity: Option<Spec<f64>>,
    pub even_odd: Option<Spec<bool>>,
    pub stroke: Option<Spec<Option<f64>>>,
    pub stroke_opacity: Option<Spec<f64>>,
    pub stroke_width: Option<Spec<Length>>,
    pub opacity: Option<Spec<f64>>,
    pub display_none: Option<Spec<bool>>,
    pub visible: Option<Spec<bool>>,
    pub font_size: Option<Spec<FontSize>>,
    pub font_family: Option<Spec<Rc<str>>>,
    pub font_weight: Option<Spec<FontWeight>>,
    pub anchor: Option<Spec<Anchor>>,
    pub baseline: Option<Spec<Baseline>>,
    pub non_scaling: Option<Spec<bool>>,
}

/// Computed values.
#[derive(Clone, Debug)]
pub(crate) struct Computed {
    pub fill: Option<f64>,
    pub fill_opacity: f64,
    pub even_odd: bool,
    pub stroke: Option<f64>,
    pub stroke_opacity: f64,
    pub stroke_width: Length,
    pub opacity: f64,
    pub display_none: bool,
    pub visible: bool,
    pub font_size: f64,
    pub font_family: Rc<str>,
    pub font_weight: u16,
    pub anchor: Anchor,
    pub baseline: Baseline,
    pub non_scaling: bool,
    pub preserve_space: bool,
}

pub(crate) const DEFAULT_FONT_SIZE: f64 = 16.0;
pub(crate) const DEFAULT_FONT_FAMILY: &str = "sans-serif";

impl Computed {
    pub(crate) fn initial() -> Computed {
        Computed {
            fill: Some(1.0),
            fill_opacity: 1.0,
            even_odd: false,
            stroke: None,
            stroke_opacity: 1.0,
            stroke_width: Length::px(1.0),
            opacity: 1.0,
            display_none: false,
            visible: true,
            font_size: DEFAULT_FONT_SIZE,
            font_family: Rc::from(DEFAULT_FONT_FAMILY),
            font_weight: 400,
            anchor: Anchor::Start,
            baseline: Baseline::Alphabetic,
            non_scaling: false,
            preserve_space: false,
        }
    }

    /// Fill paint ≠ none with alpha × fill-opacity > 0.
    pub(crate) fn filled(&self) -> bool {
        self.fill.is_some_and(|a| a * self.fill_opacity > 0.0)
    }

    /// Stroke paint ≠ none with alpha × stroke-opacity > 0 and stroke-width > 0.
    pub(crate) fn stroked(&self) -> bool {
        self.stroke.is_some_and(|a| a * self.stroke_opacity > 0.0) && self.stroke_width.v > 0.0
    }
}

fn bolder(w: u16) -> u16 {
    if w < 350 {
        400
    } else if w < 550 {
        700
    } else if w < 900 {
        900
    } else {
        w
    }
}

fn lighter(w: u16) -> u16 {
    if w < 100 {
        w
    } else if w < 550 {
        100
    } else if w < 750 {
        400
    } else {
        700
    }
}

#[inline]
fn inh<T: Clone>(s: &Option<Spec<T>>, parent: &T, initial: T) -> T {
    match s {
        None | Some(Spec::Inherit) => parent.clone(),
        Some(Spec::Initial) => initial,
        Some(Spec::Val(v)) => v.clone(),
    }
}

#[inline]
fn non_inh<T: Clone>(s: &Option<Spec<T>>, parent: &T, initial: T) -> T {
    match s {
        None | Some(Spec::Initial) => initial,
        Some(Spec::Inherit) => parent.clone(),
        Some(Spec::Val(v)) => v.clone(),
    }
}

/// Computes the style of an element from its specified values and its parent's style
/// (`xml_space`: the element's own `xml:space`, if any).
pub(crate) fn compute(s: &Specified, p: &Computed, xml_space: Option<bool>) -> Computed {
    let font_size = match &s.font_size {
        None | Some(Spec::Inherit) => p.font_size,
        Some(Spec::Initial) => DEFAULT_FONT_SIZE,
        Some(Spec::Val(FontSize::Abs(v))) => *v,
        Some(Spec::Val(FontSize::Rel(f))) => f * p.font_size,
        Some(Spec::Val(FontSize::Larger)) => p.font_size * 1.2,
        Some(Spec::Val(FontSize::Smaller)) => p.font_size / 1.2,
    };
    let font_weight = match &s.font_weight {
        None | Some(Spec::Inherit) => p.font_weight,
        Some(Spec::Initial) => 400,
        Some(Spec::Val(FontWeight::Abs(w))) => *w,
        Some(Spec::Val(FontWeight::Bolder)) => bolder(p.font_weight),
        Some(Spec::Val(FontWeight::Lighter)) => lighter(p.font_weight),
    };
    Computed {
        fill: inh(&s.fill, &p.fill, Some(1.0)),
        fill_opacity: inh(&s.fill_opacity, &p.fill_opacity, 1.0),
        even_odd: inh(&s.even_odd, &p.even_odd, false),
        stroke: inh(&s.stroke, &p.stroke, None),
        stroke_opacity: inh(&s.stroke_opacity, &p.stroke_opacity, 1.0),
        stroke_width: inh(&s.stroke_width, &p.stroke_width, Length::px(1.0)),
        opacity: non_inh(&s.opacity, &p.opacity, 1.0),
        display_none: non_inh(&s.display_none, &p.display_none, false),
        visible: inh(&s.visible, &p.visible, true),
        font_size,
        font_family: inh(
            &s.font_family,
            &p.font_family,
            Rc::from(DEFAULT_FONT_FAMILY),
        ),
        font_weight,
        anchor: inh(&s.anchor, &p.anchor, Anchor::Start),
        baseline: inh(&s.baseline, &p.baseline, Baseline::Alphabetic),
        non_scaling: non_inh(&s.non_scaling, &p.non_scaling, false),
        preserve_space: xml_space.unwrap_or(p.preserve_space),
    }
}

/// Is `name` an SVG presentation attribute we use?
pub(crate) fn is_presentation_attribute(name: &str) -> bool {
    matches!(
        name,
        "fill"
            | "fill-opacity"
            | "fill-rule"
            | "stroke"
            | "stroke-opacity"
            | "stroke-width"
            | "opacity"
            | "display"
            | "visibility"
            | "font-size"
            | "font-family"
            | "font-weight"
            | "text-anchor"
            | "dominant-baseline"
            | "vector-effect"
    )
}

fn parse_font_size(v: &str) -> Option<FontSize> {
    let lower = v.to_ascii_lowercase();
    let kw = match lower.as_str() {
        "xx-small" => Some(9.0),
        "x-small" => Some(10.0),
        "small" => Some(13.0),
        "medium" => Some(16.0),
        "large" => Some(18.0),
        "x-large" => Some(24.0),
        "xx-large" => Some(32.0),
        "xxx-large" => Some(48.0),
        "larger" => return Some(FontSize::Larger),
        "smaller" => return Some(FontSize::Smaller),
        _ => None,
    };
    if let Some(px) = kw {
        return Some(FontSize::Abs(px));
    }
    let l = parse_length(v)?;
    if l.v < 0.0 {
        return None;
    }
    Some(match l.unit {
        Unit::None | Unit::Px => FontSize::Abs(l.v),
        Unit::Pt => FontSize::Abs(l.v * PT),
        Unit::Pc => FontSize::Abs(l.v * PC),
        Unit::In => FontSize::Abs(l.v * IN),
        Unit::Cm => FontSize::Abs(l.v * CM),
        Unit::Mm => FontSize::Abs(l.v * MM),
        Unit::Rem => FontSize::Abs(l.v * 16.0),
        Unit::Em => FontSize::Rel(l.v),
        Unit::Ex => FontSize::Rel(l.v / 2.0),
        Unit::Percent => FontSize::Rel(l.v / 100.0),
    })
}

fn parse_font_weight(v: &str) -> Option<FontWeight> {
    match v.to_ascii_lowercase().as_str() {
        "normal" => Some(FontWeight::Abs(400)),
        "bold" => Some(FontWeight::Abs(700)),
        "bolder" => Some(FontWeight::Bolder),
        "lighter" => Some(FontWeight::Lighter),
        _ => {
            let n = parse_number(v)?;
            if (1.0..=1000.0).contains(&n) {
                Some(FontWeight::Abs((n + 0.5).floor() as u16))
            } else {
                None
            }
        }
    }
}

fn is_keyword(v: &str) -> bool {
    !v.is_empty() && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// The CSS `font` shorthand: `[style|variant|weight|stretch]* size[/line-height] family`.
fn parse_font(v: &str) -> Option<(FontSize, Rc<str>, FontWeight)> {
    let mut weight = FontWeight::Abs(400);
    let mut rest = v.trim_matches(|c: char| c.is_ascii_whitespace());
    loop {
        let end = rest
            .find(|c: char| c.is_ascii_whitespace())
            .unwrap_or(rest.len());
        let tok = &rest[..end];
        let lower = tok.to_ascii_lowercase();
        let consumed = match lower.as_str() {
            "normal" | "italic" | "oblique" | "small-caps" | "ultra-condensed"
            | "extra-condensed" | "condensed" | "semi-condensed" | "semi-expanded" | "expanded"
            | "extra-expanded" | "ultra-expanded" => true,
            "bold" | "bolder" | "lighter" => {
                weight = parse_font_weight(&lower)?;
                true
            }
            "caption" | "icon" | "menu" | "message-box" | "small-caption" | "status-bar" => {
                return None
            }
            _ => match parse_number(tok) {
                Some(n) if (1.0..=1000.0).contains(&n) && !tok.contains('%') => {
                    weight = FontWeight::Abs((n + 0.5).floor() as u16);
                    true
                }
                _ => false,
            },
        };
        if !consumed {
            break;
        }
        rest = rest[end..].trim_start_matches(|c: char| c.is_ascii_whitespace());
        if rest.is_empty() {
            return None;
        }
    }
    let end = rest
        .find(|c: char| c.is_ascii_whitespace())
        .unwrap_or(rest.len());
    let tok = &rest[..end];
    let size_tok = tok.split('/').next().unwrap_or("");
    let size = parse_font_size(size_tok)?;
    let mut after = rest[end..].trim_start_matches(|c: char| c.is_ascii_whitespace());
    if !tok.contains('/') && after.starts_with('/') {
        // `12px / 1.2 family`
        after = after[1..].trim_start_matches(|c: char| c.is_ascii_whitespace());
        let e = after
            .find(|c: char| c.is_ascii_whitespace())
            .unwrap_or(after.len());
        after = after[e..].trim_start_matches(|c: char| c.is_ascii_whitespace());
    }
    let family = after.trim_end_matches(|c: char| c.is_ascii_whitespace());
    if family.is_empty() {
        return None;
    }
    Some((size, Rc::from(family), weight))
}

/// Sets `slot` to the parsed value (CSS-wide keywords handled), if valid.
fn set<T>(
    slot: &mut Option<Spec<T>>,
    v: &str,
    inherited: bool,
    parse: impl FnOnce(&str) -> Option<T>,
) {
    match v.to_ascii_lowercase().as_str() {
        "inherit" => *slot = Some(Spec::Inherit),
        "initial" => *slot = Some(Spec::Initial),
        "unset" => {
            *slot = Some(if inherited {
                Spec::Inherit
            } else {
                Spec::Initial
            })
        }
        _ => {
            if let Some(x) = parse(v) {
                *slot = Some(Spec::Val(x));
            }
        }
    }
}

/// Applies one declaration (`allow_shorthand`: CSS only, not presentation attributes).
pub(crate) fn apply(
    s: &mut Specified,
    name: &str,
    value: &str,
    allow_shorthand: bool,
    url_exists: &dyn Fn(&str) -> bool,
) {
    let v = value.trim_matches(|c: char| c.is_ascii_whitespace());
    if v.is_empty() {
        return;
    }
    let paint =
        |x: &str| -> Option<Option<f64>> { parse_paint(x).map(|p| resolve_paint(&p, url_exists)) };
    match name {
        "fill" => set(&mut s.fill, v, true, paint),
        "stroke" => set(&mut s.stroke, v, true, paint),
        "fill-opacity" => set(&mut s.fill_opacity, v, true, parse_alpha),
        "stroke-opacity" => set(&mut s.stroke_opacity, v, true, parse_alpha),
        "opacity" => set(&mut s.opacity, v, false, parse_alpha),
        "fill-rule" => set(&mut s.even_odd, v, true, |x| {
            match x.to_ascii_lowercase().as_str() {
                "nonzero" => Some(false),
                "evenodd" => Some(true),
                _ => None,
            }
        }),
        "stroke-width" => set(&mut s.stroke_width, v, true, |x| {
            parse_length(x).filter(|l| l.v >= 0.0)
        }),
        "display" => set(&mut s.display_none, v, false, |x| {
            let l = x.to_ascii_lowercase();
            if l == "none" {
                Some(true)
            } else if is_keyword(&l) {
                Some(false)
            } else {
                None
            }
        }),
        "visibility" => set(&mut s.visible, v, true, |x| {
            match x.to_ascii_lowercase().as_str() {
                "visible" => Some(true),
                "hidden" | "collapse" => Some(false),
                _ => None,
            }
        }),
        "font-size" => set(&mut s.font_size, v, true, parse_font_size),
        "font-family" => set(&mut s.font_family, v, true, |x| Some(Rc::from(x))),
        "font-weight" => set(&mut s.font_weight, v, true, parse_font_weight),
        "text-anchor" => set(&mut s.anchor, v, true, |x| {
            match x.to_ascii_lowercase().as_str() {
                "start" => Some(Anchor::Start),
                "middle" => Some(Anchor::Middle),
                "end" => Some(Anchor::End),
                _ => None,
            }
        }),
        "dominant-baseline" => set(&mut s.baseline, v, true, |x| {
            match x.to_ascii_lowercase().as_str() {
                "auto" | "alphabetic" | "use-script" | "no-change" | "reset-size" => {
                    Some(Baseline::Alphabetic)
                }
                "middle" | "central" | "mathematical" => Some(Baseline::Middle),
                "hanging" | "text-top" | "text-before-edge" => Some(Baseline::Hanging),
                "ideographic" | "text-bottom" | "text-after-edge" => Some(Baseline::Bottom),
                _ => None,
            }
        }),
        "vector-effect" => set(&mut s.non_scaling, v, false, |x| {
            let l = x.to_ascii_lowercase();
            if l == "non-scaling-stroke" {
                Some(true)
            } else if is_keyword(&l) {
                Some(false)
            } else {
                None
            }
        }),
        "font" if allow_shorthand => match v.to_ascii_lowercase().as_str() {
            "inherit" | "unset" => {
                s.font_size = Some(Spec::Inherit);
                s.font_family = Some(Spec::Inherit);
                s.font_weight = Some(Spec::Inherit);
            }
            "initial" => {
                s.font_size = Some(Spec::Initial);
                s.font_family = Some(Spec::Initial);
                s.font_weight = Some(Spec::Initial);
            }
            _ => {
                if let Some((size, family, weight)) = parse_font(v) {
                    s.font_size = Some(Spec::Val(size));
                    s.font_family = Some(Spec::Val(family));
                    s.font_weight = Some(Spec::Val(weight));
                }
            }
        },
        _ => {}
    }
}

fn resolve_paint(p: &PaintSpec, url_exists: &dyn Fn(&str) -> bool) -> Option<f64> {
    match p {
        PaintSpec::None => None,
        PaintSpec::Color(a) => Some(*a),
        PaintSpec::Url(id, fallback) => {
            if id.as_deref().is_some_and(url_exists) {
                Some(1.0)
            } else {
                match fallback {
                    Some(f) => resolve_paint(f, url_exists),
                    None => None,
                }
            }
        }
    }
}

/// The cascade for one element.
pub(crate) fn cascade(
    presentation: &[(&str, &str)],
    css: &[&[Decl]],
    inline: &[Decl],
    url_exists: &dyn Fn(&str) -> bool,
) -> Specified {
    let mut s = Specified::default();
    for (name, value) in presentation {
        apply(&mut s, name, value, false, url_exists);
    }
    for decls in css {
        for d in decls.iter().filter(|d| !d.important) {
            apply(&mut s, &d.name, &d.value, true, url_exists);
        }
    }
    for d in inline.iter().filter(|d| !d.important) {
        apply(&mut s, &d.name, &d.value, true, url_exists);
    }
    for decls in css {
        for d in decls.iter().filter(|d| d.important) {
            apply(&mut s, &d.name, &d.value, true, url_exists);
        }
    }
    for d in inline.iter().filter(|d| d.important) {
        apply(&mut s, &d.name, &d.value, true, url_exists);
    }
    s
}

/// The first family of a `font-family` list, unquoted (`'Open Sans', arial` → `Open Sans`).
pub(crate) fn first_family(list: &str) -> &str {
    let t = list.trim_matches(|c: char| c.is_ascii_whitespace());
    let first = if let Some(q) = t.chars().next().filter(|&c| c == '"' || c == '\'') {
        match t[1..].find(q) {
            Some(k) => &t[1..1 + k],
            None => &t[1..],
        }
    } else {
        t.split(',').next().unwrap_or("")
    };
    let f = first.trim_matches(|c: char| c.is_ascii_whitespace());
    if f.is_empty() {
        DEFAULT_FONT_FAMILY
    } else {
        f
    }
}
