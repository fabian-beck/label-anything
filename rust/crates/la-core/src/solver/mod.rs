//! Solver pipeline (spec §10): candidates → greedy with ladder → local search →
//! verification.

pub mod exact;
pub mod fan;
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
    /// The warm-start candidate of each item for a ladder variant, once computed (see
    /// [`Solve::warm_ladder_candidate`]).
    pub warm_ladder: Vec<Option<Option<u32>>>,
    /// The warm-start box of each item with its level-0 variant, feasible or not (for
    /// nudges, see [`Solve::warm_nudges`]).
    pub warm_box: Vec<Option<(usize, Rect)>>,
    /// The nudged warm-start candidates of each item with their step index, once made.
    pub warm_nudge: Vec<Option<Vec<(usize, u32)>>>,
    /// Directions of distant candidates (see `leaders::distant_dirs`).
    pub distant_dirs: Vec<(f64, crate::geom::P)>,
    /// Free-space seeds near each item (`leaders::item_seeds`), once needed.
    pub seeds: Vec<Option<Vec<crate::leaders::NearSeed>>>,
    /// Statically feasible candidates of unplaced items that the placed-label filter had
    /// dropped (see [`Solve::feasible_unfiltered`]); explanations only.
    pub blocked_feasible: Vec<Vec<Cand>>,
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
                model.items.iter().map(|it| it.len.clearance).collect(),
                model.items.iter().map(|it| it.em()).collect(),
                model.items.iter().map(|it| it.len.margin).collect(),
                if model.leaders.min_angle_between > 0.0 {
                    la_expr::det_math::cos_deg(model.leaders.min_angle_between)
                } else {
                    1.0
                },
            ),
            reasons: vec![None; n],
            steps_tried: vec![Vec::new(); n],
            level_done: vec![0; n],
            distant_pending: vec![false; n],
            warm_cand: vec![None; n],
            warm_ladder: vec![None; n],
            warm_box: vec![None; n],
            warm_nudge: vec![None; n],
            static_dropped: vec![0; n],
            distant_dirs: crate::leaders::distant_dirs(model),
            seeds: vec![None; n],
            blocked_feasible: vec![Vec::new(); n],
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

    /// Up to `k` statically feasible candidates of item `i` (or, with the `soft_overlap`
    /// step, relaxed-feasible ones) among those that the placed-label filter of
    /// [`Solve::generate_mode`] may have dropped, generated again without that filter, in
    /// generation order: the distant candidates and the models added by ladder steps of the
    /// item's level-0 variants, and every candidate of its ladder variants. For the
    /// explanation of an omitted item (spec §9.3) whose kept candidates all violate a
    /// static hard constraint: it was blocked by placed labels when one of these exists.
    pub fn feasible_unfiltered(&mut self, i: usize, k: usize) -> Vec<Cand> {
        let item = &self.model.items[i];
        let models = self.models[i];
        if models.has(Models::DISTANT)
            && self.model.placement.free_space_seeds
            && self.seeds[i].is_none()
        {
            let fs = self.obs.free_space(self.model);
            self.seeds[i] = Some(crate::leaders::item_seeds(fs, item));
        }
        // level-0 variants: their adjacent, slider, internal and boundary candidates were
        // generated before any label was placed (all kept); distant candidates on demand
        let level0 = Models((models.0 & !item.models.0) | (models.0 & Models::DISTANT));
        let soft_ok = self.model.ladder.contains(&Step::SoftOverlap);
        let mut ev = Evaluator::new(self.model, self.obs, self.env);
        let mut out = Vec::new();
        for vi in 0..self.variants[i].len() {
            let v = &self.variants[i][vi];
            let m = if v.level == 0 { level0 } else { models };
            if m.0 == 0 {
                continue;
            }
            let (fresh, _) = raw_candidates(
                self.model,
                self.obs,
                item,
                &self.variants[i],
                &[vi],
                m,
                v.level,
                self.seeds[i].as_deref().unwrap_or(&[]),
                &self.distant_dirs,
                None,
            );
            for mut c in fresh {
                ev.eval(&mut c, v, None);
                if c.feasible || (soft_ok && c.relaxed) {
                    out.push(c);
                    if out.len() == k {
                        return out;
                    }
                }
            }
        }
        out
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
        if models.has(Models::DISTANT)
            && self.model.placement.free_space_seeds
            && self.seeds[i].is_none()
        {
            let fs = self.obs.free_space(self.model);
            self.seeds[i] = Some(crate::leaders::item_seeds(fs, item));
        }
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
        let (mut fresh, dropped) = raw_candidates(
            self.model,
            self.obs,
            item,
            &self.variants[i],
            vis,
            models,
            level,
            self.seeds[i].as_deref().unwrap_or(&[]),
            &self.distant_dirs,
            quick.then(|| self.state.occupancy()),
        );
        self.static_dropped[i] += dropped;
        if filter {
            let prio = &self.pri.prio;
            let (state, cands, obs) = (&mut self.state, &self.cands, self.obs);
            fresh.retain(|c| {
                state
                    .first_conflict(c, cands, obs, i, |j| prio[j].key <= key_i)
                    .is_none()
            });
        }
        if !lazy {
            fresh = evaluate_and_prune(
                self.model,
                self.obs,
                self.env,
                &self.variants[i],
                vis,
                fresh,
            );
        }
        let mut ids = Vec::with_capacity(fresh.len());
        for c in fresh {
            ids.push(self.cands.len() as u32);
            self.cands.push(c);
        }
        self.by_item[i].extend_from_slice(&ids);
        ids
    }

    /// Level-0 candidates of all items, then the candidate index. Distant candidates are
    /// generated on demand (see [`Solve::ensure_distant`]).
    pub fn generate_level0(&mut self) {
        let n = self.model.items.len();
        // no label is placed yet, so the candidates of every item depend on the item
        // alone: generated per item (in parallel with the `parallel` feature, unless the
        // host evaluates costs itself) and numbered in item order
        let (model, obs, variants, dirs) =
            (self.model, self.obs, &self.variants, &self.distant_dirs);
        let models: Vec<Models> = self
            .models
            .iter()
            .map(|m| Models(m.0 & !Models::DISTANT))
            .collect();
        let per_item = |env: &dyn Env, i: usize| -> (Vec<Cand>, u32, Option<Cand>) {
            if matches!(model.group_of.get(i), Some(Some(r)) if *r != i) {
                return (Vec::new(), 0, None);
            }
            let item = &model.items[i];
            let vis: Vec<usize> = (0..variants[i].len()).collect();
            let (fresh, dropped) = raw_candidates(
                model,
                obs,
                item,
                &variants[i],
                &vis,
                models[i],
                0,
                &[],
                dirs,
                None,
            );
            let kept = evaluate_and_prune(model, obs, env, &variants[i], &vis, fresh);
            (
                kept,
                dropped,
                warm_candidate(model, obs, env, item, &variants[i]),
            )
        };
        let generated: Vec<(Vec<Cand>, u32, Option<Cand>)> = if self.env.has_cost_callback() {
            let env = self.env;
            (0..n).map(|i| per_item(env, i)).collect()
        } else {
            // without host callbacks the evaluation does not use the environment
            crate::par::map(n, |i| per_item(&crate::env::BasicEnv, i))
        };
        for (i, (kept, dropped, warm)) in generated.into_iter().enumerate() {
            self.warm_box[i] = warm_variant(self.model, &self.model.items[i], &self.variants[i]);
            self.distant_pending[i] = self.models[i].has(Models::DISTANT);
            self.static_dropped[i] += dropped;
            for c in kept {
                self.by_item[i].push(self.cands.len() as u32);
                self.cands.push(c);
            }
            if let Some(c) = warm {
                self.warm_cand[i] = Some(self.cands.len() as u32);
                self.by_item[i].push(self.cands.len() as u32);
                self.cands.push(c);
            }
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

    /// The warm box of item `i` as a candidate of the ladder variant of its size, when no
    /// level-0 variant has that size (the previous solve degraded the label): the ladder
    /// steps run in order, as the ladder would run them, until one creates a variant of
    /// that size. Like the level-0 warm candidate (`warm_candidate`), it is slider-kind or
    /// distant with a straight leader, and only statically feasible ones count. Computed
    /// once per item.
    pub fn warm_ladder_candidate(&mut self, i: usize) -> Option<u32> {
        if let Some(c) = self.warm_ladder[i] {
            return c;
        }
        self.warm_ladder[i] = Some(None);
        let Some(Some(b)) = self.model.warm.get(&self.model.items[i].id) else {
            return None;
        };
        let b = *b;
        let same = |v: &Variant| (v.w - b.w()).abs() <= 0.5 && (v.h - b.h()).abs() <= 0.5;
        if self.variants[i].iter().any(|v| v.level == 0 && same(v)) {
            return None;
        }
        let steps = self.model.ladder.clone();
        for (si, step) in steps.iter().enumerate() {
            match step {
                Step::Omit => break,
                Step::EvictLower | Step::SoftOverlap => continue,
                _ => {}
            }
            let level = (si + 1) as u8;
            self.ladder_candidates(i, si);
            if !matches!(
                step,
                Step::Alternatives | Step::Wrap | Step::Truncate | Step::Shrink(_)
            ) {
                continue;
            }
            let Some(vi) = (0..self.variants[i].len())
                .find(|&k| self.variants[i][k].level == level && same(&self.variants[i][k]))
            else {
                continue;
            };
            let item = &self.model.items[i];
            let v = &self.variants[i][vi];
            let mut c = candidates::warm(self.model, item, vi, v, b)?;
            c.warm = true;
            c.level = level;
            c.lshape = candidates::label_shape(&c.rect, &v.shape);
            Evaluator::new(self.model, self.obs, self.env).eval(&mut c, v, None);
            if !c.feasible {
                return None;
            }
            let id = self.cands.len() as u32;
            self.by_item[i].push(id);
            self.cands.push(c);
            self.warm_ladder[i] = Some(Some(id));
            return Some(id);
        }
        None
    }

    /// The warm-start box of item `i` nudged along its slider path (steps of 0.05, 0.1,
    /// 0.2, 0.4 and 0.8 em, both ways), as statically feasible level-0 candidates with
    /// their step index; made once.
    pub fn warm_nudges(&mut self, i: usize) -> Vec<(usize, u32)> {
        if let Some(ids) = &self.warm_nudge[i] {
            return ids.clone();
        }
        let mut ids = Vec::new();
        if let Some((vi, rect)) = self.warm_box[i] {
            let item = &self.model.items[i];
            let em = item.em();
            let steps = [0.05 * em, 0.1 * em, 0.2 * em, 0.4 * em, 0.8 * em];
            let v = &self.variants[i][vi];
            for (si, mut c) in candidates::warm_nudges(item, vi, v, rect, &steps, self.models[i]) {
                c.level = 0;
                c.warm = true;
                c.lshape = candidates::label_shape(&c.rect, &v.shape);
                Evaluator::new(self.model, self.obs, self.env).eval(&mut c, v, None);
                if c.feasible {
                    let id = self.cands.len() as u32;
                    self.by_item[i].push(id);
                    self.cands.push(c);
                    ids.push((si, id));
                }
            }
        }
        self.warm_nudge[i] = Some(ids.clone());
        ids
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

/// The candidates of `item` for the variants `vis` with `models` (spec §6), before the
/// dynamic filter and the static evaluation, with the number skipped because their box
/// covers an item mark (`Obstacles::item_occ`). With `placed` (the occupancy of placed
/// labels of higher or equal priority, when labels must not overlap), boxes over a placed
/// label are skipped as well, before their leaders are built.
#[allow(clippy::too_many_arguments)]
fn raw_candidates(
    model: &Model,
    obs: &Obstacles,
    item: &crate::model::Item,
    variants: &[Variant],
    vis: &[usize],
    models: Models,
    level: u8,
    seeds: &[crate::leaders::NearSeed],
    dirs: &[(f64, crate::geom::P)],
    placed: Option<&crate::grid::occupancy::Occupancy>,
) -> (Vec<Cand>, u32) {
    let item_occ = obs.item_occ.as_ref();
    // both grids cover the model extent with the same cells: one window serves both
    let shared = match (item_occ, placed) {
        (Some(o), Some(p)) => o.same_cells(p),
        _ => true,
    };
    let dropped = std::cell::Cell::new(0u32);
    // `keep` serves non-internal candidates only (internal labels sit on their mark)
    let keep = |vi: usize, r: &Rect| {
        if !(placed.is_some() || item_occ.is_some())
            || !candidates::is_rect_shape(&variants[vi].shape)
        {
            return true;
        }
        let w = placed.and_then(|occ| occ.window(r));
        if let Some(o) = item_occ {
            let hit = if placed.is_some() && shared {
                w.is_some_and(|w| o.blocked_in(&w))
            } else {
                o.blocked(r)
            };
            if hit {
                dropped.set(dropped.get() + 1);
                return false;
            }
        }
        !placed.is_some_and(|occ| w.is_some_and(|w| occ.blocked_in(&w)))
    };
    let mut fresh: Vec<Cand> = Vec::new();
    for &vi in vis {
        let v = &variants[vi];
        let start = fresh.len();
        let internal_rank =
            candidates::internal_rank(item, v, models, model.placement.internal_circle_ratio);
        if item.area.is_some() {
            // area anchors: internal candidates first; external ones around the dot
            if let Some(rank) = internal_rank {
                candidates::internal(item, vi, v, rank, &mut fresh);
            }
            candidates::adjacent(
                item,
                vi,
                v,
                model.placement.slider_per_gap,
                models,
                &mut fresh,
            );
        } else {
            candidates::adjacent(
                item,
                vi,
                v,
                model.placement.slider_per_gap,
                models,
                &mut fresh,
            );
            if let Some(rank) = internal_rank {
                candidates::internal(item, vi, v, rank, &mut fresh);
            }
        }
        if placed.is_some() || item_occ.is_some() {
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
            crate::leaders::distant(model, seeds, item, vi, v, dirs, &keep, &mut fresh);
        }
    }
    if models.has(Models::BOUNDARY) {
        crate::boundary::boundary_candidates(model, obs, item, variants, vis, &keep, &mut fresh);
    }
    for c in &mut fresh {
        c.level = level;
        c.lshape = candidates::label_shape(&c.rect, &variants[c.variant as usize].shape);
    }
    (fresh, dropped.get())
}

/// Static evaluation and pruning of an item's fresh candidates (spec §6.7): of the
/// distant candidates the `k_distant` cheapest per variant stay, and feasible candidates
/// costing more than `prune_factor × best + 1` are dropped.
fn evaluate_and_prune(
    model: &Model,
    obs: &Obstacles,
    env: &dyn Env,
    variants: &[Variant],
    vis: &[usize],
    mut fresh: Vec<Cand>,
) -> Vec<Cand> {
    let mut ev = Evaluator::new(model, obs, env);
    for c in &mut fresh {
        ev.eval(c, &variants[c.variant as usize], None);
    }
    // keep the k_distant cheapest distant candidates per variant
    let kd = model.placement.k_distant;
    let mut keep = vec![true; fresh.len()];
    for &vi in vis {
        let mut ds: Vec<usize> = (0..fresh.len())
            .filter(|&k| fresh[k].variant as usize == vi && fresh[k].kind == Kind::Distant)
            .collect();
        crate::sort::sort_by(&mut ds, |&a, &b| {
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
        let lim = model.placement.prune_factor * best.abs() + 1.0 + best.min(0.0);
        for (k, c) in fresh.iter().enumerate() {
            if c.feasible && c.cost > lim {
                keep[k] = false;
            }
        }
    }
    fresh
        .into_iter()
        .zip(keep)
        .filter_map(|(c, k)| k.then_some(c))
        .collect()
}

/// The level-0 variant of an item's warm-start box (width and height within 0.5 px) and
/// the box; none for the non-representative members of a group.
fn warm_variant(
    model: &Model,
    item: &crate::model::Item,
    variants: &[Variant],
) -> Option<(usize, Rect)> {
    if matches!(model.group_of.get(item.index), Some(Some(r)) if *r != item.index) {
        return None;
    }
    let Some(Some(b)) = model.warm.get(&item.id) else {
        return None;
    };
    let vi = variants
        .iter()
        .position(|v| v.level == 0 && (v.w - b.w()).abs() <= 0.5 && (v.h - b.h()).abs() <= 0.5)?;
    Some((vi, *b))
}

/// The warm-start box of an item as an extra level-0 candidate (when statically
/// feasible), for the variant of the same size.
fn warm_candidate(
    model: &Model,
    obs: &Obstacles,
    env: &dyn Env,
    item: &crate::model::Item,
    variants: &[Variant],
) -> Option<Cand> {
    let Some(Some(b)) = model.warm.get(&item.id) else {
        return None;
    };
    let vi = variants
        .iter()
        .position(|v| (v.w - b.w()).abs() <= 0.5 && (v.h - b.h()).abs() <= 0.5)?;
    let v = &variants[vi];
    let mut c = candidates::warm(model, item, vi, v, *b)?;
    c.warm = true;
    c.level = 0;
    c.lshape = candidates::label_shape(&c.rect, &v.shape);
    Evaluator::new(model, obs, env).eval(&mut c, v, None);
    c.feasible.then_some(c)
}
