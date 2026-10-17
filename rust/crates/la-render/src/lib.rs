//! Debug SVG overlay (brief §2.8): placed labels, leaders, candidates, a cost heatmap per
//! class, item shapes and unplaced labels with their reasons.
//!
//! Layers are SVG groups with ids (`background`, `obstacles`, `heatmap-<class>`,
//! `candidates`, `items`, `leaders`, `labels`, `unplaced`) so they can be toggled.

use la_core::geom::shape::Shape;
use la_core::geom::{Rect, P};
use la_core::model::{Model, Prim};
use la_core::DebugData;
use serde_json::Value;
use std::fmt::Write;

/// Escape text for XML.
pub fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            c => o.push(c),
        }
    }
    o
}

fn f(v: f64) -> String {
    let r = (v * 100.0).round() / 100.0;
    if r == r.trunc() {
        format!("{}", r as i64)
    } else {
        format!("{r}")
    }
}

fn path_of(points: &[P], close: bool) -> String {
    let mut d = String::new();
    for (i, p) in points.iter().enumerate() {
        let _ = write!(d, "{}{} {}", if i == 0 { "M" } else { "L" }, f(p.x), f(p.y));
    }
    if close {
        d.push('Z');
    }
    d
}

fn shape_svg(s: &Shape, style: &str) -> String {
    match s {
        Shape::Circle { c, r } => format!(
            r#"<circle cx="{}" cy="{}" r="{}" {style}/>"#,
            f(c.x),
            f(c.y),
            f(r.max(0.75))
        ),
        Shape::Polygon(p) => {
            let d: String = p.rings.iter().map(|r| path_of(r, true)).collect();
            format!(
                r#"<path d="{d}" fill-rule="{}" {style}/>"#,
                if p.even_odd { "evenodd" } else { "nonzero" }
            )
        }
        _ => format!(r#"<path d="{}" {style}/>"#, path_of(&s.outline(), true)),
    }
}

/// Palette for class heatmaps (colour-blind friendly; cycles).
const PALETTE: [(u8, u8, u8); 8] = [
    (230, 85, 13),
    (49, 130, 189),
    (117, 107, 177),
    (49, 163, 84),
    (214, 39, 40),
    (140, 86, 75),
    (227, 119, 194),
    (188, 189, 34),
];

/// Render the overlay. `model` (from `la_core::model::build`) provides true item shapes
/// and obstacle geometry; `debug` adds heatmaps and candidates.
pub fn debug_svg(model: Option<&Model>, result: &Value, debug: Option<&DebugData>) -> String {
    let canvas = model.and_then(|m| m.canvas).or_else(|| {
        // derive from the placements
        let mut r = Rect::EMPTY;
        for p in result["placements"].as_array().into_iter().flatten() {
            if let Some(b) = p.get("box") {
                let (x, y) = (
                    b["x"].as_f64().unwrap_or(0.0),
                    b["y"].as_f64().unwrap_or(0.0),
                );
                r = r.union(&Rect::xywh(
                    x,
                    y,
                    b["w"].as_f64().unwrap_or(0.0),
                    b["h"].as_f64().unwrap_or(0.0),
                ));
            }
        }
        if let Some(m) = model {
            for it in &m.items {
                r = r.union(&it.shape.bbox());
            }
        }
        (!r.is_empty()).then(|| r.inflate(20.0))
    });
    let vb = canvas.unwrap_or(Rect::new(0.0, 0.0, 100.0, 100.0));
    let mut s = String::new();
    let _ = write!(
        s,
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="{} {} {} {}" width="{}" height="{}" font-family="Noto Sans, Arial, sans-serif">"#,
        f(vb.x0),
        f(vb.y0),
        f(vb.w()),
        f(vb.h()),
        f(vb.w()),
        f(vb.h())
    );
    let _ = write!(
        s,
        r##"<rect id="background" x="{}" y="{}" width="{}" height="{}" fill="#ffffff"/>"##,
        f(vb.x0),
        f(vb.y0),
        f(vb.w()),
        f(vb.h())
    );
    if let Some(m) = model {
        if let Some(la) = m.label_area {
            let _ = write!(
                s,
                r##"<rect id="label-area" x="{}" y="{}" width="{}" height="{}" fill="none" stroke="#cccccc" stroke-dasharray="4 3"/>"##,
                f(la.x0),
                f(la.y0),
                f(la.w()),
                f(la.h())
            );
        }
    }
    // heatmaps
    if let Some(d) = debug {
        for (k, (name, cov)) in d.classes.iter().enumerate() {
            if cov.iter().all(|&c| c == 0) {
                continue;
            }
            let (r, g, b) = PALETTE[k % PALETTE.len()];
            let png = png_rgba(d.grid.cols as u32, d.grid.rows as u32, |i| {
                [r, g, b, cov[i]]
            });
            let _ = write!(
                s,
                r#"<g id="heatmap-{}" opacity="0.45"><title>cost grid: {}</title><image x="{}" y="{}" width="{}" height="{}" preserveAspectRatio="none" style="image-rendering:pixelated" href="data:image/png;base64,{}"/></g>"#,
                esc(name),
                esc(name),
                f(d.grid.ox),
                f(d.grid.oy),
                f(d.grid.cols as f64 * d.grid.cell),
                f(d.grid.rows as f64 * d.grid.cell),
                base64(&png)
            );
        }
    }
    // obstacles
    if let Some(m) = model {
        s.push_str(r#"<g id="obstacles" opacity="0.6">"#);
        for (class, p) in m.vector.iter().take(200_000) {
            let t = format!("<title>{}</title>", esc(class));
            match p {
                Prim::Disc { c, r } => {
                    let _ = write!(
                        s,
                        r##"<circle cx="{}" cy="{}" r="{}" fill="#9e9e9e">{t}</circle>"##,
                        f(c.x),
                        f(c.y),
                        f(r.max(0.5))
                    );
                }
                Prim::Rect(r) => {
                    let _ = write!(
                        s,
                        r##"<rect x="{}" y="{}" width="{}" height="{}" fill="#bdbdbd">{t}</rect>"##,
                        f(r.x0),
                        f(r.y0),
                        f(r.w()),
                        f(r.h())
                    );
                }
                Prim::Polygon { rings, .. } => {
                    let d: String = rings.iter().map(|r| path_of(r, true)).collect();
                    let _ = write!(
                        s,
                        r##"<path d="{d}" fill="#e0e0e0" stroke="#9e9e9e" stroke-width="0.5">{t}</path>"##
                    );
                }
                Prim::Polyline { points, hw, closed } => {
                    let _ = write!(
                        s,
                        r##"<path d="{}" fill="none" stroke="#9e9e9e" stroke-width="{}">{t}</path>"##,
                        path_of(points, *closed),
                        f((hw * 2.0).max(0.5))
                    );
                }
                Prim::Shape(sh) => s.push_str(&shape_svg(sh, r##"fill="#bdbdbd""##)),
            }
        }
        s.push_str("</g>");
    }
    // candidates
    if let Some(d) = debug {
        s.push_str(r#"<g id="candidates" opacity="0.25" fill="none" stroke-width="0.5">"#);
        for (_, r, ok) in d.candidates.iter().take(50_000) {
            let _ = write!(
                s,
                r##"<rect x="{}" y="{}" width="{}" height="{}" stroke="{}"/>"##,
                f(r.x0),
                f(r.y0),
                f(r.w()),
                f(r.h()),
                if *ok { "#2e7d32" } else { "#c62828" }
            );
        }
        s.push_str("</g>");
    }
    // items
    if let Some(m) = model {
        s.push_str(r#"<g id="items">"#);
        for it in &m.items {
            if let Some(a) = &it.area {
                s.push_str(&shape_svg(
                    &a.shape,
                    r##"fill="#bbdefb" fill-opacity="0.5" stroke="#1565c0" stroke-width="0.75""##,
                ));
            }
            s.push_str(&shape_svg(
                &it.shape,
                r##"fill="#1565c0" fill-opacity="0.35" stroke="#0d47a1" stroke-width="0.75""##,
            ));
        }
        s.push_str("</g>");
    }
    // leaders and labels
    let mut leaders = String::new();
    let mut labels = String::new();
    let mut unplaced = String::new();
    for (k, p) in result["placements"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let id = p["id"].as_str().unwrap_or("");
        if p["placed"].as_bool() == Some(true) {
            let b = &p["box"];
            let (x, y, w, h) = (
                b["x"].as_f64().unwrap_or(0.0),
                b["y"].as_f64().unwrap_or(0.0),
                b["w"].as_f64().unwrap_or(0.0),
                b["h"].as_f64().unwrap_or(0.0),
            );
            let mut ls: Vec<&Value> = p
                .get("leaders")
                .and_then(|l| l.as_array())
                .map(|a| a.iter().collect())
                .unwrap_or_default();
            if ls.is_empty() {
                if let Some(l) = p.get("leader").filter(|l| l.is_object()) {
                    ls.push(l);
                }
            }
            for l in ls {
                let pts: Vec<P> = l["points"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|q| Some(P::new(q.get(0)?.as_f64()?, q.get(1)?.as_f64()?)))
                    .collect();
                let _ = write!(
                    leaders,
                    r##"<path d="{}" fill="none" stroke="#424242" stroke-width="1"/>"##,
                    path_of(&pts, false)
                );
                if let Some(u) = l.get("underline").and_then(|u| u.as_array()) {
                    let pts: Vec<P> = u
                        .iter()
                        .filter_map(|q| Some(P::new(q.get(0)?.as_f64()?, q.get(1)?.as_f64()?)))
                        .collect();
                    let _ = write!(
                        leaders,
                        r##"<path d="{}" fill="none" stroke="#424242" stroke-width="1"/>"##,
                        path_of(&pts, false)
                    );
                }
                if let Some(first) = pts.first() {
                    let _ = write!(
                        leaders,
                        r##"<circle cx="{}" cy="{}" r="1.2" fill="#424242"/>"##,
                        f(first.x),
                        f(first.y)
                    );
                }
            }
            let title = format!(
                "{} · {} · cost {:.3} · rank {}",
                id,
                p["anchor_side"].as_str().unwrap_or(""),
                p["cost"].as_f64().unwrap_or(0.0),
                p["priority"]["rank"]
            );
            let _ = write!(
                labels,
                r##"<g class="label" data-id="{}"><title>{}</title><rect x="{}" y="{}" width="{}" height="{}" fill="#ffffff" fill-opacity="0.75"/>"##,
                esc(id),
                esc(&title),
                f(x),
                f(y),
                f(w),
                f(h)
            );
            let draw_text = |t: &Value, ox: f64, oy: f64, out: &mut String| {
                let size = t["font_size"].as_f64().unwrap_or(12.0);
                let weight = t["font_weight"].as_i64().unwrap_or(400);
                let xo = t["x_offset"].as_f64().unwrap_or(0.0);
                for (line, base) in t["lines"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .zip(t["baseline_offsets"].as_array().into_iter().flatten())
                {
                    let _ = write!(
                        out,
                        r##"<text x="{}" y="{}" font-size="{}" font-weight="{}" fill="#000000">{}</text>"##,
                        f(ox + xo),
                        f(oy + base.as_f64().unwrap_or(0.0)),
                        f(size),
                        weight,
                        esc(line.as_str().unwrap_or(""))
                    );
                }
            };
            if let Some(t) = p.get("text") {
                draw_text(t, x, y, &mut labels);
            }
            for part in p
                .get("parts")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
            {
                let pb = &part["box"];
                let (px, py, pw, ph) = (
                    pb["x"].as_f64().unwrap_or(0.0),
                    pb["y"].as_f64().unwrap_or(0.0),
                    pb["w"].as_f64().unwrap_or(0.0),
                    pb["h"].as_f64().unwrap_or(0.0),
                );
                match part["type"].as_str() {
                    Some("text") => {
                        if let Some(t) = part.get("text") {
                            draw_text(t, px, py, &mut labels);
                        }
                    }
                    _ => {
                        let _ = write!(
                            labels,
                            r##"<rect x="{}" y="{}" width="{}" height="{}" fill="#000000" fill-opacity="0.5"/>"##,
                            f(px),
                            f(py),
                            f(pw),
                            f(ph)
                        );
                    }
                }
            }
            labels.push_str("</g>");
        } else if let Some(m) = model {
            if let Some(it) = m.items.get(k) {
                let c = it.anchor;
                let title = format!(
                    "{} unplaced: {} (blocking: {}; blocked by: {})",
                    id,
                    p["reason"].as_str().unwrap_or(""),
                    p["blocking"]
                        .as_array()
                        .map(|a| a
                            .iter()
                            .filter_map(|x| x.as_str())
                            .collect::<Vec<_>>()
                            .join(", "))
                        .unwrap_or_default(),
                    p["blocked_by"]
                        .as_array()
                        .map(|a| a
                            .iter()
                            .filter_map(|x| x.as_str())
                            .collect::<Vec<_>>()
                            .join(", "))
                        .unwrap_or_default()
                );
                let _ = write!(
                    unplaced,
                    r##"<g class="unplaced" data-id="{}"><title>{}</title><path d="M{} {}L{} {}M{} {}L{} {}" stroke="#d32f2f" stroke-width="1.5"/></g>"##,
                    esc(id),
                    esc(&title),
                    f(c.x - 3.0),
                    f(c.y - 3.0),
                    f(c.x + 3.0),
                    f(c.y + 3.0),
                    f(c.x - 3.0),
                    f(c.y + 3.0),
                    f(c.x + 3.0),
                    f(c.y - 3.0)
                );
            }
        }
    }
    let _ = write!(
        s,
        r#"<g id="leaders">{leaders}</g><g id="labels">{labels}</g><g id="unplaced">{unplaced}</g>"#
    );
    let st = &result["stats"];
    let _ = write!(
        s,
        r##"<g id="stats"><text x="{}" y="{}" font-size="9" fill="#757575">placed {}/{} · hard violations {} · crossings {} · inversions {} · {:.1} ms</text></g>"##,
        f(vb.x0 + 4.0),
        f(vb.y1 - 4.0),
        st["placed"],
        st["total"],
        st["hard_violations"],
        st["leader_crossings"],
        st["priority_inversions"],
        st["runtime_ms"].as_f64().unwrap_or(0.0)
    );
    s.push_str("</svg>");
    s
}

// --------------------------------------------------------------------------------------
// Minimal PNG encoder (stored deflate blocks) and base64
// --------------------------------------------------------------------------------------

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (n, t) in table.iter_mut().enumerate() {
        let mut c = n as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
        *t = c;
    }
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c = table[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &x in data {
        a = (a + x as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

/// Encode an RGBA image (uncompressed deflate; small debug images only).
pub fn png_rgba(w: u32, h: u32, px: impl Fn(usize) -> [u8; 4]) -> Vec<u8> {
    let mut raw = Vec::with_capacity((w as usize * 4 + 1) * h as usize);
    for y in 0..h as usize {
        raw.push(0);
        for x in 0..w as usize {
            raw.extend_from_slice(&px(y * w as usize + x));
        }
    }
    let mut z = vec![0x78, 0x01];
    let mut chunks = raw.chunks(65535).peekable();
    if chunks.peek().is_none() {
        z.extend_from_slice(&[1, 0, 0, 0xFF, 0xFF]);
    }
    while let Some(c) = chunks.next() {
        let last = chunks.peek().is_none();
        z.push(if last { 1 } else { 0 });
        let len = c.len() as u16;
        z.extend_from_slice(&len.to_le_bytes());
        z.extend_from_slice(&(!len).to_le_bytes());
        z.extend_from_slice(c);
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut chunk = |ty: &[u8], data: &[u8]| {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut c = ty.to_vec();
        c.extend_from_slice(data);
        out.extend_from_slice(&c);
        out.extend_from_slice(&crc32(&c).to_be_bytes());
    };
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(b"IHDR", &ihdr);
    chunk(b"IDAT", &z);
    chunk(b"IEND", &[]);
    out
}

/// Standard base64.
pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        s.push(if c.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_has_signature_and_iend() {
        let p = png_rgba(3, 2, |i| [i as u8, 0, 0, 255]);
        assert_eq!(&p[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        assert_eq!(&p[p.len() - 8..p.len() - 4], b"IEND");
    }

    #[test]
    fn base64_roundtrip_known() {
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
    }
}
