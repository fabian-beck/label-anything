//! # Label Anything
//!
//! A label placement engine: place text, icons or any sized label next to features in
//! scatterplots, maps, node-link diagrams and illustrations, avoid what must not be
//! covered (vector shapes, SVG or raster backgrounds), draw leaders without
//! crossings, and omit labels in a user-defined priority order when space runs out.
//!
//! ```
//! let problem = serde_json::json!({
//!     "canvas": {"width": 400, "height": 300},
//!     "items": [
//!         {"id": "a", "anchor": {"type": "point", "x": 100, "y": 100}, "label": {"type": "text", "text": "Alpha"}},
//!         {"id": "b", "anchor": {"type": "point", "x": 104, "y": 102}, "label": {"type": "text", "text": "Beta"}}
//!     ]
//! });
//! let result = label_anything::place(&problem).unwrap();
//! assert_eq!(result["stats"]["hard_violations"], 0);
//! ```

#![forbid(unsafe_code)]

pub use la_core::env::{
    self, Env, FontSpec, Geom, RasterMode, RasterOpts, RgbaImage, SvgBackend, SvgDoc, TextMetrics,
};
pub use la_core::geom::{Rect, P};
pub use la_core::validate::{Issue, Report};
pub use la_core::{model, PlaceError, VERSION};
pub use la_render as render;
/// The JSON library of the problems and results of this crate.
pub use serde_json;

use serde_json::Value;
use std::path::PathBuf;

/// The native environment: system clock, file access relative to a base directory, and
/// the SVG/raster backends compiled into this build.
#[derive(Clone, Debug)]
pub struct NativeEnv {
    #[cfg(feature = "std-clock")]
    start: std::time::Instant,
    /// Base directory for relative file paths (`svg.path`, raster/font file paths).
    pub base_dir: Option<PathBuf>,
    /// Allow reading files at all.
    pub allow_files: bool,
    /// Read the clock. Without it `now_ms()` is 0: no wall-clock guards, so a result
    /// depends only on the iteration budgets (parity tests, `place --no-clock`).
    pub clock: bool,
}

impl Default for NativeEnv {
    fn default() -> Self {
        NativeEnv {
            #[cfg(feature = "std-clock")]
            start: std::time::Instant::now(),
            base_dir: None,
            allow_files: true,
            clock: true,
        }
    }
}

impl NativeEnv {
    /// An environment that reads files relative to the working directory.
    pub fn new() -> NativeEnv {
        NativeEnv::default()
    }
    /// An environment that reads relative file paths relative to `dir`.
    pub fn with_base_dir(dir: impl Into<PathBuf>) -> NativeEnv {
        NativeEnv {
            base_dir: Some(dir.into()),
            ..NativeEnv::default()
        }
    }
}

impl Env for NativeEnv {
    fn read_file(&self, path: &str) -> Result<Vec<u8>, String> {
        if !self.allow_files {
            return Err(format!("file access disabled ({path})"));
        }
        let p = match &self.base_dir {
            Some(b) if !std::path::Path::new(path).is_absolute() => b.join(path),
            _ => PathBuf::from(path),
        };
        std::fs::read(&p).map_err(|e| format!("cannot read {}: {e}", p.display()))
    }
    fn now_ms(&self) -> f64 {
        #[cfg(feature = "std-clock")]
        if self.clock {
            return self.start.elapsed().as_secs_f64() * 1000.0;
        }
        0.0
    }
    fn has_measure_callback(&self) -> bool {
        false
    }
}

/// Validate a problem.
pub fn validate(problem: &Value) -> Report {
    la_core::validate::validate(problem)
}

/// Parse JSON text. A syntax error is reported like a validation error (code `parse`).
pub fn parse_json(text: &str) -> Result<Value, Issue> {
    serde_json::from_str(text).map_err(|e| Issue::new("", "parse", format!("invalid JSON: {e}")))
}

/// Validate a problem given as JSON text; text that is not JSON gives a `parse` error.
pub fn validate_json(problem: &str) -> Report {
    match parse_json(problem) {
        Ok(v) => validate(&v),
        Err(e) => Report {
            valid: false,
            errors: vec![e],
            warnings: vec![],
        },
    }
}

/// Solve with the native environment.
pub fn place(problem: &Value) -> Result<Value, PlaceError> {
    place_with(problem, &NativeEnv::new())
}

/// Solve with a custom environment. Fills `debug_svg` when `output.debug_svg` is set.
pub fn place_with(problem: &Value, env: &dyn Env) -> Result<Value, PlaceError> {
    let report = validate(problem);
    if !report.valid {
        return Err(PlaceError {
            errors: report.errors,
        });
    }
    place_validated(problem, env, report)
}

/// Solve a problem whose validation report is already known. The report of an invalid
/// problem is returned as the error.
pub fn place_validated(
    problem: &Value,
    env: &dyn Env,
    report: Report,
) -> Result<Value, PlaceError> {
    if !report.valid {
        return Err(PlaceError {
            errors: report.errors,
        });
    }
    let (mut result, debug) = la_core::place_validated(problem, env, report.warnings)?;
    if let Some(d) = debug {
        let model = la_core::model::build(problem, env).ok();
        let svg = la_render::debug_svg(model.as_ref(), &result, Some(&d));
        result["debug_svg"] = Value::String(svg);
    }
    Ok(result)
}

/// Solve a problem given as JSON text. `Ok` is the result JSON; `Err` is a JSON array of
/// `{pointer, code, message}` errors.
pub fn place_json(problem: &str) -> Result<String, String> {
    place_json_with(problem, &NativeEnv::new())
}

/// [`place_json`] with a custom environment.
pub fn place_json_with(problem: &str, env: &dyn Env) -> Result<String, String> {
    let v = parse_json(problem).map_err(|e| serde_json::to_string(&[e]).unwrap_or_default())?;
    match place_with(&v, env) {
        Ok(r) => Ok(serde_json::to_string(&r).unwrap_or_default()),
        Err(e) => Err(serde_json::to_string(&e.errors).unwrap_or_default()),
    }
}

/// Render the debug overlay for a problem and an existing result.
pub fn render_svg(problem: &Value, result: &Value, env: &dyn Env) -> String {
    let model = la_core::model::build(problem, env).ok();
    la_render::debug_svg(model.as_ref(), result, None)
}

/// The examples of the README are tested with the documentation.
#[cfg(doctest)]
#[doc = include_str!("../README.md")]
struct ReadmeDoctests;
