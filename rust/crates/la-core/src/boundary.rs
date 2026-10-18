//! Boundary labeling (spec §6.6): labels stacked in the canvas margins with leaders.
//!
//! Candidates are generated per item and side: the label is placed in the margin at the
//! height of its anchor (the joint assignment of slots happens in the solver's boundary
//! pass, which re-packs labels on each side without crossings).

use crate::candidates::{Cand, Kind, Leader, Side};
use crate::geom::{Rect, P};
use crate::labels::Variant;
use crate::model::opts::LeaderStyle;
use crate::model::{Item, Model};
use crate::obstacles::Obstacles;

pub fn side_code(side: &str) -> u8 {
    match side {
        "left" => 0,
        "right" => 1,
        "top" => 2,
        _ => 3,
    }
}

/// The label area used for boundary slots.
pub fn slot_area(model: &Model, obs: &Obstacles) -> Option<Rect> {
    obs.label_area.or(model.canvas)
}

/// Build the leader of a boundary label whose port is `port` on `side`.
pub fn boundary_leader(model: &Model, item: &Item, side: u8, port: P) -> Leader {
    let style = model.leaders.style;
    let start = crate::leaders::leader_start(model, item, port);
    let horizontal = side <= 1;
    let pts = match style {
        LeaderStyle::Orthogonal | LeaderStyle::Elbow => {
            if horizontal {
                if (start.y - port.y).abs() < 1e-9 {
                    vec![start, port]
                } else {
                    let mid = if style == LeaderStyle::Elbow {
                        let dy = port.y - start.y;
                        let sx = if port.x >= start.x { 1.0 } else { -1.0 };
                        P::new(start.x + sx * dy.abs(), port.y)
                    } else {
                        P::new(start.x, port.y)
                    };
                    if (port.x - mid.x) * (port.x - start.x) <= 0.0 {
                        vec![start, port]
                    } else {
                        vec![start, mid, port]
                    }
                }
            } else if (start.x - port.x).abs() < 1e-9 {
                vec![start, port]
            } else {
                vec![start, P::new(port.x, start.y), port]
            }
        }
        _ => vec![start, port],
    };
    Leader::new(pts, style)
}

/// The port of a label in a column along `side` whose label center coordinate along the
/// side is `pos` (y for left/right, x for top/bottom), and whose labels reach `depth` into
/// the margin (the widest label for left and right, the tallest for top and bottom): on the
/// column's line facing the picture, `margin + depth` from the edge.
pub fn column_port(area: &Rect, item: &Item, side: u8, pos: f64, depth: f64) -> P {
    let d = item.len.boundary_margin + depth;
    match side {
        0 => P::new(area.x0 + d, pos),
        1 => P::new(area.x1 - d, pos),
        2 => P::new(pos, area.y0 + d),
        _ => P::new(pos, area.y1 - d),
    }
}

/// A label of variant `vi` in a column along `side` (spec §6.6), at `pos` along the side and
/// aligned on the column's line facing the picture (see [`column_port`]), so that every
/// leader of the column ends on that line.
#[allow(clippy::too_many_arguments)]
pub fn column_candidate(
    model: &Model,
    area: &Rect,
    item: &Item,
    vi: usize,
    v: &Variant,
    side: u8,
    pos: f64,
    depth: f64,
    rank: f64,
) -> Cand {
    let (hw, hh) = (v.w * 0.5, v.h * 0.5);
    let port = column_port(area, item, side, pos, depth);
    let rect = match side {
        0 => Rect::new(port.x - v.w, pos - hh, port.x, pos + hh),
        1 => Rect::new(port.x, pos - hh, port.x + v.w, pos + hh),
        2 => Rect::new(pos - hw, port.y - v.h, pos + hw, port.y),
        _ => Rect::new(pos - hw, port.y, pos + hw, port.y + v.h),
    };
    let mut c = Cand::new(
        item.index as u32,
        vi as u16,
        v.level,
        Kind::Boundary,
        Side::Boundary,
        rank,
        rect,
    );
    c.bside = side;
    let l = boundary_leader(model, item, side, port);
    if l.len > 0.0 {
        c.leaders.push(l);
    }
    c
}

/// Boundary candidates for the given variants. Label boxes for which `keep(vi, box)` is
/// false are skipped before their leaders are built.
pub fn boundary_candidates(
    model: &Model,
    obs: &Obstacles,
    item: &Item,
    variants: &[Variant],
    vis: &[usize],
    keep: &impl Fn(usize, &Rect) -> bool,
    out: &mut Vec<Cand>,
) {
    let Some(area) = obs.label_area.or(model.canvas) else {
        return;
    };
    let margin = item.len.boundary_margin;
    let style = model.leaders.style;
    let it = item.index as u32;
    for &vi in vis {
        let v = &variants[vi];
        let (hw, hh) = (v.w * 0.5, v.h * 0.5);
        for side in &model.placement.boundary.sides {
            // a label longer than the side cannot be stacked along it
            let vertical = side == "left" || side == "right";
            if (vertical && v.h > area.h()) || (!vertical && v.w > area.w()) {
                continue;
            }
            // candidate rows: at the anchor height and a few offsets (for packing)
            let offsets = [0.0, -1.0, 1.0, -2.0, 2.0, -3.0, 3.0];
            for (k, &off) in offsets.iter().enumerate() {
                let (rect, port) = match side.as_str() {
                    "left" | "right" => {
                        let y = crate::math::clampf(
                            item.anchor.y + off * v.h,
                            area.y0 + hh,
                            area.y1 - hh,
                        );
                        if side == "left" {
                            let x0 = area.x0 + margin;
                            (Rect::new(x0, y - hh, x0 + v.w, y + hh), P::new(x0 + v.w, y))
                        } else {
                            let x1 = area.x1 - margin;
                            (Rect::new(x1 - v.w, y - hh, x1, y + hh), P::new(x1 - v.w, y))
                        }
                    }
                    _ => {
                        let x = crate::math::clampf(
                            item.anchor.x + off * v.w,
                            area.x0 + hw,
                            area.x1 - hw,
                        );
                        if side == "top" {
                            let y0 = area.y0 + margin;
                            (Rect::new(x - hw, y0, x + hw, y0 + v.h), P::new(x, y0 + v.h))
                        } else {
                            let y1 = area.y1 - margin;
                            (Rect::new(x - hw, y1 - v.h, x + hw, y1), P::new(x, y1 - v.h))
                        }
                    }
                };
                if !keep(vi, &rect) {
                    continue;
                }
                let start = crate::leaders::leader_start(model, item, port);
                let pts = match style {
                    LeaderStyle::Orthogonal | LeaderStyle::Elbow => {
                        let horizontal = side == "left" || side == "right";
                        if horizontal {
                            if (start.y - port.y).abs() < 1e-9 {
                                vec![start, port]
                            } else {
                                // one bend: vertical (orthogonal, po) or diagonal (elbow) to
                                // the port row, then horizontal
                                let mid = if style == LeaderStyle::Elbow {
                                    let dy = port.y - start.y;
                                    let sx = if port.x >= start.x { 1.0 } else { -1.0 };
                                    P::new(start.x + sx * dy.abs(), port.y)
                                } else {
                                    P::new(start.x, port.y)
                                };
                                if (port.x - mid.x) * (port.x - start.x) <= 0.0 {
                                    vec![start, port]
                                } else {
                                    vec![start, mid, port]
                                }
                            }
                        } else if (start.x - port.x).abs() < 1e-9 {
                            vec![start, port]
                        } else {
                            vec![start, P::new(port.x, start.y), port]
                        }
                    }
                    _ => vec![start, port],
                };
                let mut c = Cand::new(
                    it,
                    vi as u16,
                    v.level,
                    Kind::Boundary,
                    Side::Boundary,
                    9.0 + k as f64 * 0.25,
                    rect,
                );
                c.bside = side_code(side);
                let l = Leader::new(pts, style);
                if l.len > 0.0 {
                    c.leaders.push(l);
                }
                out.push(c);
            }
        }
    }
}
