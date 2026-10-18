//! Label Anything core: the label placement engine.
//!
//! One problem description goes in (`spec/schema/problem.v1.json`), one list of placed
//! labels and leaders comes out (`spec/schema/result.v1.json`). See `spec/spec.md` for
//! the normative semantics. This crate has no I/O; backgrounds, files, the clock and
//! host callbacks are injected through [`env::Env`].

pub mod boundary;
pub mod candidates;
pub mod cost;
pub mod env;
pub mod generated;
pub mod geom;
pub mod grid;
pub mod index;
pub mod labels;
pub mod leaders;
pub mod math;
pub mod model;
pub mod obstacles;
pub mod options;
pub mod par;
pub mod priority;
pub mod result;
pub mod solver;
pub mod sort;
pub mod units;
pub mod validate;

use env::Env;
use serde_json::Value;
use validate::Issue;

/// Version of this implementation.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// A failed solve: validation errors or a problem that cannot be prepared.
#[derive(Clone, Debug)]
pub struct PlaceError {
    pub errors: Vec<Issue>,
}

/// One line per error (`pointer code: message`), without a trailing newline.
impl std::fmt::Display for PlaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (k, e) in self.errors.iter().enumerate() {
            if k > 0 {
                writeln!(f)?;
            }
            write!(
                f,
                "{} {}: {}",
                if e.pointer.is_empty() {
                    "/"
                } else {
                    &e.pointer
                },
                e.code,
                e.message
            )?;
        }
        Ok(())
    }
}

impl std::error::Error for PlaceError {}

/// Grid data for debug rendering (only built when `output.debug_svg` is set).
pub struct DebugData {
    pub grid: grid::GridSpec,
    /// (class name, coverage 0..255 per cell)
    pub classes: Vec<(String, Vec<u8>)>,
    /// (item id, label box, feasible) of all candidates
    pub candidates: Vec<(String, geom::Rect, bool)>,
}

/// Solve a problem. Validation errors are returned as `Err`.
pub fn place(problem: &Value, env: &dyn Env) -> Result<Value, PlaceError> {
    place_with_debug(problem, env).map(|(r, _)| r)
}

/// Solve a problem and, when `output.debug_svg` is set, return grid data for rendering.
pub fn place_with_debug(
    problem: &Value,
    env: &dyn Env,
) -> Result<(Value, Option<DebugData>), PlaceError> {
    let report = validate::validate(problem);
    if !report.valid {
        return Err(PlaceError {
            errors: report.errors,
        });
    }
    place_validated(problem, env, report.warnings)
}

/// Solve a problem that already passed `validate` (its warnings are passed through).
pub fn place_validated(
    problem: &Value,
    env: &dyn Env,
    warnings: Vec<Issue>,
) -> Result<(Value, Option<DebugData>), PlaceError> {
    let t0 = env.now_ms();
    let report = validate::Report {
        valid: true,
        errors: vec![],
        warnings,
    };
    let mut m = model::build(problem, env).map_err(|e| PlaceError {
        errors: vec![Issue::new(e.pointer, &e.code, e.message)],
    })?;
    m.warnings.extend(report.warnings);
    let owned_fonts = labels::user_fonts(&mut m, env).map_err(|(p, msg)| PlaceError {
        errors: vec![Issue::new(p, "invalid_value", msg)],
    })?;
    let fonts: &la_text::FontBook = match &owned_fonts {
        Some(b) => b,
        None => labels::bundled_fonts(),
    };
    let measurer = labels::Measurer {
        fonts,
        env,
        shaping: &m.shaping,
    };
    let mut variants: Vec<Vec<labels::Variant>> = m
        .items
        .iter()
        .map(|it| labels::base_variants(&measurer, it))
        .collect();
    let pri = priority::compute(&m, &variants, env);
    // font classes (spec §9.4): the priorities stay those of the nominal sizes
    m.font_class = priority::font_classes(&m, &pri);
    m.key_level = pri.prio.iter().map(|p| p.key).collect();
    for ((item, class), v) in m.items.iter_mut().zip(&m.font_class).zip(&mut variants) {
        if let Some(c) = class.map(|k| m.font_classes[k]) {
            if c.scale != 1.0 || c.weight.is_some() {
                item.rescale(c.scale, c.weight);
                *v = labels::base_variants(&measurer, item);
            }
        }
    }
    let mut min_font = f64::INFINITY;
    for it in &m.items {
        min_font = min_font.min(it.font.size);
        if let model::LabelSpec::Composite { parts, .. } = &it.label {
            for p in parts {
                if let model::PartSpec::Text(t) = p {
                    min_font = min_font.min(t.font.size);
                }
            }
        }
    }
    if !min_font.is_finite() {
        min_font = m.default_em;
    }
    // the grids cover the working extent: it must be finite and not too finely divided
    let (ew, eh) = (m.extent.w(), m.extent.h());
    if !(ew.is_finite() && eh.is_finite()) {
        return Err(PlaceError {
            errors: vec![Issue::new(
                "",
                "limit",
                format!("the working extent ({ew} × {eh} px) is not finite"),
            )],
        });
    }
    let cells = obstacles::grid_cells(&m, obstacles::grid_cell(&m, min_font));
    if cells > obstacles::MAX_GRID_CELLS {
        return Err(PlaceError {
            errors: vec![Issue::new(
                "/solver/grid_cell",
                "limit",
                format!(
                    "the grid would have {cells} cells (at most {}): use a larger solver.grid_cell",
                    obstacles::MAX_GRID_CELLS
                ),
            )],
        });
    }
    let obs = obstacles::prepare(&m, min_font);
    let t1 = env.now_ms();
    let measurer = labels::Measurer {
        fonts,
        env,
        shaping: &m.shaping,
    };
    let mut s = solver::Solve::new(&m, &obs, env, &pri, measurer, variants, t0);
    s.generate_level0();
    let t2 = env.now_ms();
    env.progress("greedy", 0.0);
    solver::greedy::run(&mut s);
    let t3 = env.now_ms();
    use model::opts::Strategy;
    let mut strategy = "greedy";
    if matches!(
        m.solver.strategy,
        Strategy::Local | Strategy::Auto | Strategy::Exact
    ) && m.items.len() > 1
    {
        let budget = m.solver.time_budget_ms;
        let iters = (m.solver.max_iterations as f64)
            .min(budget * solver::local::MOVES_PER_MS)
            .min(400.0 * m.items.len() as f64)
            .max(0.0) as u64;
        env.progress("local", 0.0);
        let deadline = if t0 > 0.0 || env.now_ms() > 0.0 {
            t0 + 3.0 * budget
        } else {
            0.0
        };
        let ls = solver::local::run(&mut s, iters, deadline);
        s.iterations = ls.iterations;
        if ls.iterations > 0 {
            strategy = "local";
        }
        // exact search: explicitly requested, or auto with a small instance and a large budget
        let small = s.cands.len() <= 3000;
        if m.solver.strategy == Strategy::Exact
            || (m.solver.strategy == Strategy::Auto && small && budget >= 500.0)
        {
            env.progress("exact", 0.0);
            let max_nodes = (budget * 2000.0).max(10_000.0) as u64;
            solver::exact::run(&mut s, max_nodes);
            strategy = "exact";
        }
    }
    solver::fan::fan_pass(&mut s);
    solver::repair::boundary_pass(&mut s);
    solver::repair::boundary_fill(&mut s);
    solver::repair::uncross(&mut s);
    solver::repair::priority_repair(&mut s);
    let t4 = env.now_ms();
    let ver = solver::verify::verify(&mut s);
    let t5 = env.now_ms();
    let phases = [
        ("prepare", t1 - t0),
        ("candidates", t2 - t1),
        ("greedy", t3 - t2),
        ("local", t4 - t3),
        ("verify", t5 - t4),
    ];
    let mut res = result::build(&mut s, &ver, &phases, env.now_ms() - t0, strategy);
    let debug = if m.output.debug_svg {
        Some(DebugData {
            grid: obs.grid,
            classes: obs
                .classes
                .iter()
                .filter_map(|c| {
                    c.sat.as_ref().map(|sat| {
                        (
                            c.name.clone(),
                            (0..obs.grid.cells())
                                .map(|i| sat.cell(i % obs.grid.cols, i / obs.grid.cols))
                                .collect(),
                        )
                    })
                })
                .collect(),
            candidates: s
                .cands
                .iter()
                .map(|c| (m.items[c.item as usize].id.clone(), c.rect, c.feasible))
                .collect(),
        })
    } else {
        None
    };
    if let Some(st) = res.get_mut("stats") {
        st["runtime_ms"] = Value::from(env.now_ms() - t0);
    }
    Ok((res, debug))
}

/// Solve a problem given as JSON text; returns the result as JSON text, or the errors as
/// a JSON array.
pub fn place_str(text: &str, env: &dyn Env) -> Result<String, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| {
        serde_json::to_string(&vec![Issue::new("", "parse", format!("invalid JSON: {e}"))])
            .unwrap_or_default()
    })?;
    match place(&v, env) {
        Ok(r) => Ok(serde_json::to_string(&r).unwrap_or_default()),
        Err(e) => Err(serde_json::to_string(&e.errors).unwrap_or_default()),
    }
}
