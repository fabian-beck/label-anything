//! Building the result JSON (spec §11, `result.v1.json`).

use crate::candidates::{Block, Cand, Leader};
use crate::cost::{Breakdown, Evaluator};
use crate::labels::{TextLayout, Variant};
use crate::solver::verify::Verification;
use crate::solver::Solve;
use serde_json::{json, Map, Value};

fn pt(p: crate::geom::P) -> Value {
    json!([p.x, p.y])
}

fn leader_json(l: &Leader, s: &Solve) -> Value {
    let mut m = Map::new();
    m.insert(
        "points".into(),
        Value::Array(l.pts.iter().map(|p| pt(*p)).collect()),
    );
    m.insert("style".into(), json!(l.style.name()));
    m.insert("port".into(), pt(l.port));
    if let Some((a, b)) = l.underline {
        m.insert("underline".into(), json!([[a.x, a.y], [b.x, b.y]]));
    }
    if let Some(c) = l.curve {
        m.insert(
            "curve".into(),
            json!([[c[0].x, c[0].y], [c[1].x, c[1].y], [c[2].x, c[2].y]]),
        );
    }
    if let Some(mem) = l.member {
        m.insert("member".into(), json!(s.model.items[mem as usize].id));
    }
    Value::Object(m)
}

fn text_json(t: &TextLayout, family: &str, weight: u16) -> Value {
    json!({
        "lines": t.lines,
        "used": t.used,
        "truncated": t.truncated,
        "baseline_offsets": t.baselines,
        "line_widths": t.widths,
        "x_offset": t.x_offset,
        "font_size": t.font_size,
        "font_family": family,
        "font_weight": weight,
        "scale": t.scale,
    })
}

fn parts_json(v: &Variant, c: &Cand, family: &str, weight: u16) -> Value {
    Value::Array(
        v.parts
            .iter()
            .map(|p| {
                let r = p.rect.translate(crate::geom::P::new(c.rect.x0, c.rect.y0));
                let mut m = Map::new();
                m.insert("type".into(), json!(p.kind.name()));
                m.insert(
                    "box".into(),
                    json!({"x": r.x0, "y": r.y0, "w": r.w(), "h": r.h()}),
                );
                if let Some(t) = &p.text {
                    let mut tj = text_json(t, family, weight);
                    // part baselines are relative to the label box; report them relative to the part
                    if let Some(o) = tj.as_object_mut() {
                        let rel: Vec<f64> = t.baselines.iter().map(|b| b - p.rect.y0).collect();
                        o.insert("baseline_offsets".into(), json!(rel));
                        o.insert("x_offset".into(), json!(0.0));
                    }
                    m.insert("text".into(), tj);
                }
                Value::Object(m)
            })
            .collect(),
    )
}

fn block_name(s: &Solve, b: Block) -> String {
    match b {
        Block::Edge => "canvas_edge".into(),
        Block::Items => "items".into(),
        Block::Labels => "labels".into(),
        Block::Leaders => "leaders".into(),
        Block::Class(k) => s.obs.classes[k as usize].name.clone(),
    }
}

fn priority_json(s: &Solve, i: usize) -> Value {
    let p = &s.pri.prio[i];
    let mut terms = Map::new();
    for (n, v) in &p.terms {
        let e = terms.entry(n.clone()).or_insert(json!(0.0));
        *e = json!(e.as_f64().unwrap_or(0.0) + v);
    }
    let mut m = Map::new();
    if p.required {
        m.insert("required".into(), json!(true));
    }
    m.insert("tier".into(), json!(p.tier));
    if p.reserved {
        m.insert("reserved".into(), json!(true));
    }
    m.insert("score".into(), json!(p.score));
    m.insert("rank".into(), json!(p.rank));
    if let Some(Some(c)) = s.model.font_class.get(i) {
        m.insert("font_class".into(), json!(c));
    }
    if !terms.is_empty() {
        m.insert("terms".into(), Value::Object(terms));
    }
    Value::Object(m)
}

/// Build the result JSON.
pub fn build(
    s: &mut Solve,
    ver: &Verification,
    phases: &[(&str, f64)],
    runtime_ms: f64,
    strategy: &str,
) -> Value {
    let model = s.model;
    let n = model.items.len();
    let mut placements = Vec::with_capacity(n);
    let mut total_cost = 0.0;
    let mut degraded: std::collections::BTreeMap<&str, i64> = std::collections::BTreeMap::new();
    let mut flicker = (0i64, 0i64, 0i64, 0.0f64, 0usize);
    let mut buf = Vec::new();
    for i in 0..n {
        let item = &model.items[i];
        let mut m = Map::new();
        m.insert("id".into(), json!(item.id));
        match s.state.placed[i] {
            Some(cid) => {
                let c = s.cands[cid as usize].clone();
                let v = s.variants[i][c.variant as usize].clone();
                m.insert("placed".into(), json!(true));
                m.insert(
                    "box".into(),
                    json!({"x": c.rect.x0, "y": c.rect.y0, "w": c.rect.w(), "h": c.rect.h()}),
                );
                let a = item.shape.reference();
                m.insert("anchor".into(), json!([a.x, a.y]));
                m.insert("anchor_side".into(), json!(c.side.name()));
                m.insert("model".into(), json!(c.kind.name()));
                let fam = item.font.family.clone();
                if let Some(t) = &v.text {
                    m.insert("text".into(), text_json(t, &fam, item.font.weight));
                }
                if !v.parts.is_empty() {
                    m.insert("parts".into(), parts_json(&v, &c, &fam, item.font.weight));
                }
                match c.leaders.len() {
                    0 => {
                        m.insert("leader".into(), Value::Null);
                    }
                    1 => {
                        m.insert("leader".into(), leader_json(&c.leaders[0], s));
                    }
                    _ => {
                        m.insert("leader".into(), leader_json(&c.leaders[0], s));
                        m.insert(
                            "leaders".into(),
                            Value::Array(c.leaders.iter().map(|l| leader_json(l, s)).collect()),
                        );
                    }
                }
                let dynamic = s.state.dynamic_cost(
                    &c,
                    &s.cands,
                    s.obs,
                    item.len.buffer,
                    item.len.clearance,
                    model.leaders.width,
                    i,
                );
                let relax = if s.state.relaxed[i] {
                    c.relax_cost
                } else {
                    0.0
                };
                let cost = c.cost + dynamic + relax;
                total_cost += cost;
                m.insert("cost".into(), json!(cost));
                if model.output.cost_breakdown {
                    let mut bd: Breakdown = Vec::new();
                    let mut cc = c.clone();
                    Evaluator::new(model, s.obs, s.env).eval(&mut cc, &v, Some(&mut bd));
                    let mut bm = Map::new();
                    for (k, val) in bd {
                        bm.insert(k, json!(val));
                    }
                    if dynamic != 0.0 {
                        bm.insert("dynamic".into(), json!(dynamic));
                    }
                    if relax != 0.0 {
                        bm.insert("soft_overlap".into(), json!(relax));
                    }
                    m.insert("cost_breakdown".into(), Value::Object(bm));
                }
                let mut steps = v.steps.clone();
                if s.state.relaxed[i] {
                    steps.push("soft_overlap".into());
                }
                if c.level > 0 {
                    let st = model.ladder[c.level as usize - 1].name();
                    if !steps.contains(&st)
                        && (st == "distant" || st == "boundary" || st == "evict_lower")
                    {
                        steps.push(st);
                    }
                }
                for st in &steps {
                    let k: &str = if st.starts_with("shrink") {
                        "shrunk"
                    } else {
                        match st.as_str() {
                            "wrap" => "wrapped",
                            "alternatives" => "alternative",
                            "truncate" => "truncated",
                            "soft_overlap" => "soft_overlap",
                            "distant" => "distant",
                            "boundary" => "boundary",
                            _ => "other",
                        }
                    };
                    *degraded.entry(k).or_insert(0) += 1;
                }
                if v.lines() > 1 && !steps.iter().any(|s| s == "wrap") {
                    *degraded.entry("wrapped").or_insert(0) += 1;
                }
                m.insert("degrade_steps".into(), json!(steps));
                m.insert("priority".into(), priority_json(s, i));
                let members = model.group_members(i);
                if members.len() >= 2 {
                    m.insert(
                        "members".into(),
                        json!(members
                            .iter()
                            .map(|&k| model.items[k].id.clone())
                            .collect::<Vec<_>>()),
                    );
                    if let Some(t) = m.get_mut("text") {
                        t["used"] = json!("group");
                    }
                }
                if model.output.item_shape {
                    m.insert("item_shape".into(), shape_json(&item.shape));
                }
                if let Some(prev) = model.warm.get(&item.id) {
                    match prev {
                        Some(b) => {
                            let d = b.center().dist(c.rect.center());
                            m.insert("displacement".into(), json!(d));
                            if d > 0.5 {
                                flicker.0 += 1;
                            }
                            flicker.3 += d;
                            flicker.4 += 1;
                        }
                        None => flicker.1 += 1,
                    }
                } else if !model.warm.is_empty() {
                    flicker.1 += 1;
                }
            }
            None => {
                m.insert("placed".into(), json!(false));
                let reason = s.reasons[i].unwrap_or(crate::solver::Reason::OmittedByPriority);
                m.insert("reason".into(), json!(reason.name()));
                // blocking classes, most frequent first
                let mut counts: std::collections::BTreeMap<String, usize> =
                    std::collections::BTreeMap::new();
                let mut blockers: Vec<u32> = Vec::new();
                let mut feas: Vec<(f64, u32)> = Vec::new();
                for &cid in &s.by_item[i] {
                    let c = &s.cands[cid as usize];
                    if let Some(b) = c.blocked {
                        *counts.entry(block_name(s, b)).or_insert(0) += 1;
                    } else {
                        feas.push((c.cost, cid));
                    }
                }
                if s.static_dropped[i] > 0 {
                    *counts.entry("items".into()).or_insert(0) += s.static_dropped[i] as usize;
                }
                crate::sort::sort_by(&mut feas, |a, b| {
                    crate::math::cmp_f64(a.0, b.0).then(a.1.cmp(&b.1))
                });
                let probes: Vec<Cand> = if feas.is_empty() {
                    // no kept feasible candidate: the feasible ones the placed labels had
                    // blocked while they were generated (stable: ties in generation order)
                    let mut u = s.blocked_feasible[i].clone();
                    crate::sort::sort_by(&mut u, |a, b| crate::math::cmp_f64(a.cost, b.cost));
                    u
                } else {
                    feas.iter()
                        .take(crate::solver::greedy::EXPLAIN_CANDIDATES)
                        .map(|&(_, cid)| s.cands[cid as usize].clone())
                        .collect()
                };
                for c in probes {
                    s.state.conflicts(&c, &s.cands, s.obs, i, &mut buf);
                    for &j in &buf {
                        let jc = &s.cands[s.state.placed[j as usize].unwrap() as usize];
                        let key = if jc.rect.overlaps(&c.rect) {
                            "labels"
                        } else {
                            "leaders"
                        };
                        *counts.entry(key.into()).or_insert(0) += 1;
                        if !blockers.contains(&j) {
                            blockers.push(j);
                        }
                    }
                }
                let mut cv: Vec<(String, usize)> = counts.into_iter().collect();
                crate::sort::sort_by(&mut cv, |a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
                m.insert(
                    "blocking".into(),
                    json!(cv.into_iter().map(|x| x.0).collect::<Vec<_>>()),
                );
                crate::sort::sort_by_key(&mut blockers, |&j| s.pri.prio[j as usize].rank);
                m.insert(
                    "blocked_by".into(),
                    json!(blockers
                        .iter()
                        .map(|&j| model.items[j as usize].id.clone())
                        .collect::<Vec<_>>()),
                );
                m.insert("priority".into(), priority_json(s, i));
                if !s.steps_tried[i].is_empty() {
                    m.insert("degrade_steps".into(), json!(s.steps_tried[i]));
                }
                if let Some(Some(_)) = model.warm.get(&item.id) {
                    flicker.2 += 1;
                }
            }
        }
        placements.push(Value::Object(m));
    }
    // stats
    let placed = s.state.n_placed;
    let gain_all: f64 = s.pri.prio.iter().map(|p| p.gain).sum();
    let gain_placed: f64 = (0..n)
        .filter(|&i| s.state.placed[i].is_some())
        .map(|i| s.pri.prio[i].gain)
        .sum();
    let mut omitted: Vec<usize> = (0..n).filter(|&i| s.state.placed[i].is_none()).collect();
    crate::sort::sort_by_key(&mut omitted, |&i| std::cmp::Reverse(s.pri.prio[i].rank));
    let required_placed = (0..n)
        .filter(|&i| model.items[i].required)
        .all(|i| s.state.placed[i].is_some());
    let mut phases_m = Map::new();
    for (k, v) in phases {
        phases_m.insert((*k).to_string(), json!(v));
    }
    let mut stats = json!({
        "placed": placed,
        "total": n,
        "placed_weighted": if gain_all > 0.0 { gain_placed / gain_all } else { 1.0 },
        "required_placed": required_placed,
        "hard_violations": ver.hard_violations,
        "leader_crossings": ver.leader_crossings,
        "runtime_ms": runtime_ms,
        "phases_ms": Value::Object(phases_m),
        "strategy_used": strategy,
        "seed": model.solver.seed,
        "iterations": s.iterations,
        "time_guard_hit": s.time_guard_hit,
        "cancelled": s.cancelled,
        "candidates": s.cands.len(),
        "omission_order": omitted.iter().map(|&i| model.items[i].id.clone()).collect::<Vec<_>>(),
        "priority_inversions": ver.priority_inversions,
        "total_cost": total_cost,
        "degraded": degraded,
        "grid": {
            "cell": s.obs.grid.cell,
            "cols": s.obs.grid.cols,
            "rows": s.obs.grid.rows,
            "classes": s.obs.classes.iter().map(|c| c.name.clone()).collect::<Vec<_>>(),
        },
        "implementation": format!("rust/{}", env!("CARGO_PKG_VERSION")),
    });
    if !model.warm.is_empty() {
        stats["flicker"] = json!({
            "moved": flicker.0,
            "added": flicker.1,
            "removed": flicker.2,
            "mean_displacement": if flicker.4 > 0 { flicker.3 / flicker.4 as f64 } else { 0.0 },
        });
    }
    let mut out = json!({
        "version": "1",
        "placements": placements,
        "stats": stats,
        "debug_svg": Value::Null,
    });
    if !model.warnings.is_empty() {
        out["warnings"] = json!(model.warnings);
    }
    if model.output.candidates {
        out["candidates"] = Value::Array(
            s.cands
                .iter()
                .map(|c| {
                    json!({
                        "id": model.items[c.item as usize].id,
                        "box": {"x": c.rect.x0, "y": c.rect.y0, "w": c.rect.w(), "h": c.rect.h()},
                        "model": c.kind.name(),
                        "anchor_side": c.side.name(),
                        "variant": c.variant,
                        "level": c.level,
                        "cost": c.cost,
                        "feasible": c.feasible,
                        "leader": c.leaders.first().map(|l| leader_json(l, s)).unwrap_or(Value::Null),
                    })
                })
                .collect(),
        );
    }
    out
}

/// Resolved item geometry for `output.item_shape`.
pub fn shape_json(s: &crate::geom::shape::Shape) -> Value {
    use crate::geom::shape::Shape;
    match s {
        Shape::Circle { c, r } => json!({"shape": "circle", "x": c.x, "y": c.y, "r": r}),
        Shape::Ellipse {
            c,
            rx,
            ry,
            cos,
            sin,
        } => {
            json!({"shape": "ellipse", "x": c.x, "y": c.y, "rx": rx, "ry": ry, "rotation": la_expr::det_math::atan2_deg(*sin, *cos)})
        }
        Shape::RoundRect {
            c,
            hw,
            hh,
            r,
            cos,
            sin,
        } => json!({
            "shape": "rect", "x": c.x, "y": c.y, "w": hw * 2.0, "h": hh * 2.0, "corner_radius": r,
            "rotation": la_expr::det_math::atan2_deg(*sin, *cos)
        }),
        Shape::Polygon(p) => json!({
            "shape": "polygon", "x": p.reference.x, "y": p.reference.y,
            "rings": p.rings.iter().map(|r| r.iter().map(|q| json!([q.x, q.y])).collect::<Vec<_>>()).collect::<Vec<_>>()
        }),
    }
}
