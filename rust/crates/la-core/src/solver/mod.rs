//! Solver pipeline (spec §10): candidates → greedy with ladder → local search →
//! verification.

pub mod exact;
pub mod greedy;
pub mod local;
pub mod repair;
pub mod state;
pub mod verify;

use crate::candidates::{self, Cand, Kind};
use crate::cost::Evaluator;
use crate::env::Env;
use crate::geom::Rect;
use crate::index::StaticIndex;
use crate::labels::{self, Measurer, Variant};
use crate::model::opts::{Models, Step};
use crate::model::Model;
use crate::obstacles::Obstacles;
use crate::priority::Priorities;
use state::State;

/// Why an item ended up unplaced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    OmittedByPriority,
    NoFeasibleCandidate,
    BudgetExhausted,
    KeepWith,
    Grouped,
}

impl Reason {
    pub fn name(self) -> &'static str {
        match self {
            Reason::OmittedByPriority => "omitted_by_priority",
            Reason::NoFeasibleCandidate => "no_feasible_candidate",
            Reason::BudgetExhausted => "budget_exhausted",
            Reason::KeepWith => "keep_with",
            Reason::Grouped => "grouped",
        }
    }
}

/// Everything the solver works on.
pub struct Solve<'a> {
    pub model: &'a Model,
    pub obs: &'a Obstacles,
    pub env: &'a dyn Env,
    pub pri: &'a Priorities,
    pub measurer: Measurer<'a>,
    pub variants: Vec<Vec<Variant>>,
    pub cands: Vec<Cand>,
    /// Candidate ids per item (all generated levels).
    pub by_item: Vec<Vec<u32>>,
    /// Index of level-0 candidate bounding boxes (for live counts and lookahead).
    pub cand_ix: StaticIndex,
    pub n_level0: usize,
    /// Models in effect per item (grows with the `distant`/`boundary` steps).
    pub models: Vec<Models>,
    pub state: State,
    pub reasons: Vec<Option<Reason>>,
    /// Ladder steps an item went through (placed or not).
    pub steps_tried: Vec<Vec<String>>,
    /// Highest ladder level generated per item.
    pub level_done: Vec<u8>,
    /// Level-0 distant candidates not generated yet (they are created on demand).
    pub distant_pending: Vec<bool>,
    /// Candidates of each item dropped during generation because their box covers an item
    /// mark (reported as `items` among the blocking classes).
    pub static_dropped: Vec<u32>,
    /// The warm-start candidate of each item (see `Solve::generate_warm`).
    pub warm_cand: Vec<Option<u32>>,
    /// Directions of distant candidates (see `leaders::distant_dirs`).
    pub distant_dirs: Vec<(f64, crate::geom::P)>,
    pub iterations: u64,
    pub time_guard_hit: bool,
    /// The host cancelled the solve (sticky once seen; see [`Solve::poll_cancel`]).
    pub cancelled: bool,
    pub start_ms: f64,
}

impl<'a> Solve<'a> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        model: &'a Model,
        obs: &'a Obstacles,
        env: &'a dyn Env,
        pri: &'a Priorities,
        measurer: Measurer<'a>,
        variants: Vec<Vec<Variant>>,
        start_ms: f64,
    ) -> Solve<'a> {
        let n = model.items.len();
        Solve {
            model,
            obs,
            env,
            pri,
            measurer,
            variants,
            cands: Vec::new(),
            by_item: vec![Vec::new(); n],
            cand_ix: StaticIndex::new(vec![], &model.extent, obs.index_cell),
            n_level0: 0,
            models: model.items.iter().map(|it| it.models).collect(),
            state: State::new(
                n,
                &model.extent,
                obs.index_cell,
                pri.prio.iter().map(|p| p.key).collect(),
            ),
            reasons: vec![None; n],
            steps_tried: vec![Vec::new(); n],
            level_done: vec![0; n],
            distant_pending: vec![false; n],
            warm_cand: vec![None; n],
            static_dropped: vec![0; n],
            distant_dirs: crate::leaders::distant_dirs(model),
            iterations: 0,
            time_guard_hit: false,
            cancelled: false,
            start_ms,
        }
    }

    /// Generate and evaluate candidates for `variants[vi_range]` of item `i` with `models`.
    pub fn generate(&mut self, i: usize, vis: &[usize], models: Models, level: u8) -> Vec<u32> {
        if matches!(self.model.group_of.get(i), Some(Some(r)) if *r != i) {
            return vec![];
        }
        self.generate_mode(i, vis, models, level, false)
    }

    /// Statically evaluate candidate `cid` if it is not evaluated yet.
    pub fn ensure_eval(&mut self, cid: u32) {
        if self.cands[cid as usize].evaluated {
            return;
        }
        let mut c = std::mem::replace(
            &mut self.cands[cid as usize],
            Cand::new(
                0,
                0,
                0,
                Kind::Adjacent,
                candidates::Side::Internal,
                0.0,
                crate::geom::Rect::EMPTY,
            ),
        );
        let v = &self.variants[c.item as usize][c.variant as usize];
        Evaluator::new(self.model, self.obs, self.env).eval(&mut c, v, None);
        self.cands[cid as usize] = c;
    }

    /// `lazy`: skip static evaluation and pruning (ladder candidates; see `ensure_eval`).
    pub fn generate_mode(
        &mut self,
        i: usize,
        vis: &[usize],
        models: Models,
        level: u8,
        lazy: bool,
    ) -> Vec<u32> {
        let item = &self.model.items[i];
        // While labels are placed (ladder steps, on-demand distant candidates), candidates
        // blocked (hard) by a placed label or leader of higher or equal priority are
        // dropped (spec §6.7): they cannot be used while that label stays, and they can
        // never be evict_lower targets or witnesses of a priority inversion (those only
        // involve strictly lower-priority labels). The occupancy grid rejects most of them
        // before their leaders are built; the exact test below decides the rest.
        let key_i = self.pri.prio[i].key;
        let filter = self.state.n_placed > 0;
        let quick = filter
            && self.obs.dynamic.label_labels.is_hard()
            && self.state.max_placed_key().is_some_and(|k| k <= key_i);
        let state = &self.state;
        let variants = &self.variants[i];
        let item_occ = self.obs.item_occ.as_ref();
        let occ = state.occupancy();
        // both grids cover the model extent with the same cells: one window serves both
        let shared = item_occ.is_none_or(|o| o.same_cells(occ));
        let dropped = std::cell::Cell::new(0u32);
        // `keep` serves non-internal candidates only (internal labels sit on their mark)
        let keep = |vi: usize, r: &Rect| {
            if !(quick || item_occ.is_some()) || !candidates::is_rect_shape(&variants[vi].shape) {
                return true;
            }
            let w = occ.window(r);
            if let Some(o) = item_occ {
                let hit = if shared {
                    w.is_some_and(|w| o.blocked_in(&w))
                } else {
                    o.blocked(r)
                };
                if hit {
                    dropped.set(dropped.get() + 1);
                    return false;
                }
            }
            !(quick && state.n_placed > 0 && w.is_some_and(|w| occ.blocked_in(&w)))
        };
        let mut fresh: Vec<Cand> = Vec::new();
        for &vi in vis {
            let v = &variants[vi];
            let start = fresh.len();
            if item.area.is_some() {
                // area anchors: internal candidates first; external ones around the dot
                if let Some(rank) = candidates::internal_rank(
                    item,
                    v,
                    models,
                    self.model.placement.internal_circle_ratio,
                ) {
                    candidates::internal(item, vi, v, rank, &mut fresh);
                }
                candidates::adjacent(
                    item,
                    vi,
                    v,
                    self.model.placement.slider_per_gap,
                    models,
                    &mut fresh,
                );
            } else {
                candidates::adjacent(
                    item,
                    vi,
                    v,
                    self.model.placement.slider_per_gap,
                    models,
                    &mut fresh,
                );
                if let Some(rank) = candidates::internal_rank(
                    item,
                    v,
                    models,
                    self.model.placement.internal_circle_ratio,
                ) {
                    candidates::internal(item, vi, v, rank, &mut fresh);
                }
            }
            if quick || item_occ.is_some() {
                let mut w = start;
                for r in start..fresh.len() {
                    if fresh[r].kind == Kind::Internal || keep(vi, &fresh[r].rect) {
                        fresh.swap(w, r);
                        w += 1;
                    }
                }
                fresh.truncate(w);
            }
            if models.has(Models::DISTANT) {
                crate::leaders::distant(
                    self.model,
                    self.obs,
                    item,
                    vi,
                    v,
                    &self.distant_dirs,
                    &keep,
                    &mut fresh,
                );
            }
        }
        if models.has(Models::BOUNDARY) {
            crate::boundary::boundary_candidates(
                self.model, self.obs, item, variants, vis, &keep, &mut fresh,
            );
        }
        self.static_dropped[i] += dropped.get();
        for c in &mut fresh {
            c.level = level;
            c.lshape = candidates::label_shape(&c.rect, &variants[c.variant as usize].shape);
        }
        if filter {
            let prio = &self.pri.prio;
            let (state, cands, obs) = (&mut self.state, &self.cands, self.obs);
            fresh.retain(|c| {
                state
                    .first_conflict(c, cands, obs, i, |j| prio[j].key <= key_i)
                    .is_none()
            });
        }
        if lazy {
            let mut ids = Vec::with_capacity(fresh.len());
            for c in fresh {
                ids.push(self.cands.len() as u32);
                self.cands.push(c);
            }
            self.by_item[i].extend_from_slice(&ids);
            return ids;
        }
        let mut ev = Evaluator::new(self.model, self.obs, self.env);
        for c in &mut fresh {
            let v = &self.variants[c.item as usize][c.variant as usize];
            ev.eval(c, v, None);
        }
        // keep the k_distant cheapest distant candidates per variant
        let kd = self.model.placement.k_distant;
        let mut keep = vec![true; fresh.len()];
        for &vi in vis {
            let mut ds: Vec<usize> = (0..fresh.len())
                .filter(|&k| fresh[k].variant as usize == vi && fresh[k].kind == Kind::Distant)
                .collect();
            ds.sort_by(|&a, &b| {
                let ka = (!fresh[a].feasible, fresh[a].cost);
                let kb = (!fresh[b].feasible, fresh[b].cost);
                ka.0.cmp(&kb.0)
                    .then(crate::math::cmp_f64(ka.1, kb.1))
                    .then(a.cmp(&b))
            });
            for &k in ds.iter().skip(kd) {
                keep[k] = false;
            }
        }
        // prune expensive feasible candidates
        let best = fresh
            .iter()
            .zip(&keep)
            .filter(|(c, k)| **k && c.feasible)
            .map(|(c, _)| c.cost)
            .fold(f64::INFINITY, f64::min);
        if best.is_finite() {
            let lim = self.model.placement.prune_factor * best.abs() + 1.0 + best.min(0.0);
            for (k, c) in fresh.iter().enumerate() {
                if c.feasible && c.cost > lim {
                    keep[k] = false;
                }
            }
        }
        let mut ids = Vec::new();
        for (c, k) in fresh.into_iter().zip(keep) {
            if k {
                ids.push(self.cands.len() as u32);
                self.cands.push(c);
            }
        }
        self.by_item[i].extend_from_slice(&ids);
        ids
    }

    /// Level-0 candidates of all items, then the candidate index. Distant candidates are
    /// generated on demand (see [`Solve::ensure_distant`]).
    pub fn generate_level0(&mut self) {
        let n = self.model.items.len();
        for i in 0..n {
            let vis: Vec<usize> = (0..self.variants[i].len()).collect();
            let m = self.models[i];
            self.distant_pending[i] = m.has(Models::DISTANT);
            self.generate(i, &vis, Models(m.0 & !Models::DISTANT), 0);
            self.generate_warm(i);
        }
        // auto preset: enable distant labels when crowded
        if let Some((frac, crowded_models)) = self.model.auto_crowded {
            let lacking = (0..n)
                .filter(|&i| {
                    !self.by_item[i].iter().any(|&c| {
                        let c = &self.cands[c as usize];
                        c.feasible
                            && matches!(c.kind, Kind::Adjacent | Kind::Slider | Kind::Internal)
                    })
                })
                .count();
            if n > 0 && lacking as f64 > frac * n as f64 {
                for i in 0..n {
                    let add = Models(crowded_models.0 & !self.models[i].0);
                    if add.0 != 0 {
                        self.models[i] = Models(self.models[i].0 | add.0);
                        if add.has(Models::DISTANT) {
                            self.distant_pending[i] = true;
                        }
                        let rest = Models(add.0 & !Models::DISTANT);
                        if rest.0 != 0 {
                            let vis: Vec<usize> = (0..self.variants[i].len()).collect();
                            self.generate(i, &vis, rest, 0);
                        }
                    }
                }
            }
        }
        self.n_level0 = self.cands.len();
        self.cand_ix = StaticIndex::new(
            self.cands.iter().map(|c| c.bbox()).collect(),
            &self.model.extent,
            self.obs.index_cell,
        );
    }

    /// The warm-start box of item `i` as an extra level-0 candidate (kept when statically
    /// feasible), for the variant of the same size.
    fn generate_warm(&mut self, i: usize) {
        let item = &self.model.items[i];
        let Some(Some(b)) = self.model.warm.get(&item.id) else {
            return;
        };
        if matches!(self.model.group_of.get(i), Some(Some(r)) if *r != i) {
            return;
        }
        let Some(vi) = self.variants[i]
            .iter()
            .position(|v| (v.w - b.w()).abs() <= 0.5 && (v.h - b.h()).abs() <= 0.5)
        else {
            return;
        };
        let v = &self.variants[i][vi];
        let Some(mut c) = candidates::warm(self.model, item, vi, v, *b) else {
            return;
        };
        c.level = 0;
        c.lshape = candidates::label_shape(&c.rect, &v.shape);
        Evaluator::new(self.model, self.obs, self.env).eval(&mut c, v, None);
        if c.feasible {
            self.warm_cand[i] = Some(self.cands.len() as u32);
            self.by_item[i].push(self.cands.len() as u32);
            self.cands.push(c);
        }
    }

    /// Generate the pending level-0 distant candidates of item `i` (once).
    pub fn ensure_distant(&mut self, i: usize) -> Vec<u32> {
        if !self.distant_pending[i] {
            return vec![];
        }
        self.distant_pending[i] = false;
        let vis: Vec<usize> = (0..self.variants[i].len())
            .filter(|&v| self.variants[i][v].level == 0)
            .collect();
        self.generate(i, &vis, Models(Models::DISTANT), 0)
    }

    /// Lower bound of the static cost of any leadered candidate of item `i`.
    pub fn leader_cost_bound(&self, i: usize) -> f64 {
        let w = &self.model.weights;
        let it = &self.model.items[i];
        w.leader + w.leader_length * it.len.leader_min / it.em() + w.position
    }

    /// Run ladder step `si` for item `i`: create its variants/candidates (once) and
    /// return the new candidate ids.
    pub fn ladder_candidates(&mut self, i: usize, si: usize) -> Vec<u32> {
        let level = (si + 1) as u8;
        if self.level_done[i] >= level {
            return self.by_item[i]
                .iter()
                .copied()
                .filter(|&c| self.cands[c as usize].level == level)
                .collect();
        }
        self.level_done[i] = level;
        let step = self.model.ladder[si];
        let item = &self.model.items[i];
        match step {
            Step::Alternatives | Step::Wrap | Step::Truncate | Step::Shrink(_) => {
                let new = labels::ladder_variants(
                    &self.measurer,
                    item,
                    &step,
                    &self.variants[i],
                    self.model.degrade.min_scale,
                    self.model.degrade.wrap_max_lines,
                );
                if new.is_empty() {
                    return vec![];
                }
                let start = self.variants[i].len();
                for mut v in new {
                    v.level = level;
                    self.variants[i].push(v);
                }
                let vis: Vec<usize> = (start..self.variants[i].len()).collect();
                let m = self.models[i];
                self.generate_mode(i, &vis, m, level, true)
            }
            Step::Distant => {
                if self.models[i].has(Models::DISTANT) {
                    return self.ensure_distant(i);
                }
                self.models[i] = self.models[i].with(Models::DISTANT);
                let vis: Vec<usize> = (0..self.variants[i].len()).collect();
                self.generate_mode(i, &vis, Models(Models::DISTANT), level, true)
            }
            Step::Boundary => {
                if self.models[i].has(Models::BOUNDARY) {
                    return vec![];
                }
                self.models[i] = self.models[i].with(Models::BOUNDARY);
                let vis: Vec<usize> = (0..self.variants[i].len()).collect();
                self.generate_mode(i, &vis, Models(Models::BOUNDARY), level, true)
            }
            _ => vec![],
        }
    }

    pub fn now(&self) -> f64 {
        self.env.now_ms()
    }

    /// Poll the host's cancellation request (`Env::cancelled`); once set it stays set.
    /// The solver then stops improving and returns the best valid state so far.
    pub fn poll_cancel(&mut self) -> bool {
        if !self.cancelled && self.env.cancelled() {
            self.cancelled = true;
        }
        self.cancelled
    }
}
