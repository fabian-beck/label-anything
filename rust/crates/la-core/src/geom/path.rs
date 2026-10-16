//! SVG path data: parsing and flattening to polylines (used by `path` marks).
//!
//! The flattening is deterministic (adaptive de Casteljau subdivision with a fixed
//! flatness test; arcs with a sagitta-based segment count) and identical to the
//! TypeScript implementation.

use super::P;
use la_expr::det_math::{atan2_deg, sin_cos_deg};

/// A flattened sub-path.
#[derive(Clone, Debug, PartialEq)]
pub struct SubPath {
    pub points: Vec<P>,
    pub closed: bool,
}

/// Error with the byte offset of the problem in the path string.
#[derive(Clone, Debug, PartialEq)]
pub struct PathError {
    pub offset: usize,
    pub message: String,
}

struct Lexer<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Lexer<'a> {
    fn skip_ws(&mut self) {
        while self.i < self.s.len()
            && (self.s[self.i].is_ascii_whitespace() || self.s[self.i] == b',')
        {
            self.i += 1;
        }
    }
    fn peek_cmd(&mut self) -> Option<u8> {
        self.skip_ws();
        self.s
            .get(self.i)
            .copied()
            .filter(|c| c.is_ascii_alphabetic() && *c != b'e' && *c != b'E')
    }
    fn at_number(&mut self) -> bool {
        self.skip_ws();
        matches!(self.s.get(self.i), Some(c) if c.is_ascii_digit() || *c == b'-' || *c == b'+' || *c == b'.')
    }
    fn number(&mut self) -> Result<f64, PathError> {
        self.skip_ws();
        let start = self.i;
        let s = self.s;
        let mut j = self.i;
        if j < s.len() && (s[j] == b'+' || s[j] == b'-') {
            j += 1;
        }
        let mut digits = 0;
        while j < s.len() && s[j].is_ascii_digit() {
            j += 1;
            digits += 1;
        }
        if j < s.len() && s[j] == b'.' {
            j += 1;
            while j < s.len() && s[j].is_ascii_digit() {
                j += 1;
                digits += 1;
            }
        }
        if digits == 0 {
            return Err(PathError {
                offset: start,
                message: "expected a number".into(),
            });
        }
        if j < s.len() && (s[j] == b'e' || s[j] == b'E') {
            let mut k = j + 1;
            if k < s.len() && (s[k] == b'+' || s[k] == b'-') {
                k += 1;
            }
            let ks = k;
            while k < s.len() && s[k].is_ascii_digit() {
                k += 1;
            }
            if k > ks {
                j = k;
            }
        }
        self.i = j;
        std::str::from_utf8(&s[start..j])
            .ok()
            .and_then(|t| t.parse::<f64>().ok())
            .filter(|v| v.is_finite())
            .ok_or(PathError {
                offset: start,
                message: "invalid number".into(),
            })
    }
    fn flag(&mut self) -> Result<bool, PathError> {
        self.skip_ws();
        match self.s.get(self.i) {
            Some(b'0') => {
                self.i += 1;
                Ok(false)
            }
            Some(b'1') => {
                self.i += 1;
                Ok(true)
            }
            _ => Err(PathError {
                offset: self.i,
                message: "expected an arc flag (0 or 1)".into(),
            }),
        }
    }
}

/// Parse and flatten SVG path data with the given tolerance (px).
pub fn flatten(d: &str, tol: f64) -> Result<Vec<SubPath>, PathError> {
    let tol = if tol > 0.0 { tol } else { 0.25 };
    let mut lx = Lexer {
        s: d.as_bytes(),
        i: 0,
    };
    let mut out: Vec<SubPath> = Vec::new();
    let mut cur: Vec<P> = Vec::new();
    let mut pos = P::new(0.0, 0.0);
    let mut start = P::new(0.0, 0.0);
    let mut last_ctrl: Option<P> = None; // reflected control for S/T
    let mut last_cmd = b' ';
    let mut cmd: Option<u8> = None;
    let finish = |cur: &mut Vec<P>, out: &mut Vec<SubPath>, closed: bool| {
        if cur.len() >= 2 || (closed && !cur.is_empty()) {
            out.push(SubPath {
                points: std::mem::take(cur),
                closed,
            });
        } else {
            cur.clear();
        }
    };
    loop {
        if let Some(c) = lx.peek_cmd() {
            lx.i += 1;
            cmd = Some(c);
        } else if lx.i >= lx.s.len() {
            break;
        } else if !lx.at_number() || cmd.is_none() {
            return Err(PathError {
                offset: lx.i,
                message: "expected a path command".into(),
            });
        }
        let c = cmd.unwrap_or(b'M');
        let rel = c.is_ascii_lowercase();
        let base = if rel { pos } else { P::new(0.0, 0.0) };
        match c.to_ascii_uppercase() {
            b'M' => {
                let x = lx.number()?;
                let y = lx.number()?;
                finish(&mut cur, &mut out, false);
                pos = P::new(base.x + x, base.y + y);
                start = pos;
                cur.push(pos);
                // subsequent pairs are implicit line-tos
                cmd = Some(if rel { b'l' } else { b'L' });
                last_ctrl = None;
            }
            b'L' => {
                let x = lx.number()?;
                let y = lx.number()?;
                pos = P::new(base.x + x, base.y + y);
                push_pt(&mut cur, pos);
                last_ctrl = None;
            }
            b'H' => {
                let x = lx.number()?;
                pos = P::new(if rel { pos.x + x } else { x }, pos.y);
                push_pt(&mut cur, pos);
                last_ctrl = None;
            }
            b'V' => {
                let y = lx.number()?;
                pos = P::new(pos.x, if rel { pos.y + y } else { y });
                push_pt(&mut cur, pos);
                last_ctrl = None;
            }
            b'C' | b'S' => {
                let is_s = c.eq_ignore_ascii_case(&b'S');
                let c1 = if is_s {
                    match (last_cmd.to_ascii_uppercase(), last_ctrl) {
                        (b'C' | b'S', Some(lc)) => pos * 2.0 - lc,
                        _ => pos,
                    }
                } else {
                    let x1 = lx.number()?;
                    let y1 = lx.number()?;
                    P::new(base.x + x1, base.y + y1)
                };
                let x2 = lx.number()?;
                let y2 = lx.number()?;
                let x = lx.number()?;
                let y = lx.number()?;
                let c2 = P::new(base.x + x2, base.y + y2);
                let end = P::new(base.x + x, base.y + y);
                if cur.is_empty() {
                    cur.push(pos);
                }
                cubic(&mut cur, pos, c1, c2, end, tol, 0);
                last_ctrl = Some(c2);
                pos = end;
            }
            b'Q' | b'T' => {
                let is_t = c.eq_ignore_ascii_case(&b'T');
                let q = if is_t {
                    match (last_cmd.to_ascii_uppercase(), last_ctrl) {
                        (b'Q' | b'T', Some(lc)) => pos * 2.0 - lc,
                        _ => pos,
                    }
                } else {
                    let x1 = lx.number()?;
                    let y1 = lx.number()?;
                    P::new(base.x + x1, base.y + y1)
                };
                let x = lx.number()?;
                let y = lx.number()?;
                let end = P::new(base.x + x, base.y + y);
                if cur.is_empty() {
                    cur.push(pos);
                }
                // elevate to cubic
                let c1 = pos + (q - pos) * (2.0 / 3.0);
                let c2 = end + (q - end) * (2.0 / 3.0);
                cubic(&mut cur, pos, c1, c2, end, tol, 0);
                last_ctrl = Some(q);
                pos = end;
            }
            b'A' => {
                let rx = lx.number()?.abs();
                let ry = lx.number()?.abs();
                let rot = lx.number()?;
                let large = lx.flag()?;
                let sweep = lx.flag()?;
                let x = lx.number()?;
                let y = lx.number()?;
                let end = P::new(base.x + x, base.y + y);
                if cur.is_empty() {
                    cur.push(pos);
                }
                arc(&mut cur, pos, rx, ry, rot, large, sweep, end, tol);
                pos = end;
                last_ctrl = None;
            }
            b'Z' => {
                pos = start;
                finish(&mut cur, &mut out, true);
                last_ctrl = None;
                last_cmd = b'Z';
                cmd = None;
                continue;
            }
            _ => {
                return Err(PathError {
                    offset: lx.i.saturating_sub(1),
                    message: format!("unknown path command '{}'", c as char),
                })
            }
        }
        last_cmd = c;
    }
    finish(&mut cur, &mut out, false);
    Ok(out)
}

fn push_pt(cur: &mut Vec<P>, p: P) {
    if cur.last() != Some(&p) {
        cur.push(p);
    }
}

fn cubic(out: &mut Vec<P>, p0: P, p1: P, p2: P, p3: P, tol: f64, depth: u32) {
    // Flatness: max distance of the control points from the chord.
    let d = p3 - p0;
    let l = d.len();
    let flat = if l > 0.0 {
        let a = ((p1 - p0).cross(d)).abs() / l;
        let b = ((p2 - p0).cross(d)).abs() / l;
        if a > b {
            a
        } else {
            b
        }
    } else {
        let a = p1.dist(p0);
        let b = p2.dist(p0);
        if a > b {
            a
        } else {
            b
        }
    };
    if flat <= tol || depth >= 16 {
        push_pt(out, p3);
        return;
    }
    let p01 = p0.lerp(p1, 0.5);
    let p12 = p1.lerp(p2, 0.5);
    let p23 = p2.lerp(p3, 0.5);
    let p012 = p01.lerp(p12, 0.5);
    let p123 = p12.lerp(p23, 0.5);
    let mid = p012.lerp(p123, 0.5);
    cubic(out, p0, p01, p012, mid, tol, depth + 1);
    cubic(out, mid, p123, p23, p3, tol, depth + 1);
}

#[allow(clippy::too_many_arguments)]
fn arc(
    out: &mut Vec<P>,
    p0: P,
    rx: f64,
    ry: f64,
    rot_deg: f64,
    large: bool,
    sweep: bool,
    p1: P,
    tol: f64,
) {
    if p0 == p1 {
        return;
    }
    if rx == 0.0 || ry == 0.0 {
        push_pt(out, p1);
        return;
    }
    let (sin_r, cos_r) = sin_cos_deg(rot_deg);
    // Step 1: compute (x1', y1')
    let dx = (p0.x - p1.x) * 0.5;
    let dy = (p0.y - p1.y) * 0.5;
    let x1p = cos_r * dx + sin_r * dy;
    let y1p = -sin_r * dx + cos_r * dy;
    let mut rx = rx;
    let mut ry = ry;
    // Step 2: correct radii
    let lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if lam > 1.0 {
        let s = lam.sqrt();
        rx *= s;
        ry *= s;
    }
    let rx2 = rx * rx;
    let ry2 = ry * ry;
    let num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
    let den = rx2 * y1p * y1p + ry2 * x1p * x1p;
    let mut coef = if den > 0.0 && num > 0.0 {
        (num / den).sqrt()
    } else {
        0.0
    };
    if large == sweep {
        coef = -coef;
    }
    let cxp = coef * (rx * y1p / ry);
    let cyp = coef * (-(ry * x1p) / rx);
    let cx = cos_r * cxp - sin_r * cyp + (p0.x + p1.x) * 0.5;
    let cy = sin_r * cxp + cos_r * cyp + (p0.y + p1.y) * 0.5;
    let ux = (x1p - cxp) / rx;
    let uy = (y1p - cyp) / ry;
    let vx = (-x1p - cxp) / rx;
    let vy = (-y1p - cyp) / ry;
    let theta1 = atan2_deg(uy, ux);
    let mut dtheta = atan2_deg(ux * vy - uy * vx, ux * vx + uy * vy);
    if !sweep && dtheta > 0.0 {
        dtheta -= 360.0;
    } else if sweep && dtheta < 0.0 {
        dtheta += 360.0;
    }
    let r = if rx > ry { rx } else { ry };
    // segment angle so that the sagitta r(1 - cos(δ/2)) ≈ r δ²/8 ≤ tol
    let step_rad = (8.0 * tol / r).sqrt();
    let step_deg = step_rad * (180.0 / std::f64::consts::PI);
    let n = ((dtheta.abs() / step_deg).ceil() as usize).clamp(1, 4096);
    for k in 1..=n {
        if k == n {
            push_pt(out, p1);
            break;
        }
        let t = theta1 + dtheta * (k as f64 / n as f64);
        let (s, c) = sin_cos_deg(t);
        let x = rx * c;
        let y = ry * s;
        push_pt(
            out,
            P::new(cos_r * x - sin_r * y + cx, sin_r * x + cos_r * y + cy),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_square() {
        let p = flatten("M0 0 H10 V10 H0 Z", 0.25).unwrap();
        assert_eq!(p.len(), 1);
        assert!(p[0].closed);
        assert_eq!(p[0].points.len(), 4);
    }

    #[test]
    fn relative_and_implicit() {
        let p = flatten("m10,10 5,0 0,5 z m 20 0 l 1 1", 0.25).unwrap();
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].points[1], P::new(15.0, 10.0));
        assert_eq!(p[1].points[0], P::new(30.0, 10.0));
    }

    #[test]
    fn circle_by_arcs_is_round() {
        let p = flatten("M 10 0 A 10 10 0 1 1 -10 0 A 10 10 0 1 1 10 0 Z", 0.1).unwrap();
        let pts = &p[0].points;
        assert!(pts.len() > 16);
        for q in pts {
            assert!((q.len() - 10.0).abs() < 0.11, "{q:?}");
        }
    }

    #[test]
    fn cubic_flatness() {
        let p = flatten("M0 0 C 0 10 10 10 10 0", 0.05).unwrap();
        assert!(p[0].points.len() > 4);
        assert_eq!(*p[0].points.last().unwrap(), P::new(10.0, 0.0));
    }

    #[test]
    fn errors_have_offsets() {
        let e = flatten("M0 0 L 10", 0.25).unwrap_err();
        assert!(e.offset >= 8);
        assert!(flatten("X 1 2", 0.25).is_err());
    }
}
