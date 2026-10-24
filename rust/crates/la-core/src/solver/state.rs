//! Placement state: placed candidates, dynamic indexes, exact conflicts and dynamic costs.

use crate::candidates::Cand;
use crate::geom::shape::Shape;
use crate::geom::{seg_len_in_rect, seg_seg_dist, Rect, EPS, P};
use crate::grid::occupancy::Occupancy;
use crate::index::{DynIndex, StaticIndex};
use crate::leaders::{cand_leaders_conflict, leader_hits_label, Spacing};
use crate::math::{maxf, minf};
use crate::obstacles::{AvoidW, Obstacles};

/// The marks a label may cover when they belong to less important items
/// (`avoid.label.lower_items` given and not hard, spec §4.4): such a label conflicts with
/// every label of the item whose mark it covers.
pub struct LowerMarks {
    marks: Vec<Shape>,
    index: StaticIndex,
    /// The group representative of every item (a group's label may cover its members).
    group_of: Vec<Option<usize>>,
}

impl LowerMarks {
    pub fn new(
        marks: Vec<Shape>,
        group_of: Vec<Option<usize>>,
        extent: &Rect,
        cell: f64,
    ) -> LowerMarks {
        let index = StaticIndex::new(marks.iter().map(|m| m.bbox()).collect(), extent, cell);
        LowerMarks {
            marks,
            index,
            group_of,
        }
    }
}

/// No pending placement (`State::pend_at`).
const NONE: u32 = u32::MAX;

/// The set of placed labels with spatial indexes.
pub struct State {
    /// Placed candidate per item.
    pub placed: Vec<Option<u32>>,
    /// Item placed with relaxed classes (soft_overlap step).
    pub relaxed: Vec<bool>,
    label_ix: DynIndex,
    seg_ix: DynIndex,
    /// Leader segments: (item, a, b).
    segs: Vec<(u32, P, P)>,
    free_segs: Vec<u32>,
    item_segs: Vec<Vec<u32>>,
    pub n_placed: usize,
    pub label_area_sum: f64,
    buf: Vec<u32>,
    occ: Occupancy,
    /// Label boxes placed (`true`) or removed (`false`) since `occ` was last brought up to
    /// date: only candidate generation reads the grid, so local search, exact search and
    /// repair, which place and remove labels all the time, never pay for marking it. A box
    /// placed and removed again before that cancels out (`None`; `pend_at`: the index of
    /// each item's pending placement, `NONE` for none). The grid counts boxes per cell, so
    /// applying the remaining changes later (in order) gives the same grid.
    pend: Vec<Option<(Rect, bool)>>,
    pend_item: Vec<u32>,
    pend_at: Vec<u32>,
    /// Priority key level per item, and the number of placed labels per key level.
    keys: Vec<usize>,
    key_count: Vec<u32>,
    max_key: Option<usize>,
    /// Leader spacing rules: clearance and font size per item, the cosine of
    /// `leaders.min_angle_between`, and how far they reach beyond a candidate's box.
    clr: Vec<f64>,
    em: Vec<f64>,
    /// The space each item's label keeps from other labels and stubs (its spacing, at least
    /// its margin, spec §4.4) and the largest.
    margin: Vec<f64>,
    margin_max: f64,
    /// How far stubs reach beyond a label's box (the largest such space with stubs, else
    /// 0).
    stub_gap: f64,
    cos_min: f64,
    reach: f64,
    /// Placed items already tested by a conflict query.
    seen: Vec<u32>,
    /// Marks of less important items that labels may cover (see [`LowerMarks`]).
    lower: Option<LowerMarks>,
    lbuf: Vec<u32>,
}

impl State {
    /// `keys`: the priority key level of every item (smaller = more important); `clr`
    /// and `em`: the leader clearance and font size of every item; `margin`: the space the
    /// label of every item keeps from other labels; `cos_min`: the cosine of
    /// `leaders.min_angle_between`.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        n_items: usize,
        extent: &Rect,
        cell: f64,
        keys: Vec<usize>,
        clr: Vec<f64>,
        em: Vec<f64>,
        margin: Vec<f64>,
        cos_min: f64,
        lower: Option<LowerMarks>,
    ) -> State {
        let n_keys = keys.iter().copied().max().map(|k| k + 1).unwrap_or(0);
        let mut reach = clr.iter().copied().fold(0.0, maxf);
        if cos_min < 1.0 {
            reach = em.iter().copied().fold(reach, maxf);
        }
        let margin_max = margin.iter().copied().fold(0.0, maxf);
        State {
            margin,
            margin_max,
            stub_gap: 0.0,
            placed: vec![None; n_items],
            relaxed: vec![false; n_items],
            label_ix: DynIndex::new(extent, cell),
            seg_ix: DynIndex::new(extent, cell),
            segs: Vec::new(),
            free_segs: Vec::new(),
            item_segs: vec![Vec::new(); n_items],
            n_placed: 0,
            label_area_sum: 0.0,
            buf: Vec::new(),
            occ: Occupancy::new(extent),
            pend: Vec::new(),
            pend_item: Vec::new(),
            pend_at: vec![NONE; n_items],
            keys,
            key_count: vec![0; n_keys],
            max_key: None,
            clr,
            em,
            cos_min,
            reach,
            seen: Vec::new(),
            lower,
            lbuf: Vec::new(),
        }
    }

    /// Conflicts of `c` by the `lower_items` rule (in this order): placed items of lower
    /// key whose mark the label of `c` covers, then placed items of higher key whose label
    /// covers the mark of `c`'s item. With `first`, stops at the first one.
    fn lower_conflicts(
        &mut self,
        c: &Cand,
        cands: &[Cand],
        skip: usize,
        pred: &dyn Fn(usize) -> bool,
        first: bool,
        out: &mut Vec<u32>,
    ) {
        let Some(lw) = &self.lower else { return };
        let i = c.item as usize;
        let mut buf = std::mem::take(&mut self.lbuf);
        lw.index.query(&c.rect, &mut buf);
        for &j in &buf {
            let j = j as usize;
            if j == i
                || j == skip
                || self.placed[j].is_none()
                || self.keys[j] <= self.keys[i]
                || lw.group_of[j] == Some(i)
                || !pred(j)
            {
                continue;
            }
            if c.label_overlaps_shape(&lw.marks[j]) {
                out.push(j as u32);
                if first {
                    self.lbuf = buf;
                    return;
                }
            }
        }
        let mark = &lw.marks[i];
        self.label_ix.query(&mark.bbox(), &mut buf);
        for &j in &buf {
            let j = j as usize;
            if j == i
                || j == skip
                || self.keys[j] >= self.keys[i]
                || lw.group_of[i] == Some(j)
                || !pred(j)
            {
                continue;
            }
            let Some(pid) = self.placed[j] else { continue };
            if cands[pid as usize].label_overlaps_shape(mark) {
                out.push(j as u32);
                if first {
                    break;
                }
            }
        }
        self.lbuf = buf;
    }

    /// The less important items whose marks the label of `c` covers (see [`LowerMarks`]),
    /// in index-query order.
    pub fn lower_covered(&mut self, c: &Cand, out: &mut Vec<u32>) {
        out.clear();
        let Some(lw) = &self.lower else { return };
        let i = c.item as usize;
        lw.index.query(&c.rect, out);
        let keys = &self.keys;
        out.retain(|&j| {
            let j = j as usize;
            j != i
                && keys[j] > keys[i]
                && lw.group_of[j] != Some(i)
                && c.label_overlaps_shape(&lw.marks[j])
        });
    }

    /// The bounding box of item `i`'s mark (when labels may cover less important marks).
    pub fn mark_bbox(&self, i: usize) -> Option<Rect> {
        self.lower.as_ref().map(|lw| lw.marks[i].bbox())
    }

    /// Whether labels may cover the marks of less important items (see [`LowerMarks`]).
    pub fn has_lower(&self) -> bool {
        self.lower.is_some()
    }

    /// Whether the labels of `a` and `b` (different items) exclude each other by the
    /// `lower_items` rule: one covers the mark of the other's, less important, item.
    pub fn pair_lower(&self, a: &Cand, b: &Cand) -> bool {
        let Some(lw) = &self.lower else { return false };
        let (i, j) = (a.item as usize, b.item as usize);
        (self.keys[j] > self.keys[i]
            && lw.group_of[j] != Some(i)
            && a.label_overlaps_shape(&lw.marks[j]))
            || (self.keys[i] > self.keys[j]
                && lw.group_of[i] != Some(j)
                && b.label_overlaps_shape(&lw.marks[i]))
    }

    /// The largest label margin: how far label-label conflicts reach beyond a box.
    pub fn margin_max(&self) -> f64 {
        self.margin_max
    }

    /// With stubs (spec §6.9), which keep the margin from other labels, conflict queries
    /// reach that far for them.
    pub fn with_stubs(mut self, stubs: bool) -> State {
        if stubs {
            self.stub_gap = self.margin_max;
        }
        self
    }

    /// How far leader conflicts reach beyond a candidate's bounding box when leaders may
    /// not come close (`avoid.leader.leaders` hard): the largest clearance, and the
    /// largest font size with the angle rule.
    pub fn leader_reach(&self, obs: &Obstacles) -> f64 {
        if obs.dynamic.leader_leaders.is_hard() {
            self.reach
        } else {
            0.0
        }
    }

    /// Spacing rules between the leaders of items `i` and `j`.
    pub fn spacing(&self, i: usize, j: usize) -> Spacing {
        Spacing {
            clr: maxf(self.clr[i], self.clr[j]),
            near: maxf(self.em[i], self.em[j]),
            cos_min: self.cos_min,
            gap: maxf(self.margin[i], self.margin[j]),
        }
    }

    /// The largest key level among placed labels (`None` when nothing is placed).
    pub fn max_placed_key(&self) -> Option<usize> {
        self.max_key
    }

    /// Quick, exact rejection: the box `r` of a rectangular label overlaps a placed
    /// rectangular label (`false` means "unknown", not "free").
    pub fn quick_blocked(&mut self, r: &Rect) -> bool {
        self.n_placed > 0 && self.occupancy().blocked(r)
    }

    /// The placed-label occupancy grid (its windows serve grids with the same cells).
    pub fn occupancy(&mut self) -> &Occupancy {
        for (e, &item) in self.pend.iter().zip(&self.pend_item) {
            if let Some((r, add)) = e {
                self.occ.mark(r, *add);
            }
            self.pend_at[item as usize] = NONE;
        }
        self.pend.clear();
        self.pend_item.clear();
        &self.occ
    }

    /// Log a change of the occupancy grid (see `pend`); a long log is applied now and then.
    fn pend_mark(&mut self, item: usize, r: Rect, add: bool) {
        self.pend.push(Some((r, add)));
        self.pend_item.push(item as u32);
        if self.pend.len() > 4 * self.pend_at.len() + 1024 {
            self.occupancy();
        }
    }

    pub fn place(&mut self, item: usize, cid: u32, cands: &[Cand], relaxed: bool) {
        debug_assert!(self.placed[item].is_none());
        let c = &cands[cid as usize];
        self.placed[item] = Some(cid);
        self.relaxed[item] = relaxed;
        self.label_ix.insert(item as u32, c.rect);
        if c.lshape.is_none() {
            self.pend_at[item] = self.pend.len() as u32;
            self.pend_mark(item, c.rect, true);
        }
        if let Some(&k) = self.keys.get(item) {
            self.key_count[k] += 1;
            self.max_key = Some(self.max_key.map_or(k, |m| m.max(k)));
        }
        for l in &c.leaders {
            for (a, b) in l.segments() {
                let id = match self.free_segs.pop() {
                    Some(id) => {
                        self.segs[id as usize] = (item as u32, a, b);
                        id
                    }
                    None => {
                        self.segs.push((item as u32, a, b));
                        (self.segs.len() - 1) as u32
                    }
                };
                self.seg_ix.insert(
                    id,
                    Rect::new(
                        minf(a.x, b.x),
                        minf(a.y, b.y),
                        maxf(a.x, b.x),
                        maxf(a.y, b.y),
                    ),
                );
                self.item_segs[item].push(id);
            }
        }
        self.n_placed += 1;
        self.label_area_sum += c.rect.area();
    }

    pub fn unplace(&mut self, item: usize, cands: &[Cand]) {
        let Some(cid) = self.placed[item] else { return };
        let c = &cands[cid as usize];
        if c.lshape.is_none() {
            let at = self.pend_at[item];
            if at != NONE {
                // placed since the last update: nothing to undo in the grid
                debug_assert!(self.pend[at as usize] == Some((c.rect, true)));
                self.pend[at as usize] = None;
                self.pend_at[item] = NONE;
                // (searches undo in LIFO order: drop cancelled entries at the end)
                while let Some(None) = self.pend.last() {
                    self.pend.pop();
                    self.pend_item.pop();
                }
            } else {
                self.pend_mark(item, c.rect, false);
            }
        }
        if let Some(&k) = self.keys.get(item) {
            self.key_count[k] -= 1;
            if self.max_key == Some(k) && self.key_count[k] == 0 {
                self.max_key = (0..k).rev().find(|&j| self.key_count[j] > 0);
            }
        }
        self.label_area_sum -= cands[cid as usize].rect.area();
        self.placed[item] = None;
        self.relaxed[item] = false;
        self.label_ix.remove(item as u32);
        for id in std::mem::take(&mut self.item_segs[item]) {
            self.seg_ix.remove(id);
            self.free_segs.push(id);
        }
        self.n_placed -= 1;
    }

    /// Placed items whose label or leaders conflict (hard) with candidate `c`.
    /// `skip` is ignored (the candidate's own item, or a group).
    pub fn conflicts(
        &mut self,
        c: &Cand,
        cands: &[Cand],
        obs: &Obstacles,
        skip: usize,
        out: &mut Vec<u32>,
    ) {
        out.clear();
        let dy = &obs.dynamic;
        let bb = c.bbox();
        // labels near the candidate (label-label, candidate leaders through placed labels)
        self.label_ix
            .query(&bb.inflate(self.margin_max), &mut self.buf);
        for &j in &self.buf {
            if j as usize == skip {
                continue;
            }
            let Some(pid) = self.placed[j as usize] else {
                continue;
            };
            let p = &cands[pid as usize];
            let gap = maxf(self.margin[c.item as usize], self.margin[j as usize]);
            if dy.label_labels.is_hard() && c.label_overlaps_gap(p, gap) {
                out.push(j);
                continue;
            }
            if dy.leader_labels.is_hard()
                && c.leaders.iter().any(|l| leader_hits_label(l, &p.rect, gap))
            {
                out.push(j);
            }
        }
        // leaders near the candidate (placed leaders through the candidate label or stubs
        // closer than the margin, leaders crossing or coming closer than the clearance)
        let reach = if c.leaders.is_empty() {
            self.stub_gap
        } else {
            maxf(self.leader_reach(obs), self.stub_gap)
        };
        self.seg_ix
            .query(&bb.inflate(EPS * 2.0 + reach), &mut self.buf);
        self.seen.clear();
        for &s in &self.buf {
            let j = self.segs[s as usize].0;
            if j as usize == skip || out.contains(&j) || self.seen.contains(&j) {
                continue;
            }
            self.seen.push(j);
            let p = &cands[self.placed[j as usize].expect("placed leader") as usize];
            if self.leaders_hit(c, p, dy, j as usize) {
                out.push(j);
            }
        }
        self.lower_conflicts(c, cands, skip, &|_| true, false, out);
        out.sort_unstable();
        out.dedup();
    }

    /// Whether the placed candidate `p` of item `j` has a leader through the label of `c`
    /// (or a stub closer than the margin), or a leader that conflicts with a leader of `c`.
    fn leaders_hit(&self, c: &Cand, p: &Cand, dy: &crate::obstacles::Dynamic, j: usize) -> bool {
        let gap = maxf(self.margin[c.item as usize], self.margin[j]);
        if dy.leader_labels.is_hard()
            && p.leaders.iter().any(|l| leader_hits_label(l, &c.rect, gap))
        {
            return true;
        }
        dy.leader_leaders.is_hard()
            && !c.leaders.is_empty()
            && cand_leaders_conflict(c, p, self.spacing(c.item as usize, j))
    }

    /// Whether candidate `c` conflicts with nothing placed (except `skip`); stops at the
    /// first conflict.
    pub fn is_free(
        &mut self,
        c: &Cand,
        cands: &[Cand],
        obs: &Obstacles,
        skip: usize,
        _scratch: &mut Vec<u32>,
    ) -> bool {
        self.first_conflict(c, cands, obs, skip, |_| true).is_none()
    }

    /// The first placed item (in index-query order) that conflicts with `c` and satisfies
    /// `pred`.
    pub fn first_conflict(
        &mut self,
        c: &Cand,
        cands: &[Cand],
        obs: &Obstacles,
        skip: usize,
        pred: impl Fn(usize) -> bool,
    ) -> Option<usize> {
        let dy = &obs.dynamic;
        let bb = c.bbox();
        self.label_ix
            .query(&bb.inflate(self.margin_max), &mut self.buf);
        for &j in &self.buf {
            let ju = j as usize;
            if ju == skip || !pred(ju) {
                continue;
            }
            let Some(pid) = self.placed[ju] else { continue };
            let p = &cands[pid as usize];
            let gap = maxf(self.margin[c.item as usize], self.margin[ju]);
            if dy.label_labels.is_hard() && c.label_overlaps_gap(p, gap) {
                return Some(ju);
            }
            if dy.leader_labels.is_hard()
                && c.leaders.iter().any(|l| leader_hits_label(l, &p.rect, gap))
            {
                return Some(ju);
            }
        }
        if self.segs.len() > self.free_segs.len() {
            let reach = if c.leaders.is_empty() {
                self.stub_gap
            } else {
                maxf(self.leader_reach(obs), self.stub_gap)
            };
            self.seg_ix
                .query(&bb.inflate(EPS * 2.0 + reach), &mut self.buf);
            self.seen.clear();
            for k in 0..self.buf.len() {
                let j = self.segs[self.buf[k] as usize].0;
                let ju = j as usize;
                if ju == skip || !pred(ju) || self.seen.contains(&j) {
                    continue;
                }
                self.seen.push(j);
                let p = &cands[self.placed[ju].expect("placed leader") as usize];
                if self.leaders_hit(c, p, dy, ju) {
                    return Some(ju);
                }
            }
        }
        if self.lower.is_some() {
            let mut hit = Vec::new();
            self.lower_conflicts(c, cands, skip, &pred, true, &mut hit);
            return hit.first().map(|&j| j as usize);
        }
        None
    }

    /// Soft costs of `c` against placed labels and leaders.
    #[allow(clippy::too_many_arguments)]
    pub fn dynamic_cost(
        &mut self,
        c: &Cand,
        cands: &[Cand],
        obs: &Obstacles,
        buffer: f64,
        clearance: f64,
        leader_w: f64,
        skip: usize,
    ) -> f64 {
        let dy = &obs.dynamic;
        let need_labels = matches!(dy.label_labels, AvoidW::Soft(_))
            || dy.buffer_labels > 0.0
            || matches!(dy.leader_labels, AvoidW::Soft(_));
        let has_segs = self.segs.len() > self.free_segs.len();
        let need_leaders = has_segs
            && (dy.buffer_leaders > 0.0
                || matches!(dy.leader_labels, AvoidW::Soft(_))
                || !c.leaders.is_empty());
        if !need_labels && !need_leaders {
            return 0.0;
        }
        let mut cost = 0.0;
        let r = c.rect;
        let area = maxf(r.area(), 1e-9);
        // covered em² and em, as the static terms (spec §8)
        let em = self.em[c.item as usize];
        let em2 = em * em;
        let ring = r.inflate(buffer);
        let ring_area = maxf(ring.area() - area, 1e-9);
        if need_labels {
            self.label_ix.query(&ring.union(&c.bbox()), &mut self.buf);
            for &j in &self.buf {
                if j as usize == skip {
                    continue;
                }
                let Some(pid) = self.placed[j as usize] else {
                    continue;
                };
                let p = &cands[pid as usize];
                if let AvoidW::Soft(w) = dy.label_labels {
                    cost += w * r.overlap_area(&p.rect) / em2;
                }
                if dy.buffer_labels > 0.0 {
                    cost += dy.buffer_labels
                        * maxf(ring.overlap_area(&p.rect) - r.overlap_area(&p.rect), 0.0)
                        / ring_area;
                }
                if let AvoidW::Soft(w) = dy.leader_labels {
                    for l in &c.leaders {
                        for (a, b) in l.segments() {
                            cost += w * seg_len_in_rect(a, b, &p.rect) / em;
                        }
                    }
                }
            }
        }
        if need_leaders {
            let reach = maxf(buffer, clearance);
            self.seg_ix.query(&c.bbox().inflate(reach), &mut self.buf);
            for &s in &self.buf {
                let (j, a, b) = self.segs[s as usize];
                if j as usize == skip {
                    continue;
                }
                if dy.buffer_leaders > 0.0 {
                    let in_ring = maxf(
                        seg_len_in_rect(a, b, &ring) - seg_len_in_rect(a, b, &r),
                        0.0,
                    );
                    cost += dy.buffer_leaders * in_ring * maxf(leader_w, 1.0) / ring_area;
                }
                if let AvoidW::Soft(w) = dy.leader_labels {
                    cost += w * seg_len_in_rect(a, b, &r) * maxf(leader_w, 1.0) / em2;
                }
                for l in &c.leaders {
                    for (p, q) in l.segments() {
                        let d = seg_seg_dist(a, b, p, q);
                        if d <= EPS {
                            if let AvoidW::Soft(w) = dy.leader_leaders {
                                cost += w;
                            }
                        } else if d < clearance && dy.buffer_leaders > 0.0 {
                            cost += dy.buffer_leaders * (1.0 - d / clearance);
                        }
                    }
                }
            }
        }
        cost
    }

    /// Ids of placed items whose labels overlap `r` (no conflict semantics).
    pub fn labels_near(&mut self, r: &Rect, out: &mut Vec<u32>) {
        self.label_ix.query(r, out);
    }
}
