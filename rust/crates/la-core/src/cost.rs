//! Static candidate cost and hard feasibility (spec §8, §6.7).

use crate::candidates::{Block, Cand, Kind, Leader};
use crate::env::Env;
use crate::geom::{Rect, EPS, P};
use crate::labels::Variant;
use crate::math::{clampf, maxf, minf};
use crate::model::{Item, Model};
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
    /// Per-region areas of a label box.
    split: Vec<(u32, f64)>,
    /// `Some(soft_ok)` while [`Evaluator::eval_usable`] runs.
    quick: Option<bool>,
    /// Less important items whose marks a label covers, while [`Evaluator::eval_usable`]
    /// runs: their coverage is summed once the hard rules let the label be used.
    lower: Vec<u32>,
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
    /// With `quick = Some(soft_ok)`: whether the candidate can no longer be used — not even
    /// relaxed, or infeasible where relaxed candidates do not count.
    #[inline]
    fn unusable(&self, quick: Option<bool>) -> bool {
        match quick {
            Some(soft_ok) => !self.relaxed || (!soft_ok && !self.feasible),
            None => false,
        }
    }
}

/// Whether the mark of another item (not of the item's group) comes closer than
/// `stub_reach` to the label box `r` of `item`: the label could be read as that item's
/// (spec §6.9). `buf` is scratch space for the item query.
pub fn crowded(model: &Model, obs: &Obstacles, item: &Item, r: &Rect, buf: &mut Vec<u32>) -> bool {
    let reach = item.len.stub_reach;
    // a label against a mark larger than its font size reads as attached to it
    let b = item.shape.bbox();
    if reach <= 0.0 || maxf(b.w(), b.h()) > item.em() {
        return false;
    }
    let i = item.index;
    obs.item_index.query(&r.inflate(reach), buf);
    buf.iter().any(|&j| {
        let j = j as usize;
        j != i
            && model.group_of.get(j).copied().flatten() != Some(i)
            && model.items[j].shape.dist_rect(r) < reach
    })
}

/// How squarely the point `p` lies beside a side of `r`, where a label of a mark at `p`
/// would go: 1 straight across a side (or inside `r`), 0 on the diagonal of a corner, and
/// `|dx² − dy²| / (dx² + dy²)` for the offset `(dx, dy)` of `p` from `r` (spec §4.4).
pub fn facing(r: &Rect, p: P) -> f64 {
    let dx = if p.x < r.x0 {
        r.x0 - p.x
    } else if p.x > r.x1 {
        p.x - r.x1
    } else {
        0.0
    };
    let dy = if p.y < r.y0 {
        r.y0 - p.y
    } else if p.y > r.y1 {
        p.y - r.y1
    } else {
        0.0
    };
    let s = dx * dx + dy * dy;
    if s > 0.0 {
        (dx * dx - dy * dy).abs() / s
    } else {
        1.0
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
            split: Vec::new(),
            quick: None,
            lower: Vec::new(),
        }
    }

    /// [`Evaluator::eval`] for a caller that keeps a candidate only when it is usable
    /// (feasible, or relaxed with `soft_ok`): the evaluation stops at the first violation
    /// that leaves it unusable, so the cost of a candidate it returns unusable is partial.
    pub fn eval_usable(&mut self, c: &mut Cand, v: &Variant, soft_ok: bool) {
        self.quick = Some(soft_ok);
        self.eval(c, v, None);
        self.quick = None;
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
        let quick = self.quick;
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
        // a label without a distant leader comes no closer to another item's mark than to
        // its own, and without a stub it is nearer to its own by its margin (spec §4.4)
        let near_rule = model.placement.own_nearest
            && c.kind != Kind::Internal
            && (c.leaders.is_empty() || c.has_stub());
        let d_own = if near_rule {
            item.shape.dist_rect(&r)
        } else {
            0.0
        };
        let clear = if near_rule && !c.has_stub() {
            margin
        } else {
            0.0
        };
        // a mark that lies more squarely beside a side of the label than its own, where its
        // own label would go, must be farther still: up to the side margin
        let side = if clear > 0.0 {
            let s = if c.warm {
                crate::candidates::WARM_MARGIN * item.len.side_margin
            } else {
                item.len.side_margin
            };
            maxf(s, clear)
        } else {
            0.0
        };
        let own_facing = if side > clear {
            facing(&r, item.shape.reference())
        } else {
            1.0
        };
        let reach = maxf(
            maxf(
                if item.len.buffer > gap_guess {
                    item.len.buffer
                } else {
                    gap_guess
                },
                margin,
            ),
            // no other mark needs more than the side margin's share the own mark leaves
            d_own + clear + (side - clear) * (1.0 - own_facing),
        );
        self.buf.clear();
        obs.item_index.query(&r.inflate(reach), &mut self.buf);
        // the marks of less important items follow `lower_items` where it differs from `items`
        let lower_rule = dy.label_lower != dy.label_items;
        let mut lower_cov = 0.0;
        self.lower.clear();
        for &j in &self.buf {
            let j = j as usize;
            let sj = &model.items[j].shape;
            let lower = lower_rule && j != i && model.is_lower(i, j);
            if lower {
                if quick.is_some() {
                    self.lower.push(j as u32);
                } else {
                    lower_cov += obs.own_covered(j, &r);
                }
            }
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
                if acc.unusable(quick) {
                    return finish(c, acc);
                }
                continue;
            }
            let hard = if lower {
                dy.label_lower.is_hard()
            } else {
                dy.label_items.is_hard()
            };
            if !hard {
                continue;
            }
            if c.label_overlaps_shape(sj) {
                acc.violate(Block::Items, false, 0.0);
                if acc.unusable(quick) {
                    return finish(c, acc);
                }
                continue;
            }
            let d = sj.dist_rect(&r);
            // the margin (up to rounding), but never more than the mark keeps from the own
            // mark's box
            if margin > crate::geom::EPS
                && d < margin - crate::geom::EPS
                && d < sj.dist_rect(&item.shape.bbox())
            {
                acc.violate(Block::Items, false, 0.0);
                if acc.unusable(quick) {
                    return finish(c, acc);
                }
            }
            // nearer to the label than its own mark, or, without a stub, not a margin farther,
            // up to the side margin for a point's mark more squarely beside a side than the own
            // (at most as far as the two marks' reference points lie apart; the marks of the
            // item's group aside)
            let sep = if clear > 0.0 {
                let need = if side > clear && model.items[j].area.is_none() {
                    clear + (side - clear) * maxf(facing(&r, sj.reference()) - own_facing, 0.0)
                } else {
                    clear
                };
                minf(need, sj.reference().dist(item.shape.reference()))
            } else {
                0.0
            };
            if near_rule
                && d < d_own + sep - crate::geom::EPS
                && model.group_of.get(j).copied().flatten() != Some(i)
            {
                acc.violate(Block::Items, false, 0.0);
                if acc.unusable(quick) {
                    return finish(c, acc);
                }
            }
        }
        // (in the order of the query, as above)
        for &j in &self.lower {
            lower_cov += obs.own_covered(j as usize, &r);
        }
        if let AvoidW::Soft(wt) = dy.label_items {
            let cov = obs.other_items_covered(i, &r);
            let cov = if lower_rule {
                maxf(cov - lower_cov, 0.0)
            } else {
                cov
            };
            acc.add("items", wt * cov / em2);
        }
        if let (true, AvoidW::Soft(wt)) = (lower_rule, dy.label_lower) {
            acc.add("lower_items", wt * lower_cov / em2);
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
                        if acc.unusable(quick) {
                            return finish(c, acc);
                        }
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
        // 3b. backdrop contrast: the luma variance under the box (none on a mark)
        if let Some(bd) = &obs.backdrop {
            if !on_mark {
                let cell = bd.grid.cell;
                let d = bd.deviation(&r);
                acc.add(
                    "contrast",
                    w.contrast * (4.0 * d * (cell * cell) / 65025.0) / em2,
                );
            }
        }
        // 3c. regions: a label across a border, in a region other than its item's (none on
        // a mark)
        if let Some(rm) = &obs.regions {
            if !on_mark {
                let sp = rm.split(&r, obs.home[i], &mut self.split);
                // a label that names a region by where it lies (an area's, not inside it, or
                // one on a leader) lies mostly at home or in open space
                if sp.foreign > model.placement.max_foreign * sp.area
                    && c.kind != Kind::Internal
                    && (item.area.is_some() || !c.leaders.is_empty())
                {
                    acc.violate(Block::Regions, false, 0.0);
                    return finish(c, acc);
                }
                let c2 = rm.grid.cell * rm.grid.cell;
                acc.add("straddle", w.straddle * (sp.straddle() * c2) / em2);
                acc.add("foreign", w.foreign * (sp.foreign * c2) / em2);
            }
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
            if acc.unusable(quick) {
                return finish(c, acc);
            }
        }
        if !acc.relaxed {
            return finish(c, acc);
        }
        // 5. position
        acc.add("position", w.position * c.rank / 8.0);
        // 6. distance from own shape (the rule of step 2 measured it already)
        let gap = if c.kind == Kind::Internal {
            0.0
        } else if near_rule {
            d_own
        } else {
            item.shape.dist_rect(&r)
        };
        // (a stub is part of the distance, not a leader to a distant label)
        let stub = c.has_stub();
        if c.leaders.is_empty() || stub {
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
        // 9. ambiguity (the item query above covers the reach of adjacent labels); a stub
        // resolves it
        if w.ambiguity > 0.0 && c.kind != Kind::Internal && !stub {
            let amb = if let Some(l) = c.leaders.first() {
                0.5 * self.ambiguity_point(i, l.port, em)
            } else if gap <= gap_guess {
                self.ambiguity_rect_cached(i, &r, gap, em)
            } else {
                self.ambiguity_rect(i, &r, gap, em)
            };
            acc.add("ambiguity", w.ambiguity * amb);
        }
        // 10. crowd: with stubs, a label beside its mark that another item's mark comes
        // near, and that has no stub, costs as much as a leader (spec §6.9)
        if model.placement.stubs
            && !stub
            && matches!(c.kind, Kind::Adjacent | Kind::Slider)
            && crowded(model, self.obs, item, &r, &mut self.buf)
        {
            acc.add("crowd", w.leader);
        }
        // 11. stability
        if w.stability > 0.0 {
            if let Some(Some(b)) = model.warm.get(&item.id) {
                let d = b.center().dist(r.center());
                // 1 per em up to 1 em, then 1/4 per em up to 5 em: a label that must move
                // goes to a near spot rather than to the best one anywhere
                let tail = minf(1.0, maxf(0.0, d / em - 1.0) * 0.25);
                acc.add("stability", w.stability * (minf(1.0, d / em) + tail));
            }
        }
        // 12. host cost
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
        if l.stub {
            // a stub (spec §6.9) costs its length, not a leader
            acc.add("stub", w.leader_length * l.len / em);
        } else {
            acc.add(
                "leader",
                w.leader + w.leader_length * l.len / em + w.bends * l.bends as f64,
            );
        }
        // region borders on the way
        if let Some(rm) = &obs.regions {
            acc.add(
                "leader_borders",
                w.leader_borders * f64::from(rm.crossings(&l.pts)),
            );
        }
        // leaders stay on the canvas
        if let Some(ca) = obs.leader_area {
            if !l.pts.iter().all(|p| ca.contains_point(*p)) {
                acc.violate(Block::Edge, false, 0.0);
                if acc.unusable(self.quick) {
                    return;
                }
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
            if acc.unusable(self.quick) {
                return;
            }
        }
        // other items: clearance (not from the group's members, and not from a mark that
        // covers the leader's anchor, or a column leader's start: no leader avoids it). A
        // leader must only not cross a mark closer than the clearance to its start when it
        // is a fan or boundary label's (it leaves a crowd of touching marks, in the order of
        // its column) or when that mark touches the box of its own mark (it leaves a spot of
        // touching marks, which no leader could keep the clearance from)
        let bb = l.bbox().inflate(item.len.clearance);
        self.buf.clear();
        obs.item_index.query(&bb, &mut self.buf);
        let clearance = item.len.clearance;
        let (anchor, own_box) = match l.member {
            Some(m) => (
                model.items[m as usize].anchor,
                model.items[m as usize].shape.bbox(),
            ),
            None => (item.anchor, item.shape.bbox()),
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
            let pol = if dy.leader_lower != dy.leader_items && model.is_lower(i, j) {
                dy.leader_lower
            } else {
                dy.leader_items
            };
            match pol {
                AvoidW::Hard => {
                    let lim = if sj.signed_distance(start) < clearance
                        && (column || sj.dist_rect(&own_box) <= EPS)
                    {
                        EPS
                    } else {
                        clearance - EPS
                    };
                    if dmin < lim {
                        acc.violate(Block::Items, false, 0.0);
                        if acc.unusable(self.quick) {
                            return;
                        }
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
                        if acc.unusable(self.quick) {
                            return;
                        }
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
