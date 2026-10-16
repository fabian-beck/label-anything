//! Paint values: we only need to know whether something is painted and with which alpha.
//! Mirrors `color.ts`.

/// A parsed paint before `url(#…)` references are resolved.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum PaintSpec {
    None,
    /// A colour (incl. `currentColor`, `context-fill`, `context-stroke`) with its alpha.
    Color(f64),
    /// `url(#id) [fallback]`; `id` is `None` for references outside the document.
    Url(Option<String>, Option<Box<PaintSpec>>),
}

/// CSS named colours (CSS Color 4), lowercase, sorted.
pub(crate) const NAMED: [&str; 148] = [
    "aliceblue",
    "antiquewhite",
    "aqua",
    "aquamarine",
    "azure",
    "beige",
    "bisque",
    "black",
    "blanchedalmond",
    "blue",
    "blueviolet",
    "brown",
    "burlywood",
    "cadetblue",
    "chartreuse",
    "chocolate",
    "coral",
    "cornflowerblue",
    "cornsilk",
    "crimson",
    "cyan",
    "darkblue",
    "darkcyan",
    "darkgoldenrod",
    "darkgray",
    "darkgreen",
    "darkgrey",
    "darkkhaki",
    "darkmagenta",
    "darkolivegreen",
    "darkorange",
    "darkorchid",
    "darkred",
    "darksalmon",
    "darkseagreen",
    "darkslateblue",
    "darkslategray",
    "darkslategrey",
    "darkturquoise",
    "darkviolet",
    "deeppink",
    "deepskyblue",
    "dimgray",
    "dimgrey",
    "dodgerblue",
    "firebrick",
    "floralwhite",
    "forestgreen",
    "fuchsia",
    "gainsboro",
    "ghostwhite",
    "gold",
    "goldenrod",
    "gray",
    "green",
    "greenyellow",
    "grey",
    "honeydew",
    "hotpink",
    "indianred",
    "indigo",
    "ivory",
    "khaki",
    "lavender",
    "lavenderblush",
    "lawngreen",
    "lemonchiffon",
    "lightblue",
    "lightcoral",
    "lightcyan",
    "lightgoldenrodyellow",
    "lightgray",
    "lightgreen",
    "lightgrey",
    "lightpink",
    "lightsalmon",
    "lightseagreen",
    "lightskyblue",
    "lightslategray",
    "lightslategrey",
    "lightsteelblue",
    "lightyellow",
    "lime",
    "limegreen",
    "linen",
    "magenta",
    "maroon",
    "mediumaquamarine",
    "mediumblue",
    "mediumorchid",
    "mediumpurple",
    "mediumseagreen",
    "mediumslateblue",
    "mediumspringgreen",
    "mediumturquoise",
    "mediumvioletred",
    "midnightblue",
    "mintcream",
    "mistyrose",
    "moccasin",
    "navajowhite",
    "navy",
    "oldlace",
    "olive",
    "olivedrab",
    "orange",
    "orangered",
    "orchid",
    "palegoldenrod",
    "palegreen",
    "paleturquoise",
    "palevioletred",
    "papayawhip",
    "peachpuff",
    "peru",
    "pink",
    "plum",
    "powderblue",
    "purple",
    "rebeccapurple",
    "red",
    "rosybrown",
    "royalblue",
    "saddlebrown",
    "salmon",
    "sandybrown",
    "seagreen",
    "seashell",
    "sienna",
    "silver",
    "skyblue",
    "slateblue",
    "slategray",
    "slategrey",
    "snow",
    "springgreen",
    "steelblue",
    "tan",
    "teal",
    "thistle",
    "tomato",
    "turquoise",
    "violet",
    "wheat",
    "white",
    "whitesmoke",
    "yellow",
    "yellowgreen",
];

fn hex_val(b: u8) -> Option<u32> {
    match b {
        b'0'..=b'9' => Some((b - b'0') as u32),
        b'a'..=b'f' => Some((b - b'a' + 10) as u32),
        b'A'..=b'F' => Some((b - b'A' + 10) as u32),
        _ => None,
    }
}

/// Alpha of a number or percentage, clamped to [0, 1].
pub(crate) fn parse_alpha(s: &str) -> Option<f64> {
    let t = s.trim_matches(|c: char| c.is_ascii_whitespace());
    let (num, pct) = match t.strip_suffix('%') {
        Some(n) => (n, true),
        None => (t, false),
    };
    let v = crate::num::parse_number(num)?;
    let v = if pct { v / 100.0 } else { v };
    Some(v.clamp(0.0, 1.0))
}

/// The alpha of a CSS colour, `None` if it is not a colour.
pub(crate) fn parse_color_alpha(s: &str) -> Option<f64> {
    let t = s.trim_matches(|c: char| c.is_ascii_whitespace());
    let lower = t.to_ascii_lowercase();
    if lower == "transparent" {
        return Some(0.0);
    }
    if lower == "currentcolor" || lower == "context-fill" || lower == "context-stroke" {
        return Some(1.0);
    }
    if let Some(hex) = t.strip_prefix('#') {
        let b = hex.as_bytes();
        let mut digits = Vec::with_capacity(8);
        for &x in b {
            digits.push(hex_val(x)?);
        }
        return match digits.len() {
            3 | 6 => Some(1.0),
            4 => Some(digits[3] as f64 / 15.0),
            8 => Some((digits[6] * 16 + digits[7]) as f64 / 255.0),
            _ => None,
        };
    }
    if let Some(open) = lower.find('(') {
        let name = &lower[..open];
        if !lower.ends_with(')') {
            return None;
        }
        if !matches!(
            name,
            "rgb" | "rgba" | "hsl" | "hsla" | "hwb" | "lab" | "lch" | "oklab" | "oklch" | "color"
        ) {
            return None;
        }
        let args = &lower[open + 1..lower.len() - 1];
        if let Some(slash) = args.find('/') {
            return parse_alpha(&args[slash + 1..]);
        }
        let parts: Vec<&str> = args.split(',').collect();
        if parts.len() == 4 {
            return parse_alpha(parts[3]);
        }
        return Some(1.0);
    }
    if NAMED.binary_search(&lower.as_str()).is_ok() {
        return Some(1.0);
    }
    None
}

/// Parses a `fill`/`stroke` value.
pub(crate) fn parse_paint(s: &str) -> Option<PaintSpec> {
    let t = s.trim_matches(|c: char| c.is_ascii_whitespace());
    if t.eq_ignore_ascii_case("none") {
        return Some(PaintSpec::None);
    }
    if t.get(..4).is_some_and(|p| p.eq_ignore_ascii_case("url(")) {
        let close = t.find(')')?;
        let inner = t[4..close].trim_matches(|c: char| c.is_ascii_whitespace());
        let inner = if inner.len() >= 2
            && ((inner.starts_with('"') && inner.ends_with('"'))
                || (inner.starts_with('\'') && inner.ends_with('\'')))
        {
            &inner[1..inner.len() - 1]
        } else {
            inner
        };
        let id = inner.strip_prefix('#').map(|s| s.to_string());
        let rest = t[close + 1..].trim_matches(|c: char| c.is_ascii_whitespace());
        let fallback = if rest.is_empty() {
            None
        } else {
            match parse_paint(rest)? {
                PaintSpec::Url(..) => return None,
                p => Some(Box::new(p)),
            }
        };
        return Some(PaintSpec::Url(id, fallback));
    }
    parse_color_alpha(t).map(PaintSpec::Color)
}
