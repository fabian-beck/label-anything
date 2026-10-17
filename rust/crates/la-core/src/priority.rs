//! The priority function (spec §9): tiers, scores, coverage, ties, bands and keys.

use crate::env::Env;
use crate::geom::P;
use crate::labels::Variant;
use crate::math::{cmp_f64, ln_1p, maxf};
use crate::model::opts::Ties;
use crate::model::{Item, Model, Prim};
use la_expr::det_math::Pcg32;
use serde_json::Value;

/// Resolved priority of one item.
#[derive(Clone, Debug)]
pub struct Prio {
    pub required: bool,
    pub tier: i64,
    pub reserved: bool,
    pub score: f64,
    /// Per-term contributions (`weight × normalized value`).
    pub terms: Vec<(String, f64)>,
    /// Position in the total order (0 = highest).
    pub rank: usize,
    /// Key level: equal-key items share a level; 0 = highest.
    pub key: usize,
    /// Weight for `weighted` omission.
    pub weight: f64,
    /// NDCG gain `1 / log2(rank + 2)`.
    pub gain: f64,
}

/// Priorities of all items, plus the total order (item indices, highest first).
pub struct Priorities {
    pub prio: Vec<Prio>,
    pub order: Vec<usize>,
    pub n_keys: usize,
}

fn expr_ctx_value(item: &Item) -> la_expr::Value {
    la_expr::Value::from(&item.attrs)
}

fn eval(expr: &la_expr::Expr, item: &Item, attrs: &la_expr::Value) -> la_expr::Value {
    let text = item.label.text();
    let ctx = la_expr::Context {
        attrs,
        id: &item.id,
        index: item.index,
        text: &text,
        priority: item.explicit_priority,
        tier: item.explicit_tier,
        x: item.anchor.x,
        y: item.anchor.y,
    };
    expr.eval(&ctx)
}

/// Raw values of a built-in term.
fn builtin_values(
    name: &str,
    k: usize,
    model: &Model,
    variants: &[Vec<Variant>],
) -> Vec<Option<f64>> {
    let n = model.items.len();
    match name {
        "input_order" => (0..n).map(|i| Some((n - i) as f64)).collect(),
        "label_size" => (0..n)
            .map(|i| Some(crate::labels::label_size_em2(&model.items[i], &variants[i])))
            .collect(),
        "mark_size" => model.items.iter().map(|it| Some(it.shape.area())).collect(),
        "centrality" => {
            let f = model
                .focus
                .unwrap_or_else(|| model.canvas.unwrap_or(model.extent).center());
            model
                .items
                .iter()
                .map(|it| Some(-it.anchor.dist(f)))
                .collect()
        }
        "degree" => model
            .items
            .iter()
            .map(|it| {
                if let Some(d) = it.attrs.get("degree").and_then(attr_number) {
                    return Some(d);
                }
                let mut deg = 0usize;
                for (_, p) in &model.vector {
                    if let Prim::Polyline { points, .. } = p {
                        for e in [points.first(), points.last()].into_iter().flatten() {
                            if it.shape.signed_distance(*e) <= 0.5 {
                                deg += 1;
                            }
                        }
                    }
                }
                Some(deg as f64)
            })
            .collect(),
        "outlierness" => knn_gaps(model, k.max(1)).into_iter().map(Some).collect(),
        "isolation" => knn_gaps(model, 1).into_iter().map(Some).collect(),
        "crowding" => knn_gaps(model, 1).into_iter().map(|d| Some(-d)).collect(),
        _ => vec![None; n],
    }
}

/// Equivalent radius used for shape-to-shape gap distances.
fn eq_radius(it: &Item) -> f64 {
    match &it.shape {
        crate::geom::shape::Shape::Circle { r, .. } => *r,
        s => (s.area() / std::f64::consts::PI).sqrt(),
    }
}

/// k-th nearest-neighbour gap distance of every item among all item marks and the
/// `points`-class discs (spec §4.4 `outlierness`).
fn knn_gaps(model: &Model, k: usize) -> Vec<f64> {
    let mut pts: Vec<(P, f64, Option<usize>)> = model
        .items
        .iter()
        .enumerate()
        .map(|(i, it)| (it.anchor, eq_radius(it), Some(i)))
        .collect();
    for (c, p) in &model.vector {
        if &**c == "points" {
            if let Prim::Disc { c, r } = p {
                pts.push((*c, *r, None));
            }
        }
    }
    let bbox = crate::geom::bbox_of(&pts.iter().map(|p| p.0).collect::<Vec<_>>());
    let cell = maxf(
        (bbox.area() / maxf(pts.len() as f64, 1.0)).sqrt() * 2.0,
        1.0,
    );
    let ix = crate::index::StaticIndex::new(
        pts.iter()
            .map(|(c, r, _)| crate::geom::Rect::from_center(*c, *r, *r))
            .collect(),
        &bbox.inflate(1.0),
        cell,
    );
    let mut out = Vec::with_capacity(model.items.len());
    let mut buf = Vec::new();
    let mut gaps: Vec<f64> = Vec::new();
    for (i, it) in model.items.iter().enumerate() {
        let ri = eq_radius(it);
        let mut radius = cell;
        loop {
            ix.query(
                &crate::geom::Rect::from_center(it.anchor, radius, radius),
                &mut buf,
            );
            gaps.clear();
            for &j in &buf {
                let (c, r, idx) = pts[j as usize];
                if idx == Some(i) {
                    continue;
                }
                gaps.push(maxf(c.dist(it.anchor) - r - ri, 0.0));
            }
            gaps.sort_by(|a, b| cmp_f64(*a, *b));
            // enough neighbours within the searched square guarantee correctness
            if gaps.len() >= k && gaps[k - 1] + ri <= radius {
                out.push(gaps[k - 1]);
                break;
            }
            if radius > maxf(bbox.w(), bbox.h()) * 2.0 + 1.0 {
                out.push(if gaps.len() >= k {
                    gaps[k - 1]
                } else {
                    gaps.last().copied().unwrap_or(maxf(bbox.w(), bbox.h()))
                });
                break;
            }
            radius *= 2.0;
        }
    }
    out
}

fn attr_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn transform(v: f64, t: &str) -> Option<f64> {
    match t {
        "log1p" => (v > -1.0).then(|| ln_1p(v)),
        "sqrt" => (v >= 0.0).then(|| v.sqrt()),
        "neg" => Some(-v),
        "abs" => Some(v.abs()),
        _ => Some(v),
    }
}

/// Normalize values across items (spec §9.1). Missing values become 0.
pub fn normalize(vals: &[Option<f64>], how: &str) -> Vec<f64> {
    let present: Vec<(usize, f64)> = vals
        .iter()
        .enumerate()
        .filter_map(|(i, v)| v.map(|x| (i, x)))
        .collect();
    let mut out = vec![0.0; vals.len()];
    match how {
        "none" => {
            for (i, v) in present {
                out[i] = v;
            }
        }
        "minmax" => {
            let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
            for &(_, v) in &present {
                lo = lo.min(v);
                hi = hi.max(v);
            }
            if hi > lo {
                for (i, v) in present {
                    out[i] = (v - lo) / (hi - lo);
                }
            }
        }
        _ => {
            let n = present.len();
            let mut sorted = present.clone();
            sorted.sort_by(|a, b| cmp_f64(a.1, b.1).then(a.0.cmp(&b.0)));
            let mut k = 0;
            while k < n {
                let mut e = k;
                while e + 1 < n && sorted[e + 1].1 == sorted[k].1 {
                    e += 1;
                }
                let avg = (k + e) as f64 * 0.5;
                let norm = if n > 1 { avg / (n - 1) as f64 } else { 1.0 };
                for s in &sorted[k..=e] {
                    out[s.0] = norm;
                }
                k = e + 1;
            }
        }
    }
    out
}

pub fn compute(model: &Model, variants: &[Vec<Variant>], env: &dyn Env) -> Priorities {
    let n = model.items.len();
    let pv = &model.priority_value;
    let attrs: Vec<la_expr::Value> = model.items.iter().map(expr_ctx_value).collect();
    // tiers
    let tier_rules: Vec<(la_expr::Expr, i64)> = pv
        .get("tiers")
        .and_then(|t| t.as_array())
        .into_iter()
        .flatten()
        .filter_map(|r| {
            Some((
                la_expr::parse(r.get("where")?.as_str()?).ok()?,
                r.get("tier")?.as_i64()?,
            ))
        })
        .collect();
    let mut tiers: Vec<i64> = model
        .items
        .iter()
        .enumerate()
        .map(|(i, it)| {
            it.explicit_tier.unwrap_or_else(|| {
                tier_rules
                    .iter()
                    .find(|(e, _)| la_expr::truthy(&eval(e, it, &attrs[i])))
                    .map(|r| r.1)
                    .unwrap_or(0)
            })
        })
        .collect();
    // scores
    let mut scores = vec![0.0; n];
    let mut contribs: Vec<Vec<(String, f64)>> = vec![Vec::new(); n];
    let callback = env.has_priority_callback();
    if callback {
        for (i, it) in model.items.iter().enumerate() {
            if let Some((t, s)) = env.priority(&it.raw, i) {
                scores[i] = s;
                if let (Some(t), None) = (t, it.explicit_tier) {
                    tiers[i] = t;
                }
            }
        }
    } else if let Some(terms) = pv.get("terms").and_then(|t| t.as_array()) {
        for term in terms {
            let weight = term.get("weight").and_then(|w| w.as_f64()).unwrap_or(1.0);
            let how = term
                .get("normalize")
                .and_then(|w| w.as_str())
                .unwrap_or("rank");
            let tr = term
                .get("transform")
                .and_then(|w| w.as_str())
                .unwrap_or("none");
            let (name, raw): (String, Vec<Option<f64>>) =
                if let Some(b) = term.get("builtin").and_then(|b| b.as_str()) {
                    let k = term.get("k").and_then(|k| k.as_u64()).unwrap_or(5) as usize;
                    (b.to_string(), builtin_values(b, k, model, variants))
                } else if let Some(a) = term.get("attr").and_then(|a| a.as_str()) {
                    (
                        a.to_string(),
                        model
                            .items
                            .iter()
                            .map(|it| it.attrs.get(a).and_then(attr_number))
                            .collect(),
                    )
                } else if let Some(src) = term.get("expr").and_then(|e| e.as_str()) {
                    let vals = match la_expr::parse(src) {
                        Ok(e) => model
                            .items
                            .iter()
                            .enumerate()
                            .map(|(i, it)| la_expr::term_number(&eval(&e, it, &attrs[i])))
                            .collect(),
                        Err(_) => vec![None; n],
                    };
                    (src.to_string(), vals)
                } else {
                    continue;
                };
            let transformed: Vec<Option<f64>> = raw
                .into_iter()
                .map(|v| v.and_then(|x| transform(x, tr)).filter(|x| x.is_finite()))
                .collect();
            let norm = normalize(&transformed, how);
            for i in 0..n {
                let c = weight * norm[i];
                scores[i] += c;
                contribs[i].push((name.clone(), c));
            }
        }
    }
    for (i, it) in model.items.iter().enumerate() {
        if let Some(p) = it.explicit_priority {
            scores[i] = p;
        }
    }
    // tie keys
    let tie: Vec<u64> = match model.ties {
        Ties::Random(seed) => {
            let mut rng = Pcg32::new(seed);
            (0..n).map(|_| rng.next_u32() as u64).collect()
        }
        _ => vec![0; n],
    };
    let cmp_items = |a: usize, b: usize, reserved: &[bool]| -> std::cmp::Ordering {
        let ia = &model.items[a];
        let ib = &model.items[b];
        ib.required
            .cmp(&ia.required)
            .then(tiers[b].cmp(&tiers[a]))
            .then(reserved[b].cmp(&reserved[a]))
            .then(cmp_f64(scores[b], scores[a]))
            .then_with(|| match model.ties {
                Ties::InputOrder => a.cmp(&b),
                Ties::Id => ia.id.cmp(&ib.id).then(a.cmp(&b)),
                Ties::AnchorX => cmp_f64(ia.anchor.x, ib.anchor.x).then(a.cmp(&b)),
                Ties::Random(_) => tie[a].cmp(&tie[b]).then(a.cmp(&b)),
            })
    };
    // coverage reservation
    let mut reserved = vec![false; n];
    if let Some(cov) = pv.get("coverage").filter(|c| c.is_object()) {
        if let Some(e) = cov
            .get("by")
            .and_then(|b| b.as_str())
            .and_then(|s| la_expr::parse(s).ok())
        {
            let m = cov
                .get("min_per_group")
                .and_then(|m| m.as_u64())
                .unwrap_or(1) as usize;
            let mut order: Vec<usize> = (0..n).collect();
            let none = vec![false; n];
            order.sort_by(|&a, &b| cmp_items(a, b, &none));
            let mut groups: Vec<(la_expr::Value, usize)> = Vec::new();
            for &i in &order {
                let v = eval(&e, &model.items[i], &attrs[i]);
                match groups.iter_mut().find(|g| la_expr::values_equal(&g.0, &v)) {
                    Some(g) => {
                        if g.1 < m {
                            g.1 += 1;
                            reserved[i] = true;
                        }
                    }
                    None => {
                        groups.push((v, 1));
                        reserved[i] = m >= 1;
                    }
                }
            }
        }
    }
    // total order
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| cmp_items(a, b, &reserved));
    // key levels with bands
    let mut prio: Vec<Prio> = (0..n)
        .map(|i| Prio {
            required: model.items[i].required,
            tier: tiers[i],
            reserved: reserved[i],
            score: scores[i],
            terms: std::mem::take(&mut contribs[i]),
            rank: 0,
            key: 0,
            weight: maxf(scores[i], 0.0) + 1e-6,
            gain: 0.0,
        })
        .collect();
    let mut level = 0usize;
    let mut band_start = f64::NAN;
    for (r, &i) in order.iter().enumerate() {
        if r > 0 {
            let p = order[r - 1];
            let same_class = prio[p].required == prio[i].required
                && prio[p].tier == prio[i].tier
                && prio[p].reserved == prio[i].reserved;
            let same_band = if model.band > 0.0 {
                scores[i] >= band_start - model.band
            } else {
                scores[i] == scores[p]
            };
            if !(same_class && same_band) {
                level += 1;
                band_start = scores[i];
            }
        } else {
            band_start = scores[i];
        }
        prio[i].rank = r;
        prio[i].key = level;
        prio[i].gain = std::f64::consts::LN_2 / crate::math::ln(r as f64 + 2.0);
    }
    // keep_with sets carry the best key of their members
    let sets = keep_with_sets(model);
    for set in &sets {
        let best = set.iter().map(|&i| prio[i].key).min().unwrap_or(0);
        for &i in set {
            prio[i].key = best;
        }
    }
    // a group label carries the best key of its members
    for (rep, members) in &model.groups {
        let best = members
            .iter()
            .map(|&i| prio[i].key)
            .min()
            .unwrap_or(prio[*rep].key);
        prio[*rep].key = best;
    }
    Priorities {
        prio,
        order,
        n_keys: level + 1,
    }
}

/// The font class of each item (`priority.font_classes`, spec §9.4): each class takes the
/// items of the total order up to its end (cumulative) that no earlier class took; a group
/// label goes by its best-ranked member. `None`: no class (the item keeps its size).
pub fn font_classes(model: &Model, pri: &Priorities) -> Vec<Option<usize>> {
    use crate::model::ClassEnd;
    let n = model.items.len();
    let mut ends = Vec::with_capacity(model.font_classes.len());
    let mut last = 0usize;
    for c in &model.font_classes {
        let end = match c.first {
            None => n,
            Some(ClassEnd::Count(k)) => k.min(n),
            Some(ClassEnd::Share(f)) => (maxf((f * n as f64 - 1e-9).ceil(), 0.0) as usize).min(n),
        };
        last = last.max(end);
        ends.push(last);
    }
    let class_of = |r: usize| ends.iter().position(|&e| r < e);
    let mut out: Vec<Option<usize>> = pri.prio.iter().map(|p| class_of(p.rank)).collect();
    for (rep, members) in &model.groups {
        let best = members
            .iter()
            .map(|&i| pri.prio[i].rank)
            .min()
            .unwrap_or(pri.prio[*rep].rank);
        out[*rep] = class_of(best);
    }
    out
}

/// All-or-none sets (each with ≥ 2 members), members in input order.
pub fn keep_with_sets(model: &Model) -> Vec<Vec<usize>> {
    use crate::model::KeepWith;
    let n = model.items.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut [usize], x: usize) -> usize {
        let mut r = x;
        while p[r] != r {
            r = p[r];
        }
        let mut y = x;
        while p[y] != r {
            let nx = p[y];
            p[y] = r;
            y = nx;
        }
        r
    }
    let mut by_name: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
    let ids: std::collections::BTreeMap<&str, usize> = model
        .items
        .iter()
        .map(|it| (it.id.as_str(), it.index))
        .collect();
    let mut involved = vec![false; n];
    for it in &model.items {
        match &it.keep_with {
            Some(KeepWith::Set(name)) => {
                involved[it.index] = true;
                if let Some(&first) = by_name.get(name.as_str()) {
                    let (a, b) = (find(&mut parent, first), find(&mut parent, it.index));
                    parent[a.max(b)] = a.min(b);
                } else {
                    by_name.insert(name, it.index);
                }
            }
            Some(KeepWith::Ids(list)) => {
                for id in list {
                    if let Some(&j) = ids.get(id.as_str()) {
                        involved[it.index] = true;
                        involved[j] = true;
                        let (a, b) = (find(&mut parent, j), find(&mut parent, it.index));
                        parent[a.max(b)] = a.min(b);
                    }
                }
            }
            None => {}
        }
    }
    let mut sets: std::collections::BTreeMap<usize, Vec<usize>> = std::collections::BTreeMap::new();
    for (i, &inv) in involved.iter().enumerate().take(n) {
        if inv {
            let r = find(&mut parent, i);
            sets.entry(r).or_default().push(i);
        }
    }
    sets.into_values().filter(|s| s.len() >= 2).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rank_normalization_with_ties_and_missing() {
        let v = normalize(&[Some(3.0), Some(1.0), None, Some(3.0), Some(2.0)], "rank");
        assert_eq!(
            v,
            vec![(2.0 + 3.0) / 2.0 / 3.0, 0.0, 0.0, 2.5 / 3.0, 1.0 / 3.0]
        );
        let m = normalize(&[Some(2.0), Some(4.0), None], "minmax");
        assert_eq!(m, vec![0.0, 1.0, 0.0]);
    }
}
