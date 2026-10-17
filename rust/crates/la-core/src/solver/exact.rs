//! Exact search (spec §5.6 "exact"): branch and bound over items in priority order on the
//! candidate conflict graph (a maximum-weight independent set). The objective is the
//! omission mode's priority objective, then the total static cost. The search is limited
//! by a node budget (deterministic) and never returns worse than the incumbent.

use super::{greedy::pair_conflict, Reason, Solve};
use crate::model::opts::Omission;

/// Objective: lexicographic priority vector (larger is better), then cost (smaller).
#[derive(Clone, Debug, PartialEq)]
struct Obj {
    prio: Vec<f64>,
    cost: f64,
}

impl Obj {
    fn better(&self, o: &Obj) -> bool {
        for (a, b) in self.prio.iter().zip(&o.prio) {
            if a > b {
                return true;
            }
            if a < b {
                return false;
            }
        }
        self.cost < o.cost - 1e-12
    }
}

struct Search<'a> {
    order: Vec<usize>,
    /// Candidate ids per item (feasible, cheapest first).
    cands: Vec<Vec<u32>>,
    /// Conflicting candidate ids per candidate (sorted).
    conflicts: std::collections::BTreeMap<u32, Vec<u32>>,
    slot: Vec<usize>,
    n_slots: usize,
    weight: Vec<f64>,
    min_cost: Vec<f64>,
    cost: &'a dyn Fn(u32) -> f64,
    cancel: &'a dyn Fn() -> bool,
    mode: Omission,
    chosen: Vec<Option<u32>>,
    best: Obj,
    best_choice: Vec<Option<u32>>,
    nodes: u64,
    max_nodes: u64,
}

impl Search<'_> {
    fn objective(&self, prio: &[f64], cost: f64) -> Obj {
        Obj {
            prio: prio.to_vec(),
            cost,
        }
    }

    fn dfs(&mut self, k: usize, prio: &mut Vec<f64>, cost: f64, prefix_alive: bool) {
        self.nodes += 1;
        if self.nodes > self.max_nodes {
            return;
        }
        if self.nodes.is_multiple_of(4096) && (self.cancel)() {
            self.max_nodes = self.nodes; // stop: keep the best solution found so far
            return;
        }
        if k == self.order.len() {
            let o = self.objective(prio, cost);
            if o.better(&self.best) {
                self.best = o;
                self.best_choice = self.chosen.clone();
            }
            return;
        }
        // bound: every remaining item placed at its cheapest candidate
        let mut opt = prio.clone();
        let mut opt_cost = cost;
        for &i in &self.order[k..] {
            if !self.cands[i].is_empty() && (self.mode != Omission::Prefix || prefix_alive) {
                opt[self.slot[i]] += self.weight[i];
                opt_cost += self.min_cost[i];
            }
        }
        if !self.objective(&opt, opt_cost).better(&self.best) {
            return;
        }
        let i = self.order[k];
        let list = self.cands[i].clone();
        if self.mode != Omission::Prefix || prefix_alive {
            for c in list {
                let ok = self.chosen.iter().flatten().all(|&o| {
                    !self
                        .conflicts
                        .get(&c)
                        .map(|v| v.binary_search(&o).is_ok())
                        .unwrap_or(false)
                });
                if !ok {
                    continue;
                }
                self.chosen[i] = Some(c);
                prio[self.slot[i]] += self.weight[i];
                let cc = (self.cost)(c);
                self.dfs(k + 1, prio, cost + cc, prefix_alive);
                prio[self.slot[i]] -= self.weight[i];
                self.chosen[i] = None;
                if self.nodes > self.max_nodes {
                    return;
                }
            }
        }
        // leave item i unplaced
        self.dfs(
            k + 1,
            prio,
            cost,
            prefix_alive && self.mode != Omission::Prefix,
        );
    }
}

/// Run the exact search with a node budget. Returns whether the solution changed.
pub fn run(s: &mut Solve, max_nodes: u64) -> bool {
    let n = s.model.items.len();
    let order: Vec<usize> = s
        .pri
        .order
        .iter()
        .copied()
        .filter(|&i| !matches!(s.reasons[i], Some(Reason::Grouped) | Some(Reason::KeepWith)))
        .collect();
    // candidates: evaluated feasible ones (evaluate lazily generated ones)
    let all: Vec<u32> = (0..s.cands.len() as u32).collect();
    for &c in &all {
        if !s.cands[c as usize].evaluated {
            s.ensure_eval(c);
        }
    }
    let mut cands: Vec<Vec<u32>> = vec![Vec::new(); n];
    for &i in &order {
        let mut v: Vec<u32> = s.by_item[i]
            .iter()
            .copied()
            .filter(|&c| s.cands[c as usize].feasible)
            .collect();
        crate::sort::sort_by(&mut v, |&a, &b| {
            crate::math::cmp_f64(s.cands[a as usize].cost, s.cands[b as usize].cost).then(a.cmp(&b))
        });
        v.truncate(24);
        cands[i] = v;
    }
    let pool: Vec<u32> = cands.iter().flatten().copied().collect();
    if pool.len() > 3000 {
        return false;
    }
    let dy = s.obs.dynamic;
    let reach = s.state.leader_reach(s.obs) + s.state.margin_max();
    let mut conflicts: std::collections::BTreeMap<u32, Vec<u32>> =
        std::collections::BTreeMap::new();
    for (x, &a) in pool.iter().enumerate() {
        for &b in &pool[x + 1..] {
            let (ca, cb) = (&s.cands[a as usize], &s.cands[b as usize]);
            if ca.item == cb.item || !ca.bbox().inflate(reach).touches(&cb.bbox()) {
                continue;
            }
            let sp = s.state.spacing(ca.item as usize, cb.item as usize);
            if pair_conflict(ca, cb, &dy, sp) {
                conflicts.entry(a).or_default().push(b);
                conflicts.entry(b).or_default().push(a);
            }
        }
    }
    for v in conflicts.values_mut() {
        v.sort_unstable();
    }
    // priority slots per omission mode
    let (slot, n_slots, weight): (Vec<usize>, usize, Vec<f64>) = match s.model.omission {
        Omission::Strict => (
            s.pri.prio.iter().map(|p| p.key).collect(),
            s.pri.n_keys,
            vec![1.0; n],
        ),
        Omission::Prefix => (vec![0; n], 1, vec![1.0; n]),
        Omission::Weighted => {
            // one slot per (required, tier, reserved) class, in priority order
            let mut classes: Vec<(bool, i64, bool)> = Vec::new();
            for &i in &s.pri.order {
                let p = &s.pri.prio[i];
                let c = (p.required, p.tier, p.reserved);
                if !classes.contains(&c) {
                    classes.push(c);
                }
            }
            let slot = s
                .pri
                .prio
                .iter()
                .map(|p| {
                    classes
                        .iter()
                        .position(|c| *c == (p.required, p.tier, p.reserved))
                        .unwrap_or(0)
                })
                .collect();
            (
                slot,
                classes.len(),
                s.pri.prio.iter().map(|p| p.weight).collect(),
            )
        }
    };
    let costs: Vec<f64> = s.cands.iter().map(|c| c.cost).collect();
    let cost_fn = |c: u32| costs[c as usize];
    let env = s.env;
    let cancel_fn = move || env.cancelled();
    let min_cost: Vec<f64> = cands
        .iter()
        .map(|v| v.first().map(|&c| costs[c as usize]).unwrap_or(0.0))
        .collect();
    // incumbent: the current solution
    let mut inc_prio = vec![0.0; n_slots];
    let mut inc_cost = 0.0;
    let mut chosen: Vec<Option<u32>> = vec![None; n];
    for &i in &order {
        if let Some(c) = s.state.placed[i] {
            inc_prio[slot[i]] += weight[i];
            inc_cost += costs[c as usize];
            chosen[i] = Some(c);
        }
    }
    if s.model.omission == Omission::Prefix {
        inc_prio[0] = order
            .iter()
            .take_while(|&&i| s.state.placed[i].is_some())
            .count() as f64;
    }
    let mut search = Search {
        order: order.clone(),
        cands,
        conflicts,
        slot,
        n_slots,
        weight,
        min_cost,
        cost: &cost_fn,
        cancel: &cancel_fn,
        mode: s.model.omission,
        chosen: vec![None; n],
        best: Obj {
            prio: inc_prio,
            cost: inc_cost,
        },
        best_choice: chosen.clone(),
        nodes: 0,
        max_nodes,
    };
    let _ = search.n_slots;
    let mut prio = vec![0.0; search.n_slots];
    search.dfs(0, &mut prio, 0.0, true);
    if s.model.max_labels.is_some() || search.best_choice == chosen {
        return false;
    }
    // apply
    let best = search.best_choice.clone();
    for &i in &order {
        s.state.unplace(i, &s.cands);
    }
    let mut scratch = Vec::new();
    for &i in &order {
        if let Some(c) = best[i] {
            let cand = &s.cands[c as usize];
            if s.state.is_free(cand, &s.cands, s.obs, i, &mut scratch) {
                s.state.place(i, c, &s.cands, false);
                s.reasons[i] = None;
                continue;
            }
        }
        if s.reasons[i].is_none() {
            s.reasons[i] = Some(Reason::OmittedByPriority);
        }
    }
    true
}
