//! Python binding of Label Anything: the extension module `label_anything._native`.
//!
//! JSON in, JSON out, like the C ABI (`la-capi`):
//!
//! * `place_json(problem, *, rgba=None, width=0, height=0, measure=None, cost=None,
//!   progress=None, cancelled=None) -> str`
//! * `validate_json(problem) -> str` (the report `{valid, errors, warnings}`)
//! * `render_svg(problem, result, *, rgba=None, width=0, height=0) -> str`
//! * `version() -> str`, `capabilities() -> dict`, and the `CancelToken` class.
//!
//! Invalid problems raise `label_anything.ValidationError` (a `ValueError` whose `errors`
//! are `{pointer, code, message}` dicts). Exceptions raised in callbacks propagate after
//! the solve stops; a cancelled solve raises `label_anything.Cancelled`. Panics never
//! cross the FFI boundary: they become `RuntimeError`. The typed Python API lives in
//! `python/label_anything/`.

mod env;
mod raster;

use env::{Callbacks, Cancel, PyEnv};
use label_anything::{Issue, NativeEnv, RgbaImage};
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::sync::PyOnceLock;
use pyo3::types::{PyDict, PyList, PyType};
use serde_json::Value;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

static VALIDATION_ERROR: PyOnceLock<Py<PyType>> = PyOnceLock::new();
static CANCELLED: PyOnceLock<Py<PyType>> = PyOnceLock::new();

/// A thread-safe cancellation flag, polled by the solver without the GIL.
///
/// Pass it as `cancelled=`; call `cancel()` from any thread (or a callback) to stop the
/// solve, which then raises `label_anything.Cancelled`.
#[pyclass(module = "label_anything", frozen)]
struct CancelToken {
    flag: Arc<AtomicBool>,
}

#[pymethods]
impl CancelToken {
    #[new]
    fn new() -> CancelToken {
        CancelToken {
            flag: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Request cancellation.
    fn cancel(&self) {
        self.flag.store(true, Ordering::Release);
    }

    /// Clear the request so the token can be reused.
    fn reset(&self) {
        self.flag.store(false, Ordering::Release);
    }

    /// Whether cancellation was requested.
    #[getter]
    fn cancelled(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }

    /// Same as `cancelled` (the `threading.Event` spelling).
    fn is_set(&self) -> bool {
        self.cancelled()
    }

    fn __repr__(&self) -> String {
        format!("CancelToken(cancelled={})", self.cancelled())
    }
}

fn issue_dicts<'py>(py: Python<'py>, issues: &[Issue]) -> PyResult<Bound<'py, PyList>> {
    let list = PyList::empty(py);
    for i in issues {
        let d = PyDict::new(py);
        d.set_item("pointer", &i.pointer)?;
        d.set_item("code", &i.code)?;
        d.set_item("message", &i.message)?;
        list.append(d)?;
    }
    Ok(list)
}

fn summary(errors: &[Issue]) -> String {
    let mut s = String::from("invalid problem");
    if let Some(e) = errors.first() {
        let at = if e.pointer.is_empty() {
            "/"
        } else {
            &e.pointer
        };
        s.push_str(&format!(": {at}: {} ({})", e.message, e.code));
        if errors.len() > 1 {
            s.push_str(&format!(" (and {} more)", errors.len() - 1));
        }
    }
    s
}

/// `label_anything.ValidationError(message, errors, warnings)`.
fn validation_error(py: Python<'_>, errors: &[Issue], warnings: &[Issue]) -> PyErr {
    let msg = summary(errors);
    let make = || -> PyResult<PyErr> {
        let cls = VALIDATION_ERROR.import(py, "label_anything._errors", "ValidationError")?;
        let exc = cls.call1((
            msg.as_str(),
            issue_dicts(py, errors)?,
            issue_dicts(py, warnings)?,
        ))?;
        Ok(PyErr::from_value(exc))
    };
    make().unwrap_or_else(|_| PyValueError::new_err(msg.clone()))
}

fn cancelled_error(py: Python<'_>) -> PyErr {
    let msg = "label placement was cancelled";
    let make = || -> PyResult<PyErr> {
        let cls = CANCELLED.import(py, "label_anything._errors", "Cancelled")?;
        Ok(PyErr::from_value(cls.call1((msg,))?))
    };
    make().unwrap_or_else(|_| PyRuntimeError::new_err(msg))
}

fn parse(py: Python<'_>, text: &str, what: &str) -> PyResult<Value> {
    serde_json::from_str(text).map_err(|e| {
        validation_error(
            py,
            &[Issue::new("", "parse", format!("invalid {what} JSON: {e}"))],
            &[],
        )
    })
}

fn panic_message(p: Box<dyn std::any::Any + Send>) -> String {
    let what = p
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| p.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into());
    format!("internal error in label placement (please report it): {what}")
}

fn optional_raster(
    rgba: Option<&Bound<'_, PyAny>>,
    width: u32,
    height: u32,
) -> PyResult<Option<RgbaImage>> {
    match rgba {
        Some(o) if !o.is_none() => raster::rgba_image(o, width, height).map(Some),
        _ => Ok(None),
    }
}

/// A callable argument (`None` = not installed).
fn callable(arg: Option<Bound<'_, PyAny>>, name: &str) -> PyResult<Option<Py<PyAny>>> {
    match arg {
        Some(f) if !f.is_none() => {
            if !f.is_callable() {
                return Err(pyo3::exceptions::PyTypeError::new_err(format!(
                    "{name} must be callable"
                )));
            }
            Ok(Some(f.unbind()))
        }
        _ => Ok(None),
    }
}

fn helper_class(py: Python<'_>, name: &str) -> Option<Py<PyAny>> {
    py.import("label_anything._types")
        .and_then(|m| m.getattr(name))
        .ok()
        .map(Bound::unbind)
}

fn on_main_thread(py: Python<'_>) -> bool {
    (|| -> PyResult<bool> {
        let threading = py.import("threading")?;
        let current = threading.call_method0("current_thread")?;
        Ok(current.is(&threading.call_method0("main_thread")?))
    })()
    .unwrap_or(false)
}

enum Outcome {
    Placed(String),
    Invalid(Vec<Issue>, Vec<Issue>),
    Panicked(String),
}

/// Solve a problem given as JSON text and return the result as JSON text.
///
/// `rgba`: raster background (NumPy uint8 `H×W×4`/`H×W×3`/`H×W`, PIL image, `bytes`,
/// ...) that replaces the image of the first `obstacles.raster` source, whose options
/// still apply; `width`/`height` are required for flat buffers.
/// `measure(text, font) -> {width, ascent, descent} | (w, a, d) | None`,
/// `cost(candidate) -> float >= 0`, `progress(phase, fraction)`, and `cancelled`, a
/// `CancelToken` or a callable returning `True` to stop.
#[pyfunction]
#[pyo3(signature = (problem, *, rgba=None, width=0, height=0, measure=None, cost=None, progress=None, cancelled=None))]
#[allow(clippy::too_many_arguments)]
fn place_json(
    py: Python<'_>,
    problem: String,
    rgba: Option<Bound<'_, PyAny>>,
    width: u32,
    height: u32,
    measure: Option<Bound<'_, PyAny>>,
    cost: Option<Bound<'_, PyAny>>,
    progress: Option<Bound<'_, PyAny>>,
    cancelled: Option<Bound<'_, PyAny>>,
) -> PyResult<String> {
    let value = parse(py, &problem, "problem")?;
    drop(problem);
    let image = optional_raster(rgba.as_ref(), width, height)?;
    let cancel = match cancelled {
        Some(c) if !c.is_none() => match c.cast::<CancelToken>() {
            Ok(tok) => Cancel::Token(tok.get().flag.clone()),
            Err(_) => Cancel::Callable(callable(Some(c), "cancelled")?.expect("checked not None")),
        },
        _ => Cancel::None,
    };
    let measure = callable(measure, "measure")?;
    let cost = callable(cost, "cost")?;
    let progress = callable(progress, "progress")?;
    let cb = Callbacks {
        font_spec: measure.as_ref().and_then(|_| helper_class(py, "FontSpec")),
        candidate: cost.as_ref().and_then(|_| helper_class(py, "Candidate")),
        bbox: cost.as_ref().and_then(|_| helper_class(py, "BBox")),
        measure,
        cost,
        progress,
        cancel,
        // Ctrl-C is delivered to the main thread only
        signals: on_main_thread(py),
    };
    let keep_raster = value.pointer("/output/debug_svg") == Some(&Value::Bool(true));
    let env = PyEnv::new(image, keep_raster, cb);
    if env.poll_cancel(true) {
        return Err(env.take_error().unwrap_or_else(|| cancelled_error(py)));
    }
    let outcome = py.detach(|| {
        catch_unwind(AssertUnwindSafe(|| {
            let report = label_anything::validate(&value);
            if !report.valid {
                return Outcome::Invalid(report.errors, report.warnings);
            }
            match label_anything::place_validated(&value, &env, report) {
                Ok(result) => {
                    if !env.stopped() {
                        env.progress_done();
                    }
                    Outcome::Placed(serde_json::to_string(&result).unwrap_or_default())
                }
                Err(e) => Outcome::Invalid(e.errors, vec![]),
            }
        }))
        .unwrap_or_else(|p| Outcome::Panicked(panic_message(p)))
    });
    if let Some(err) = env.take_error() {
        return Err(err);
    }
    if env.was_cancelled() {
        return Err(cancelled_error(py));
    }
    match outcome {
        Outcome::Placed(json) => Ok(json),
        Outcome::Invalid(errors, warnings) => Err(validation_error(py, &errors, &warnings)),
        Outcome::Panicked(msg) => Err(PyRuntimeError::new_err(msg)),
    }
}

/// Validate a problem given as JSON text; returns the report `{valid, errors, warnings}`
/// as JSON text (invalid JSON is reported as a `parse` error, not raised).
#[pyfunction]
fn validate_json(py: Python<'_>, problem: String) -> PyResult<String> {
    let report = py.detach(|| {
        catch_unwind(AssertUnwindSafe(|| {
            let r = match serde_json::from_str::<Value>(&problem) {
                Ok(v) => label_anything::validate(&v),
                Err(e) => label_anything::Report {
                    valid: false,
                    errors: vec![Issue::new(
                        "",
                        "parse",
                        format!("invalid problem JSON: {e}"),
                    )],
                    warnings: vec![],
                },
            };
            serde_json::to_string(&r).unwrap_or_default()
        }))
        .map_err(panic_message)
    });
    report.map_err(PyRuntimeError::new_err)
}

/// Render the debug SVG overlay of a problem and a result (both JSON text). Pass the same
/// `rgba` raster as to `place_json` when the problem's raster source is a placeholder.
#[pyfunction]
#[pyo3(signature = (problem, result, *, rgba=None, width=0, height=0))]
fn render_svg(
    py: Python<'_>,
    problem: String,
    result: String,
    rgba: Option<Bound<'_, PyAny>>,
    width: u32,
    height: u32,
) -> PyResult<String> {
    let p = parse(py, &problem, "problem")?;
    let r = parse(py, &result, "result")?;
    let image = optional_raster(rgba.as_ref(), width, height)?;
    let svg = py.detach(|| {
        catch_unwind(AssertUnwindSafe(|| match image {
            Some(img) => {
                label_anything::render_svg(&p, &r, &PyEnv::new(Some(img), false, Callbacks::none()))
            }
            None => label_anything::render_svg(&p, &r, &NativeEnv::new()),
        }))
        .map_err(panic_message)
    });
    svg.map_err(PyRuntimeError::new_err)
}

/// Version of the engine (e.g. `"0.1.0"`).
#[pyfunction]
fn version() -> &'static str {
    label_anything::VERSION
}

/// Optional features of this build: `{"svg": bool, "raster_formats": [...], ...}`.
#[pyfunction]
fn capabilities(py: Python<'_>) -> PyResult<Bound<'_, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("version", label_anything::VERSION)?;
    d.set_item("svg", label_anything::svg_backend().is_some())?;
    let formats: Vec<&str> = if cfg!(feature = "decode") {
        vec!["png", "jpeg", "webp"]
    } else {
        vec![]
    };
    d.set_item("raster_formats", formats)?;
    d.set_item("raw_rgba", true)?;
    d.set_item("abi3", true)?;
    Ok(d)
}

#[pymodule]
fn _native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(place_json, m)?)?;
    m.add_function(wrap_pyfunction!(validate_json, m)?)?;
    m.add_function(wrap_pyfunction!(render_svg, m)?)?;
    m.add_function(wrap_pyfunction!(version, m)?)?;
    m.add_function(wrap_pyfunction!(capabilities, m)?)?;
    m.add_class::<CancelToken>()?;
    m.add("__version__", label_anything::VERSION)?;
    Ok(())
}
