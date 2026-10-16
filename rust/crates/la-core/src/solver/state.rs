//! Placement state: placed candidates, dynamic indexes, exact conflicts and dynamic costs.

use crate::candidates::Cand;
use crate::geom::{seg_intersects, seg_len_in_rect, seg_overlaps_rect, seg_seg_dist, Rect, EPS, P};
use crate::index::DynIndex;
use crate::math::{maxf, minf};
use crate::obstacles::{AvoidW, Obstacles};

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
}

impl State {
    pub fn new(n_items: usize, extent: &Rect, cell: f64) -> State {
        State {
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
        }
    }

    pub fn place(&mut self, item: usize, cid: u32, cands: &[Cand], relaxed: bool) {
        debug_assert!(self.placed[item].is_none());
        let c = &cands[cid as usize];
        self.placed[item] = Some(cid);
        self.relaxed[item] = relaxed;
        self.label_ix.insert(item as u32, c.rect);
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
                self.seg_ix.insert(id, Rect::new(minf(a.x, b.x), minf(a.y, b.y), maxf(a.x, b.x), maxf(a.y, b.y)));
                self.item_segs[item].push(id);
            }
        }
        self.n_placed += 1;
        self.label_area_sum += c.rect.area();
    }

    pub fn unplace(&mut self, item: usize, cands: &[Cand]) {
        let Some(cid) = self.placed[item] else { return };
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
    pub fn conflicts(&mut self, c: &Cand, cands: &[Cand], obs: &Obstacles, skip: usize, out: &mut Vec<u32>) {
        out.clear();
        let dy = &obs.dynamic;
        let bb = c.bbox();
        // labels near the candidate (label-label, candidate leaders through placed labels)
        self.label_ix.query(&bb, &mut self.buf);
        for &j in &self.buf {
            if j as usize == skip {
                continue;
            }
            let Some(pid) = self.placed[j as usize] else { continue };
            let p = &cands[pid as usize];
            if dy.label_labels.is_hard() && c.rect.overlaps(&p.rect) {
                out.push(j);
                continue;
            }
            if dy.leader_labels.is_hard() && c.leaders.iter().any(|l| l.segments().any(|(a, b)| seg_overlaps_rect(a, b, &p.rect))) {
                out.push(j);
            }
        }
        // leader segments near the candidate (placed leaders through the candidate label,
        // leader crossings)
        self.seg_ix.query(&bb.inflate(EPS * 2.0), &mut self.buf);
        for &s in &self.buf {
            let (j, a, b) = self.segs[s as usize];
            if j as usize == skip || out.contains(&j) {
                continue;
            }
            let hit_label = dy.leader_labels.is_hard() && seg_overlaps_rect(a, b, &c.rect);
            let hit_cross = dy.leader_leaders.is_hard()
                && c.leaders.iter().any(|l| l.segments().any(|(p, q)| seg_intersects(a, b, p, q)));
            if hit_label || hit_cross {
                out.push(j);
            }
        }
        out.sort_unstable();
        out.dedup();
    }

    /// Whether candidate `c` conflicts with nothing placed (except `skip`); stops at the
    /// first conflict.
    pub fn is_free(&mut self, c: &Cand, cands: &[Cand], obs: &Obstacles, skip: usize, _scratch: &mut Vec<u32>) -> bool {
        self.first_conflict(c, cands, obs, skip, |_| true).is_none()
    }

    /// The first placed item (in index-query order) that conflicts with `c` and satisfies
    /// `pred`.
    pub fn first_conflict(&mut self, c: &Cand, cands: &[Cand], obs: &Obstacles, skip: usize, pred: impl Fn(usize) -> bool) -> Option<usize> {
        let dy = &obs.dynamic;
        let bb = c.bbox();
        self.label_ix.query(&bb, &mut self.buf);
        for &j in &self.buf {
            let ju = j as usize;
            if ju == skip || !pred(ju) {
                continue;
            }
            let Some(pid) = self.placed[ju] else { continue };
            let p = &cands[pid as usize];
            if dy.label_labels.is_hard() && c.rect.overlaps(&p.rect) {
                return Some(ju);
            }
            if dy.leader_labels.is_hard() && c.leaders.iter().any(|l| l.segments().any(|(a, b)| seg_overlaps_rect(a, b, &p.rect))) {
                return Some(ju);
            }
        }
        if self.segs.len() > self.free_segs.len() {
            self.seg_ix.query(&bb.inflate(EPS * 2.0), &mut self.buf);
            for &s in &self.buf {
                let (j, a, b) = self.segs[s as usize];
                let ju = j as usize;
                if ju == skip || !pred(ju) {
                    continue;
                }
                let hit_label = dy.leader_labels.is_hard() && seg_overlaps_rect(a, b, &c.rect);
                let hit_cross = dy.leader_leaders.is_hard() && c.leaders.iter().any(|l| l.segments().any(|(p, q)| seg_intersects(a, b, p, q)));
                if hit_label || hit_cross {
                    return Some(ju);
                }
            }
        }
        None
    }

    /// Soft costs of `c` against placed labels and leaders.
    pub fn dynamic_cost(&mut self, c: &Cand, cands: &[Cand], obs: &Obstacles, buffer: f64, clearance: f64, leader_w: f64, skip: usize) -> f64 {
        let dy = &obs.dynamic;
        let need_labels = matches!(dy.label_labels, AvoidW::Soft(_)) || dy.buffer_labels > 0.0 || matches!(dy.leader_labels, AvoidW::Soft(_));
        let has_segs = self.segs.len() > self.free_segs.len();
        let need_leaders = has_segs && (dy.buffer_leaders > 0.0 || matches!(dy.leader_labels, AvoidW::Soft(_)) || !c.leaders.is_empty());
        if !need_labels && !need_leaders {
            return 0.0;
        }
        let mut cost = 0.0;
        let r = c.rect;
        let area = maxf(r.area(), 1e-9);
        let ring = r.inflate(buffer);
        let ring_area = maxf(ring.area() - area, 1e-9);
        if need_labels {
            self.label_ix.query(&ring.union(&c.bbox()), &mut self.buf);
            for &j in &self.buf {
                if j as usize == skip {
                    continue;
                }
                let Some(pid) = self.placed[j as usize] else { continue };
                let p = &cands[pid as usize];
                if let AvoidW::Soft(w) = dy.label_labels {
                    cost += w * r.overlap_area(&p.rect) / area;
                }
                if dy.buffer_labels > 0.0 {
                    cost += dy.buffer_labels * maxf(ring.overlap_area(&p.rect) - r.overlap_area(&p.rect), 0.0) / ring_area;
                }
                if let AvoidW::Soft(w) = dy.leader_labels {
                    for l in &c.leaders {
                        for (a, b) in l.segments() {
                            cost += w * seg_len_in_rect(a, b, &p.rect) / maxf(l.len, 1e-9);
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
                    let in_ring = maxf(seg_len_in_rect(a, b, &ring) - seg_len_in_rect(a, b, &r), 0.0);
                    cost += dy.buffer_leaders * in_ring * maxf(leader_w, 1.0) / ring_area;
                }
                if let AvoidW::Soft(w) = dy.leader_labels {
                    cost += w * seg_len_in_rect(a, b, &r) * maxf(leader_w, 1.0) / area;
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
