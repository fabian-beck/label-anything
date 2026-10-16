//! SVG path data → absolute segments. Mirrors `path.ts`.
//!
//! Error handling follows SVG: on the first error the path is rendered up to (and
//! excluding) the offending command.

use crate::num::{scan_number, skip_comma_wsp, skip_wsp};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Seg {
    Move(f64, f64),
    Line(f64, f64),
    Quad(f64, f64, f64, f64),
    Cubic(f64, f64, f64, f64, f64, f64),
    Arc {
        rx: f64,
        ry: f64,
        rot: f64,
        large: bool,
        sweep: bool,
        x: f64,
        y: f64,
    },
    Close,
}

#[inline]
fn is_command(b: u8) -> bool {
    matches!(
        b,
        b'M' | b'm'
            | b'L'
            | b'l'
            | b'H'
            | b'h'
            | b'V'
            | b'v'
            | b'C'
            | b'c'
            | b'S'
            | b's'
            | b'Q'
            | b'q'
            | b'T'
            | b't'
            | b'A'
            | b'a'
            | b'Z'
            | b'z'
    )
}

#[inline]
fn starts_number(b: u8) -> bool {
    b.is_ascii_digit() || b == b'.' || b == b'-' || b == b'+'
}

struct Args<'a> {
    b: &'a [u8],
    i: usize,
}

impl Args<'_> {
    fn num(&mut self) -> Option<f64> {
        let (v, j) = scan_number(self.b, self.i)?;
        self.i = skip_comma_wsp(self.b, j);
        Some(v)
    }
    fn flag(&mut self) -> Option<bool> {
        let v = match self.b.get(self.i)? {
            b'0' => false,
            b'1' => true,
            _ => return None,
        };
        self.i = skip_comma_wsp(self.b, self.i + 1);
        Some(v)
    }
}

/// Parses path data into absolute segments.
pub(crate) fn parse_path(d: &str) -> Vec<Seg> {
    let b = d.as_bytes();
    let mut segs = Vec::new();
    let mut a = Args {
        b,
        i: skip_wsp(b, 0),
    };
    let (mut cx, mut cy) = (0.0f64, 0.0f64);
    let (mut sx, mut sy) = (0.0f64, 0.0f64);
    // Last control points for smooth curves (only valid right after C/S resp. Q/T).
    let mut last_cubic: Option<(f64, f64)> = None;
    let mut last_quad: Option<(f64, f64)> = None;
    let mut prev: Option<u8> = None;
    loop {
        a.i = skip_wsp(b, a.i);
        if a.i >= b.len() {
            break;
        }
        let ch = b[a.i];
        let cmd = if is_command(ch) {
            a.i += 1;
            a.i = skip_wsp(b, a.i);
            ch
        } else if starts_number(ch) {
            match prev {
                Some(b'M') => b'L',
                Some(b'm') => b'l',
                Some(p) if p != b'Z' && p != b'z' => p,
                _ => break,
            }
        } else {
            break;
        };
        if prev.is_none() && cmd != b'M' && cmd != b'm' {
            break;
        }
        let rel = cmd.is_ascii_lowercase();
        let (ox, oy) = if rel { (cx, cy) } else { (0.0, 0.0) };
        let mut cubic_ctrl = None;
        let mut quad_ctrl = None;
        match cmd.to_ascii_uppercase() {
            b'Z' => {
                segs.push(Seg::Close);
                cx = sx;
                cy = sy;
            }
            b'M' => {
                let Some(x) = a.num() else { break };
                let Some(y) = a.num() else { break };
                cx = ox + x;
                cy = oy + y;
                sx = cx;
                sy = cy;
                segs.push(Seg::Move(cx, cy));
            }
            b'L' => {
                let Some(x) = a.num() else { break };
                let Some(y) = a.num() else { break };
                cx = ox + x;
                cy = oy + y;
                segs.push(Seg::Line(cx, cy));
            }
            b'H' => {
                let Some(x) = a.num() else { break };
                cx = ox + x;
                segs.push(Seg::Line(cx, cy));
            }
            b'V' => {
                let Some(y) = a.num() else { break };
                cy = oy + y;
                segs.push(Seg::Line(cx, cy));
            }
            b'C' => {
                let Some(x1) = a.num() else { break };
                let Some(y1) = a.num() else { break };
                let Some(x2) = a.num() else { break };
                let Some(y2) = a.num() else { break };
                let Some(x) = a.num() else { break };
                let Some(y) = a.num() else { break };
                let (x2, y2) = (ox + x2, oy + y2);
                segs.push(Seg::Cubic(ox + x1, oy + y1, x2, y2, ox + x, oy + y));
                cubic_ctrl = Some((x2, y2));
                cx = ox + x;
                cy = oy + y;
            }
            b'S' => {
                let Some(x2) = a.num() else { break };
                let Some(y2) = a.num() else { break };
                let Some(x) = a.num() else { break };
                let Some(y) = a.num() else { break };
                let (x1, y1) = match last_cubic {
                    Some((px, py)) => (2.0 * cx - px, 2.0 * cy - py),
                    None => (cx, cy),
                };
                let (x2, y2) = (ox + x2, oy + y2);
                segs.push(Seg::Cubic(x1, y1, x2, y2, ox + x, oy + y));
                cubic_ctrl = Some((x2, y2));
                cx = ox + x;
                cy = oy + y;
            }
            b'Q' => {
                let Some(x1) = a.num() else { break };
                let Some(y1) = a.num() else { break };
                let Some(x) = a.num() else { break };
                let Some(y) = a.num() else { break };
                let (x1, y1) = (ox + x1, oy + y1);
                segs.push(Seg::Quad(x1, y1, ox + x, oy + y));
                quad_ctrl = Some((x1, y1));
                cx = ox + x;
                cy = oy + y;
            }
            b'T' => {
                let Some(x) = a.num() else { break };
                let Some(y) = a.num() else { break };
                let (x1, y1) = match last_quad {
                    Some((px, py)) => (2.0 * cx - px, 2.0 * cy - py),
                    None => (cx, cy),
                };
                segs.push(Seg::Quad(x1, y1, ox + x, oy + y));
                quad_ctrl = Some((x1, y1));
                cx = ox + x;
                cy = oy + y;
            }
            b'A' => {
                let Some(rx) = a.num() else { break };
                let Some(ry) = a.num() else { break };
                let Some(rot) = a.num() else { break };
                let Some(large) = a.flag() else { break };
                let Some(sweep) = a.flag() else { break };
                let Some(x) = a.num() else { break };
                let Some(y) = a.num() else { break };
                cx = ox + x;
                cy = oy + y;
                segs.push(Seg::Arc {
                    rx,
                    ry,
                    rot,
                    large,
                    sweep,
                    x: cx,
                    y: cy,
                });
            }
            _ => break,
        }
        last_cubic = cubic_ctrl;
        last_quad = quad_ctrl;
        prev = Some(cmd);
    }
    segs
}
