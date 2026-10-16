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

/// A boundary candidate of variant `vi` whose label center coordinate along the side is
/// `pos` (y for left/right, x for top/bottom).
#[allow(clippy::too_many_arguments)]
pub fn slot_candidate(
    model: &Model,
    area: &Rect,
    item: &Item,
    vi: usize,
    v: &Variant,
    side: u8,
    pos: f64,
    rank: f64,
) -> Cand {
    let margin = item.len.boundary_margin;
    let (hw, hh) = (v.w * 0.5, v.h * 0.5);
    let (rect, port) = match side {
        0 => {
            let x0 = area.x0 + margin;
            (
                Rect::new(x0, pos - hh, x0 + v.w, pos + hh),
                P::new(x0 + v.w, pos),
            )
        }
        1 => {
            let x1 = area.x1 - margin;
            (
                Rect::new(x1 - v.w, pos - hh, x1, pos + hh),
                P::new(x1 - v.w, pos),
            )
        }
        2 => {
            let y0 = area.y0 + margin;
            (
                Rect::new(pos - hw, y0, pos + hw, y0 + v.h),
                P::new(pos, y0 + v.h),
            )
        }
        _ => {
            let y1 = area.y1 - margin;
            (
                Rect::new(pos - hw, y1 - v.h, pos + hw, y1),
                P::new(pos, y1 - v.h),
            )
        }
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
    keep: &dyn Fn(usize, &Rect) -> bool,
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
            // candidate rows: at the anchor height and a few offsets (for packing)
            let offsets = [0.0, -1.0, 1.0, -2.0, 2.0, -3.0, 3.0];
            for (k, &off) in offsets.iter().enumerate() {
                let (rect, port) = match side.as_str() {
                    "left" | "right" => {
                        let y = (item.anchor.y + off * v.h).clamp(area.y0 + hh, area.y1 - hh);
                        if side == "left" {
                            let x0 = area.x0 + margin;
                            (Rect::new(x0, y - hh, x0 + v.w, y + hh), P::new(x0 + v.w, y))
                        } else {
                            let x1 = area.x1 - margin;
                            (Rect::new(x1 - v.w, y - hh, x1, y + hh), P::new(x1 - v.w, y))
                        }
                    }
                    _ => {
                        let x = (item.anchor.x + off * v.w).clamp(area.x0 + hw, area.x1 - hw);
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
                                // opo-like: diagonal/vertical to the port row, then horizontal
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
