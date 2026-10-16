//! Text layout: `<text>` (with `<tspan>`, `<a>`, `<textPath>` content) → one bounding
//! box per text chunk. Mirrors `text.ts`.
//!
//! * Whitespace: `xml:space="default"` collapses runs of space/tab/CR/LF to one space
//!   across the whole element and trims leading/trailing space; `preserve` maps
//!   tab/CR/LF to spaces.
//! * Positioning uses the first value of `x`, `y`, `dx`, `dy` (lengths, `em`, `%`). An
//!   absolute `x` or `y` starts a new chunk; `text-anchor` (of the chunk's first run)
//!   shifts the chunk by 0, ½ or 1 times its advance.
//! * A run's box spans `[x, x + measure(text)]` horizontally and, for
//!   `dominant-baseline` alphabetic, `[y − ascent·size, y + descent·size]` vertically
//!   (middle/central: centred on y; hanging/text-top: top at y; text-bottom: bottom at y).
//! * Each chunk's box (union of its inked runs) is transformed by the CTM and its
//!   axis-aligned bounding box is reported.

use crate::geom::{Affine, BBox};
use crate::num::parse_first_length;
use crate::render::{Ctx, Renderer, MAX_RENDER_DEPTH};
use crate::style::{first_family, Anchor, Baseline, Computed};
use crate::xml::XmlNode;

enum Op {
    SetX(f64),
    SetY(f64),
    Dx(f64),
    Dy(f64),
    Run(String, Computed),
}

fn collapse(t: &str, preserve: bool, last_space: &mut bool) -> String {
    let mut out = String::with_capacity(t.len());
    if preserve {
        for ch in t.chars() {
            out.push(if matches!(ch, '\t' | '\n' | '\r') {
                ' '
            } else {
                ch
            });
        }
        if let Some(c) = out.chars().last() {
            *last_space = c == ' ';
        }
        return out;
    }
    for ch in t.chars() {
        if matches!(ch, ' ' | '\t' | '\n' | '\r') {
            if !*last_space {
                out.push(' ');
                *last_space = true;
            }
        } else {
            out.push(ch);
            *last_space = false;
        }
    }
    out
}

fn collect(
    r: &Renderer,
    i: usize,
    style: &Computed,
    ctx: &Ctx,
    ops: &mut Vec<Op>,
    last_space: &mut bool,
    depth: u32,
) {
    let doc = r.doc;
    let fs = style.font_size;
    let first = |name: &str| doc.attr(i, name).and_then(parse_first_length);
    if let Some(l) = first("x") {
        ops.push(Op::SetX(l.resolve(fs, ctx.vw)));
    }
    if let Some(l) = first("y") {
        ops.push(Op::SetY(l.resolve(fs, ctx.vh)));
    }
    if let Some(l) = first("dx") {
        ops.push(Op::Dx(l.resolve(fs, ctx.vw)));
    }
    if let Some(l) = first("dy") {
        ops.push(Op::Dy(l.resolve(fs, ctx.vh)));
    }
    for child in &doc.children[i] {
        match child {
            XmlNode::Text(t) => {
                let s = collapse(t, style.preserve_space, last_space);
                if !s.is_empty() {
                    ops.push(Op::Run(s, style.clone()));
                }
            }
            XmlNode::Element(c) => {
                let c = *c;
                if !doc.is_svg[c] || depth >= MAX_RENDER_DEPTH {
                    continue;
                }
                if !matches!(doc.tag(c), "tspan" | "a" | "textPath") {
                    continue;
                }
                let cs = r.style_of(c, ctx, style);
                if cs.display_none {
                    continue;
                }
                collect(r, c, &cs, ctx, ops, last_space, depth + 1);
            }
        }
    }
}

struct RunBox {
    x: f64,
    w: f64,
    top: f64,
    bottom: f64,
    inked: bool,
}

struct Chunk {
    start: f64,
    end: f64,
    anchor: Anchor,
    runs: Vec<RunBox>,
}

/// The canvas boxes of one text chunk.
pub(crate) struct ChunkBox {
    /// All runs (the element's geometry bbox).
    pub all: BBox,
    /// Runs that are visible and painted (the drawn `Rect` primitive), if any.
    pub inked: Option<BBox>,
}

fn to_canvas(ctm: &Affine, b: BBox) -> Option<BBox> {
    let corners = [
        ctm.apply(b.x0, b.y0),
        ctm.apply(b.x1, b.y0),
        ctm.apply(b.x1, b.y1),
        ctm.apply(b.x0, b.y1),
    ];
    if !corners.iter().all(|p| p[0].is_finite() && p[1].is_finite()) {
        return None;
    }
    BBox::of_points(&corners)
}

/// Lays out text element `i` (whose CTM is `ctm`); returns its chunks.
pub(crate) fn layout(
    r: &Renderer,
    i: usize,
    ctx: &Ctx,
    ctm: &Affine,
    style: &Computed,
) -> Vec<ChunkBox> {
    let mut ops = Vec::new();
    let mut last_space = true;
    collect(r, i, style, ctx, &mut ops, &mut last_space, ctx.depth);
    // Trim the trailing space of the element.
    if let Some(k) = ops.iter().rposition(|o| matches!(o, Op::Run(..))) {
        if let Op::Run(text, st) = &mut ops[k] {
            if !st.preserve_space && text.ends_with(' ') {
                text.pop();
                if text.is_empty() {
                    ops.remove(k);
                }
            }
        }
    }

    let mut chunks: Vec<Chunk> = Vec::new();
    let (mut x, mut y) = (0.0f64, 0.0f64);
    let mut new_chunk = true;
    for op in &ops {
        match op {
            Op::SetX(v) => {
                x = *v;
                new_chunk = true;
            }
            Op::SetY(v) => {
                y = *v;
                new_chunk = true;
            }
            Op::Dx(v) => x += *v,
            Op::Dy(v) => y += *v,
            Op::Run(text, st) => {
                if new_chunk || chunks.is_empty() {
                    chunks.push(Chunk {
                        start: x,
                        end: x,
                        anchor: st.anchor,
                        runs: Vec::new(),
                    });
                    new_chunk = false;
                }
                let family = first_family(&st.font_family);
                let mut w = (r.measure)(text, st.font_size, family, st.font_weight);
                if !(w >= 0.0 && w.is_finite()) {
                    w = 0.0;
                }
                let a = r.ascent * st.font_size;
                let d = r.descent * st.font_size;
                let (top, bottom) = match st.baseline {
                    Baseline::Alphabetic => (y - a, y + d),
                    Baseline::Middle => (y - (a + d) / 2.0, y + (a + d) / 2.0),
                    Baseline::Hanging => (y, y + (a + d)),
                    Baseline::Bottom => (y - (a + d), y),
                };
                let inked = st.visible && (st.filled() || st.stroked());
                let chunk = chunks.last_mut().expect("chunk exists");
                chunk.runs.push(RunBox {
                    x,
                    w,
                    top,
                    bottom,
                    inked,
                });
                x += w;
                chunk.end = x;
            }
        }
    }

    let mut out = Vec::with_capacity(chunks.len());
    for ch in &chunks {
        let advance = ch.end - ch.start;
        let shift = match ch.anchor {
            Anchor::Start => 0.0,
            Anchor::Middle => -advance / 2.0,
            Anchor::End => -advance,
        };
        let mut inked: Option<BBox> = None;
        let mut all: Option<BBox> = None;
        for run in &ch.runs {
            let b = BBox {
                x0: run.x + shift,
                y0: run.top,
                x1: run.x + run.w + shift,
                y1: run.bottom,
            };
            all = BBox::union(all, Some(b));
            if run.inked {
                inked = BBox::union(inked, Some(b));
            }
        }
        let Some(all) = all.and_then(|b| to_canvas(ctm, b)) else {
            continue;
        };
        out.push(ChunkBox {
            all,
            inked: inked.and_then(|b| to_canvas(ctm, b)),
        });
    }
    out
}
