//! Static candidate cost and hard feasibility (spec §8, §6.7).

use crate::candidates::{Block, Cand, Kind, Leader};
use crate::env::Env;
use crate::geom::{Rect, EPS, P};
use crate::labels::Variant;
use crate::math::{clampf, maxf, minf};
use crate::model::Model;
use crate::obstacles::{AvoidW, Obstacles, OwnMark};

/// Named cost terms (for `cost_breakdown`).
pub type Breakdown = Vec<(String, f64)>;

/// Evaluates static costs. Holds scratch buffers; one per thread.
pub struct Evaluator<'a> {
    pub model: &'a Model,
    pub obs: &'a Obstacles,
    pub env: &'a dyn Env,
    buf: Vec<u32>,
    buf2: Vec<u32>,
}

struct Acc<'b> {
    cost: f64,
    feasible: bool,
    relaxed: bool,
    relax_cost: f64,
    blocked: Option<Block>,
    breakdown: Option<&'b mut Breakdown>,
}

impl Acc<'_> {
    #[inline]
    fn add(&mut self, name: &str, v: f64) {
        if v == 0.0 {
            return;
        }
        self.cost += v;
        if let Some(b) = self.breakdown.as_deref_mut() {
            match b.iter_mut().find(|(n, _)| n == name) {
                Some(e) => e.1 += v,
                None => b.push((name.to_string(), v)),
            }
        }
    }
    /// `add` for the term `prefix` + `name`, a name built only for a breakdown.
    #[inline]
    fn add_named(&mut self, prefix: &str, name: &str, v: f64) {
        if self.breakdown.is_some() {
            self.add(&format!("{prefix}{name}"), v);
        } else if v != 0.0 {
            self.cost += v;
        }
    }
    #[inline]
    fn violate(&mut self, why: Block, relaxable: bool, extra: f64) {
        if self.feasible {
            self.feasible = false;
            self.blocked = Some(why);
        }
        if relaxable {
            self.relax_cost += extra;
        } else {
            self.relaxed = false;
        }
    }
}

fn finish(c: &mut Cand, acc: Acc) {
    c.evaluated = true;
    c.cost = acc.cost;
    c.feasible = acc.feasible;
    c.relaxed = acc.relaxed;
    c.relax_cost = acc.relax_cost;
    c.blocked = acc.blocked;
}

impl<'a> Evaluator<'a> {
    pub fn new(model: &'a Model, obs: &'a Obstacles, env: &'a dyn Env) -> Evaluator<'a> {
        Evaluator {
            model,
            obs,
            env,
            buf: Vec::new(),
            buf2: Vec::new(),
        }
    }

    /// Fill `c.cost`, `c.feasible`, `c.relaxed`, `c.relax_cost`, `c.blocked_*`.
    pub fn eval(&mut self, c: &mut Cand, v: &Variant, breakdown: Option<&mut Breakdown>) {
        let model = self.model;
        let obs = self.obs;
        let item = &model.items[c.item as usize];
        let i = c.item as usize;
        let em = item.em();
        let r = c.rect;
        let area = maxf(r.area(), 1e-9);
        // coverage costs count covered em², whatever the label's size (spec §8)
        let em2 = em * em;
        let w = &model.weights;
        let dy = &obs.dynamic;
        let soft_w = model.degrade.soft_overlap_weight;
        let mut acc = Acc {
            cost: 0.0,
            feasible: true,
            relaxed: true,
            relax_cost: 0.0,
            blocked: None,
            breakdown,
        };

        // 1. label area (canvas_edge)
        if let Some(la) = obs.label_area {
            if !la.contains_rect(&r) {
                match dy.label_edge {
                    AvoidW::Hard => acc.violate(Block::Edge, false, 0.0),
                    AvoidW::Soft(wt) => {
                        acc.add("canvas_edge", wt * (area - la.overlap_area(&r)) / em2)
                    }
                    AvoidW::Ignore => {}
                }
            }
        }
        if !acc.relaxed {
            return finish(c, acc);
        }
        // 2. items (exact); one query serves the buffer ring and the ambiguity term
        let ring = r.inflate(item.len.buffer);
        let gap_guess = item.len.offset + 0.5 * em;
        let margin = if c.warm {
            crate::candidates::WARM_MARGIN * item.len.margin
        } else {
            item.len.margin
        };
        let reach = maxf(
            if item.len.buffer > gap_guess {
                item.len.buffer
            } else {
                gap_guess
            },
            margin,
        );
        self.buf.clear();
        obs.item_index.query(&r.inflate(reach), &mut self.buf);
        for &j in &self.buf {
            let j = j as usize;
            let sj = &model.items[j].shape;
            if j == i {
                if c.kind == Kind::Internal {
                    continue;
                }
                match dy.own_mark {
                    OwnMark::Hard => {
                        if c.label_overlaps_shape(sj) {
                            acc.violate(Block::Items, false, 0.0);
                        }
                    }
                    OwnMark::Partial(f) => {
                        if c.label_overlaps_shape(sj) {
                            let (g, s) = &obs.own[i];
                            let frac = s.covered_area(g, &r) / maxf(sj.area(), 1e-9);
                            if frac > f {
                                acc.violate(Block::Items, false, 0.0);
                            }
                        }
                    }
                    OwnMark::Ignore => {}
                }
                continue;
            }
            if !matches!(dy.label_items, AvoidW::Hard) {
                continue;
            }
            if c.label_overlaps_shape(sj) {
                acc.violate(Block::Items, false, 0.0);
            } else if margin > crate::geom::EPS {
                // the margin (up to rounding), but never more than the mark keeps from the
                // own mark's box
                let d = sj.dist_rect(&r);
                if d < margin - crate::geom::EPS && d < sj.dist_rect(&item.shape.bbox()) {
                    acc.violate(Block::Items, false, 0.0);
                }
            }
        }
        if let AvoidW::Soft(wt) = dy.label_items {
            acc.add("items", wt * obs.other_items_covered(i, &r) / em2);
        }
        // the ring only sees other items when the item query found any besides the own
        if dy.buffer_items > 0.0 && self.buf.iter().any(|&j| j as usize != i) {
            let ring_area = maxf(ring.area() - area, 1e-9);
            let cov = maxf(
                obs.other_items_covered(i, &ring) - obs.other_items_covered(i, &r),
                0.0,
            );
            acc.add("buffer:items", dy.buffer_items * cov / ring_area);
        }
        if !acc.relaxed {
            return finish(c, acc);
        }
        // 3. static classes (an internal label of a mark covers only the mark, which hides
        // what lies under it: no soft coverage costs)
        let on_mark = c.kind == Kind::Internal && item.area.is_none();
        let mut hard_prims_checked = false;
        for (ci, cl) in obs.classes.iter().enumerate() {
            let Some(sat) = &cl.sat else { continue };
            match cl.label {
                AvoidW::Hard => {
                    let mut hit = false;
                    if cl.has_raster {
                        hit = sat.any(&obs.grid, &r);
                    } else if cl.has_prims {
                        if !hard_prims_checked {
                            self.buf2.clear();
                            obs.prim_index.query(&r, &mut self.buf2);
                            hard_prims_checked = true;
                        }
                        hit = self.buf2.iter().any(|&p| {
                            let (pc, prim) = &obs.prims[p as usize];
                            *pc == ci && prim.overlaps_rect(&r)
                        });
                    }
                    if hit {
                        let extra = soft_w * sat.covered_area(&obs.grid, &r) / em2;
                        acc.violate(Block::Class(ci as u16), cl.relaxable, extra);
                    }
                }
                AvoidW::Soft(wt) => {
                    if !on_mark && sat.any(&obs.grid, &r) {
                        acc.add(&cl.name, wt * sat.covered_area(&obs.grid, &r) / em2);
                    }
                }
                AvoidW::Ignore => {}
            }
            if cl.buffer > 0.0 && sat.any(&obs.grid, &ring) {
                let ring_area = maxf(ring.area() - area, 1e-9);
                let cov = maxf(
                    sat.covered_area(&obs.grid, &ring) - sat.covered_area(&obs.grid, &r),
                    0.0,
                );
                acc.add_named("buffer:", &cl.name, cl.buffer * cov / ring_area);
            }
        }
        if !acc.relaxed {
            return finish(c, acc);
        }
        // 4. leaders
        for l in &c.leaders {
            self.leader_terms(
                i,
                l,
                &r,
                matches!(c.kind, Kind::Fan | Kind::Boundary),
                &mut acc,
            );
        }
        if !acc.relaxed {
            return finish(c, acc);
        }
        // 5. position
        acc.add("position", w.position * c.rank / 8.0);
        // 6. distance from own shape
        let gap = if c.kind == Kind::Internal {
            0.0
        } else {
            item.shape.dist_rect(&r)
        };
        if c.leaders.is_empty() {
            acc.add("distance", w.distance * gap / em);
        }
        // 7. shape penalty
        acc.add("shape", w.shape * v.penalty);
        // 8. edge proximity
        if let Some(la) = obs.label_area {
            let d = minf(
                minf(r.x0 - la.x0, la.x1 - r.x1),
                minf(r.y0 - la.y0, la.y1 - r.y1),
            );
            acc.add("edge", w.edge * maxf(0.0, 1.0 - maxf(d, 0.0) / em));
        }
        // 9. ambiguity (the item query above covers the reach of adjacent labels)
        if w.ambiguity > 0.0 && c.kind != Kind::Internal {
            let amb = if let Some(l) = c.leaders.first() {
                0.5 * self.ambiguity_point(i, l.port, em)
            } else if gap <= gap_guess {
                self.ambiguity_rect_cached(i, &r, gap, em)
            } else {
                self.ambiguity_rect(i, &r, gap, em)
            };
            acc.add("ambiguity", w.ambiguity * amb);
        }
        // 10. stability
        if w.stability > 0.0 {
            if let Some(Some(b)) = model.warm.get(&item.id) {
                let d = b.center().dist(r.center());
                // 1 per em up to 1 em, then 1/4 per em up to 5 em: a label that must move
                // goes to a near spot rather than to the best one anywhere
                let tail = minf(1.0, maxf(0.0, d / em - 1.0) * 0.25);
                acc.add("stability", w.stability * (minf(1.0, d / em) + tail));
            }
        }
        // 11. host cost
        if self.env.has_cost_callback() {
            acc.add(
                "user",
                self.env.extra_cost(&item.id, &r, !c.leaders.is_empty()),
            );
        }
        finish(c, acc)
    }

    /// Ambiguity using the items already queried into `self.buf`.
    fn ambiguity_rect_cached(&self, i: usize, r: &Rect, d_own: f64, em: f64) -> f64 {
        let reach = d_own + 0.5 * em;
        let mut d_other = f64::INFINITY;
        for &j in &self.buf {
            if j as usize != i {
                d_other = minf(d_other, self.model.items[j as usize].shape.dist_rect(r));
            }
        }
        if d_other < reach {
            clampf((d_own - d_other) / em + 0.5, 0.0, 1.0)
        } else {
            0.0
        }
    }

    fn ambiguity_rect(&mut self, i: usize, r: &Rect, d_own: f64, em: f64) -> f64 {
        let reach = d_own + 0.5 * em;
        self.buf.clear();
        self.obs.item_index.query(&r.inflate(reach), &mut self.buf);
        let mut d_other = f64::INFINITY;
        for &j in &self.buf {
            if j as usize != i {
                d_other = minf(d_other, self.model.items[j as usize].shape.dist_rect(r));
            }
        }
        if d_other < reach {
            clampf((d_own - d_other) / em + 0.5, 0.0, 1.0)
        } else {
            0.0
        }
    }

    fn ambiguity_point(&mut self, i: usize, p: P, em: f64) -> f64 {
        let own = maxf(self.model.items[i].shape.signed_distance(p), 0.0);
        let reach = 2.0 * em;
        self.buf.clear();
        self.obs
            .item_index
            .query(&Rect::from_center(p, reach, reach), &mut self.buf);
        let mut d_other = f64::INFINITY;
        for &j in &self.buf {
            if j as usize != i {
                d_other = minf(
                    d_other,
                    maxf(self.model.items[j as usize].shape.signed_distance(p), 0.0),
                );
            }
        }
        if d_other < reach && d_other < own {
            clampf(1.0 - d_other / reach, 0.0, 1.0)
        } else {
            0.0
        }
    }

    fn leader_terms(&mut self, i: usize, l: &Leader, own_rect: &Rect, column: bool, acc: &mut Acc) {
        let model = self.model;
        let obs = self.obs;
        let item = &model.items[i];
        let em = item.em();
        let w = &model.weights;
        let dy = &obs.dynamic;
        let hw = model.leaders.width * 0.5;
        acc.add(
            "leader",
            w.leader + w.leader_length * l.len / em + w.bends * l.bends as f64,
        );
        // leaders stay on the canvas
        if let Some(ca) = obs.leader_area {
            if !l.pts.iter().all(|p| ca.contains_point(*p)) {
                acc.violate(Block::Edge, false, 0.0);
            }
        }
        let segs: Vec<(P, P)> = l.segments().collect();
        let n_main = l.pts.len().saturating_sub(1);
        for (k, &(a, b)) in segs.iter().enumerate() {
            // not through the own shape (skip a tiny start piece for tips/boundary starts)
            let a2 = if k == 0 {
                a.lerp(b, minf(0.5 / maxf(a.dist(b), 1e-9), 0.5))
            } else {
                a
            };
            if (!item.tip || k > 0) && item.shape.dist_segment(a2, b) <= EPS {
                acc.violate(Block::Items, false, 0.0);
            }
            // not into the own label except at the port (underline is on the label edge)
            if k < n_main && crate::geom::seg_overlaps_rect(a, b, &own_rect.inflate(-0.5)) {
                acc.violate(Block::Labels, false, 0.0);
            }
        }
        // other items: clearance (not from the group's members, and not from a mark that
        // covers the leader's anchor, or a column leader's start: no leader avoids it); the
        // leader of a fan or boundary label must only not cross a mark closer than the
        // clearance to its start (it leaves a crowd of touching marks, in the order of its
        // column)
        let bb = l.bbox().inflate(item.len.clearance);
        self.buf.clear();
        obs.item_index.query(&bb, &mut self.buf);
        let clearance = item.len.clearance;
        let anchor = match l.member {
            Some(m) => model.items[m as usize].anchor,
            None => item.anchor,
        };
        let start = l.pts[0];
        for &j in &self.buf {
            let j = j as usize;
            if j == i || model.group_of.get(j).copied().flatten() == Some(i) {
                continue;
            }
            let sj = &model.items[j].shape;
            if sj.contains(anchor) || (column && sj.contains(start)) {
                continue;
            }
            let mut dmin = f64::INFINITY;
            for &(a, b) in &segs {
                dmin = minf(dmin, sj.dist_segment(a, b));
            }
            match dy.leader_items {
                AvoidW::Hard => {
                    let lim = if column && sj.signed_distance(start) < clearance {
                        EPS
                    } else {
                        clearance - EPS
                    };
                    if dmin < lim {
                        acc.violate(Block::Items, false, 0.0);
                    }
                }
                AvoidW::Soft(wt) => {
                    if dmin < clearance {
                        let f = if clearance > 0.0 {
                            1.0 - dmin / clearance
                        } else {
                            1.0
                        };
                        acc.add("leader:items", wt * f);
                    }
                }
                AvoidW::Ignore => {}
            }
        }
        // static classes
        let mut prim_ids_loaded = false;
        for (ci, cl) in obs.classes.iter().enumerate() {
            let Some(sat) = &cl.sat else { continue };
            match cl.leader {
                AvoidW::Hard => {
                    let mut hit = false;
                    if cl.has_raster {
                        hit = segs.iter().any(|&(a, b)| obs.covered_len(sat, a, b) > 0.0);
                    } else if cl.has_prims {
                        if !prim_ids_loaded {
                            self.buf2.clear();
                            obs.prim_index
                                .query(&l.bbox().inflate(hw + 1.0), &mut self.buf2);
                            prim_ids_loaded = true;
                        }
                        hit = self.buf2.iter().any(|&p| {
                            let (pc, prim) = &obs.prims[p as usize];
                            *pc == ci
                                && segs.iter().any(|&(a, b)| {
                                    prim.dist_segment(a, b) < hw - EPS
                                        || (hw <= EPS && prim.dist_segment(a, b) <= EPS)
                                })
                        });
                    }
                    if hit {
                        let extra: f64 = segs
                            .iter()
                            .map(|&(a, b)| obs.covered_len(sat, a, b))
                            .sum::<f64>()
                            / em;
                        acc.violate(
                            Block::Class(ci as u16),
                            cl.relaxable,
                            model.degrade.soft_overlap_weight * extra,
                        );
                    }
                }
                AvoidW::Soft(wt) => {
                    let cov: f64 = segs.iter().map(|&(a, b)| obs.covered_len(sat, a, b)).sum();
                    acc.add_named("leader:", &cl.name, wt * cov / em);
                }
                AvoidW::Ignore => {}
            }
        }
    }
}
