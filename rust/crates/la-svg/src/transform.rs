//! `transform` lists, `viewBox` and `preserveAspectRatio`. Mirrors `transform.ts`.

use crate::geom::Affine;
use crate::num::{scan_number, skip_comma_wsp, skip_wsp};

/// Parses a transform list. An invalid list yields `None` (the attribute is ignored).
pub(crate) fn parse_transform(s: &str) -> Option<Affine> {
    let b = s.as_bytes();
    let mut m = Affine::IDENTITY;
    let mut i = skip_wsp(b, 0);
    while i < b.len() {
        let ns = i;
        while i < b.len() && b[i].is_ascii_alphabetic() {
            i += 1;
        }
        let name = &s[ns..i];
        i = skip_wsp(b, i);
        if i >= b.len() || b[i] != b'(' {
            return None;
        }
        i = skip_wsp(b, i + 1);
        let mut args = [0.0f64; 6];
        let mut n = 0;
        while i < b.len() && b[i] != b')' {
            let (v, j) = scan_number(b, i)?;
            if n == 6 {
                return None;
            }
            args[n] = v;
            n += 1;
            i = skip_comma_wsp(b, j);
        }
        if i >= b.len() {
            return None;
        }
        i += 1; // ')'
        let t = match (name, n) {
            ("matrix", 6) => Affine::new(args[0], args[1], args[2], args[3], args[4], args[5]),
            ("translate", 1) => Affine::translate(args[0], 0.0),
            ("translate", 2) => Affine::translate(args[0], args[1]),
            ("scale", 1) => Affine::scale(args[0], args[0]),
            ("scale", 2) => Affine::scale(args[0], args[1]),
            ("rotate", 1) => Affine::rotate(args[0]),
            ("rotate", 3) => Affine::translate(args[1], args[2])
                .mul(&Affine::rotate(args[0]))
                .mul(&Affine::translate(-args[1], -args[2])),
            ("skewX", 1) => Affine::skew_x(args[0]),
            ("skewY", 1) => Affine::skew_y(args[0]),
            _ => return None,
        };
        m = m.mul(&t);
        i = skip_comma_wsp(b, i);
    }
    Some(m)
}

/// `viewBox="min-x min-y width height"`; `None` if invalid or width/height ≤ 0.
pub(crate) fn parse_view_box(s: &str) -> Option<[f64; 4]> {
    let b = s.as_bytes();
    let mut v = [0.0f64; 4];
    let mut i = skip_wsp(b, 0);
    for (k, slot) in v.iter_mut().enumerate() {
        let (x, j) = scan_number(b, i)?;
        *slot = x;
        i = if k < 3 {
            skip_comma_wsp(b, j)
        } else {
            skip_wsp(b, j)
        };
    }
    if i != b.len() || v[2] <= 0.0 || v[3] <= 0.0 {
        return None;
    }
    Some(v)
}

/// `preserveAspectRatio`: alignment (`None` = `none`) as fractions (0, 0.5, 1) and `slice`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct AspectRatio {
    pub align: Option<(f64, f64)>,
    pub slice: bool,
}

impl AspectRatio {
    pub(crate) const DEFAULT: AspectRatio = AspectRatio {
        align: Some((0.5, 0.5)),
        slice: false,
    };
}

pub(crate) fn parse_aspect_ratio(s: &str) -> AspectRatio {
    let mut it = s.split_ascii_whitespace();
    let mut tok = it.next();
    if tok == Some("defer") {
        tok = it.next();
    }
    let align = match tok {
        Some("none") => None,
        Some(t) if t.len() == 8 && t.is_ascii() => {
            let fx = match &t[0..4] {
                "xMin" => 0.0,
                "xMid" => 0.5,
                "xMax" => 1.0,
                _ => return AspectRatio::DEFAULT,
            };
            let fy = match &t[4..8] {
                "YMin" => 0.0,
                "YMid" => 0.5,
                "YMax" => 1.0,
                _ => return AspectRatio::DEFAULT,
            };
            Some((fx, fy))
        }
        _ => return AspectRatio::DEFAULT,
    };
    let slice = match it.next() {
        None | Some("meet") => false,
        Some("slice") => true,
        Some(_) => return AspectRatio::DEFAULT,
    };
    if it.next().is_some() {
        return AspectRatio::DEFAULT;
    }
    AspectRatio { align, slice }
}

/// The transform mapping `view_box` into the viewport `(0, 0, w, h)`.
pub(crate) fn view_box_transform(
    view_box: Option<[f64; 4]>,
    par: AspectRatio,
    w: f64,
    h: f64,
) -> Affine {
    let Some([vx, vy, vw, vh]) = view_box else {
        return Affine::IDENTITY;
    };
    let mut sx = w / vw;
    let mut sy = h / vh;
    let (fx, fy) = match par.align {
        None => (0.0, 0.0),
        Some(f) => {
            let s = if par.slice { sx.max(sy) } else { sx.min(sy) };
            sx = s;
            sy = s;
            f
        }
    };
    let tx = -vx * sx + (w - vw * sx) * fx;
    let ty = -vy * sy + (h - vh * sy) * fy;
    Affine::new(sx, 0.0, 0.0, sy, tx, ty)
}
