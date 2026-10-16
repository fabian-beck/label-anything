//! Solver pipeline (spec §10): candidates → greedy with ladder → local search →
//! verification.

pub mod greedy;
pub mod local;
pub mod state;
pub mod verify;

use crate::candidates::{self, Cand, Kind};
use crate::cost::Evaluator;
use crate::env::Env;
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
    pub iterations: u64,
    pub time_guard_hit: bool,
    pub start_ms: f64,
}

impl<'a> Solve<'a> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(model: &'a Model, obs: &'a Obstacles, env: &'a dyn Env, pri: &'a Priorities, measurer: Measurer<'a>, variants: Vec<Vec<Variant>>, start_ms: f64) -> Solve<'a> {
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
            state: State::new(n, &model.extent, obs.index_cell),
            reasons: vec![None; n],
            steps_tried: vec![Vec::new(); n],
            level_done: vec![0; n],
            distant_pending: vec![false; n],
            iterations: 0,
            time_guard_hit: false,
            start_ms,
        }
    }

    /// Generate and evaluate candidates for `variants[vi_range]` of item `i` with `models`.
    pub fn generate(&mut self, i: usize, vis: &[usize], models: Models, level: u8) -> Vec<u32> {
        self.generate_mode(i, vis, models, level, false)
    }

    /// Statically evaluate candidate `cid` if it is not evaluated yet.
    pub fn ensure_eval(&mut self, cid: u32) {
        if self.cands[cid as usize].evaluated {
            return;
        }
        let mut c = std::mem::replace(&mut self.cands[cid as usize], Cand::new(0, 0, 0, Kind::Adjacent, candidates::Side::Internal, 0.0, crate::geom::Rect::EMPTY));
        let v = &self.variants[c.item as usize][c.variant as usize];
        Evaluator::new(self.model, self.obs, self.env).eval(&mut c, v, None);
        self.cands[cid as usize] = c;
    }

    /// `lazy`: skip static evaluation and pruning (ladder candidates; see `ensure_eval`).
    pub fn generate_mode(&mut self, i: usize, vis: &[usize], models: Models, level: u8, lazy: bool) -> Vec<u32> {
        let item = &self.model.items[i];
        let mut fresh: Vec<Cand> = Vec::new();
        for &vi in vis {
            let v = &self.variants[i][vi];
            if item.area.is_some() {
                // area anchors: internal candidates first; external ones around the dot
                if let Some(rank) = candidates::internal_rank(item, v, models, self.model.placement.internal_circle_ratio) {
                    candidates::internal(item, vi, v, rank, &mut fresh);
                }
                candidates::adjacent(item, vi, v, self.model.placement.slider_per_gap, models, &mut fresh);
            } else {
                candidates::adjacent(item, vi, v, self.model.placement.slider_per_gap, models, &mut fresh);
                if let Some(rank) = candidates::internal_rank(item, v, models, self.model.placement.internal_circle_ratio) {
                    candidates::internal(item, vi, v, rank, &mut fresh);
                }
            }
            if models.has(Models::DISTANT) {
                crate::leaders::distant(self.model, self.obs, item, vi, v, &mut fresh);
            }
        }
        if models.has(Models::BOUNDARY) {
            crate::boundary::boundary_candidates(self.model, self.obs, item, &self.variants[i], vis, &mut fresh);
        }
        for c in &mut fresh {
            c.level = level;
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
            let mut ds: Vec<usize> = (0..fresh.len()).filter(|&k| fresh[k].variant as usize == vi && fresh[k].kind == Kind::Distant).collect();
            ds.sort_by(|&a, &b| {
                let ka = (!fresh[a].feasible, fresh[a].cost);
                let kb = (!fresh[b].feasible, fresh[b].cost);
                ka.0.cmp(&kb.0).then(crate::math::cmp_f64(ka.1, kb.1)).then(a.cmp(&b))
            });
            for &k in ds.iter().skip(kd) {
                keep[k] = false;
            }
        }
        // prune expensive feasible candidates
        let best = fresh.iter().zip(&keep).filter(|(c, k)| **k && c.feasible).map(|(c, _)| c.cost).fold(f64::INFINITY, f64::min);
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
        }
        // auto preset: enable distant labels when crowded
        if let Some((frac, crowded_models)) = self.model.auto_crowded {
            let lacking = (0..n)
                .filter(|&i| !self.by_item[i].iter().any(|&c| {
                    let c = &self.cands[c as usize];
                    c.feasible && matches!(c.kind, Kind::Adjacent | Kind::Slider | Kind::Internal)
                }))
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
        self.cand_ix = StaticIndex::new(self.cands.iter().map(|c| c.bbox()).collect(), &self.model.extent, self.obs.index_cell);
    }

    /// Generate the pending level-0 distant candidates of item `i` (once).
    pub fn ensure_distant(&mut self, i: usize) -> Vec<u32> {
        if !self.distant_pending[i] {
            return vec![];
        }
        self.distant_pending[i] = false;
        let vis: Vec<usize> = (0..self.variants[i].len()).filter(|&v| self.variants[i][v].level == 0).collect();
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
            return self.by_item[i].iter().copied().filter(|&c| self.cands[c as usize].level == level).collect();
        }
        self.level_done[i] = level;
        let step = self.model.ladder[si];
        let item = &self.model.items[i];
        match step {
            Step::Alternatives | Step::Wrap | Step::Truncate | Step::Shrink(_) => {
                let new = labels::ladder_variants(&self.measurer, item, &step, &self.variants[i], self.model.degrade.min_scale, self.model.degrade.wrap_max_lines);
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
}
