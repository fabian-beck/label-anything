//! [`PyEnv`]: the solve environment of the Python binding.
//!
//! It wraps [`NativeEnv`] (files, clock), delegates SVG parsing to the facade's backend,
//! hands a raster background to the core through `raster_override`, and forwards the host
//! callbacks (`measure`, `cost`, `progress`, `cancelled`) to Python.
//!
//! The solve runs with the GIL released; every callback reattaches to the interpreter.
//! The first exception raised by a callback is stored and stops the solve as early as the
//! core allows: later callbacks become no-ops and the clock jumps past every deadline, so
//! the greedy pass skips its remaining priority bands and local search ends at its next
//! clock check. The caller re-raises the stored exception once the core has returned.
//! Cancellation works the same way.

use la_core::geom::Rect;
use label_anything::{Env, FontSpec, NativeEnv, RgbaImage, SvgBackend, TextMetrics};
use pyo3::exceptions::{PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList, PyTuple};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

/// How far the clock jumps per call once the solve is stopped (ms): far beyond any time
/// budget, and strictly increasing, so deadlines computed after the stop are passed too.
const STOP_JUMP_MS: f64 = 1e12;
/// Minimum interval between calls of a Python `cancelled` callable (ms of solve time).
const CANCEL_POLL_MS: f64 = 1.0;
/// Minimum interval between interpreter signal checks (Ctrl-C) when no callback runs.
const SIGNAL_POLL_MS: f64 = 25.0;

/// Where cancellation requests come from.
pub(crate) enum Cancel {
    None,
    /// A native `CancelToken` (polled without the GIL).
    Token(Arc<AtomicBool>),
    /// A Python callable returning a truthy value to cancel.
    Callable(Py<PyAny>),
}

/// Python callbacks and the helper classes used to build their arguments.
pub(crate) struct Callbacks {
    pub measure: Option<Py<PyAny>>,
    pub cost: Option<Py<PyAny>>,
    pub progress: Option<Py<PyAny>>,
    pub cancel: Cancel,
    /// `label_anything._types.FontSpec`, `.Candidate` and `.BBox` (argument types).
    pub font_spec: Option<Py<PyAny>>,
    pub candidate: Option<Py<PyAny>>,
    pub bbox: Option<Py<PyAny>>,
    /// Check for Ctrl-C while solving (the solve was started on the main thread).
    pub signals: bool,
}

impl Callbacks {
    pub(crate) fn none() -> Callbacks {
        Callbacks {
            measure: None,
            cost: None,
            progress: None,
            cancel: Cancel::None,
            font_spec: None,
            candidate: None,
            bbox: None,
            signals: false,
        }
    }
}

type MeasureKey = (String, String, u16, bool, u64);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // a poisoned lock only means another callback panicked; the data is still usable
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) struct PyEnv {
    native: NativeEnv,
    raster: Mutex<Option<RgbaImage>>,
    /// Clone the raster instead of moving it out (the facade builds the model twice when
    /// `output.debug_svg` is set).
    keep_raster: bool,
    cb: Callbacks,
    measured: Mutex<HashMap<MeasureKey, Option<TextMetrics>>>,
    error: Mutex<Option<PyErr>>,
    stopped: AtomicBool,
    cancelled: AtomicBool,
    jumps: AtomicU64,
    /// Solve time (ms, f64 bits) of the last cancel poll / signal check.
    last_cancel_poll: AtomicU64,
    last_signal_check: AtomicU64,
}

impl PyEnv {
    pub(crate) fn new(raster: Option<RgbaImage>, keep_raster: bool, cb: Callbacks) -> PyEnv {
        PyEnv {
            native: NativeEnv::new(),
            raster: Mutex::new(raster),
            keep_raster,
            cb,
            measured: Mutex::new(HashMap::new()),
            error: Mutex::new(None),
            stopped: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            jumps: AtomicU64::new(0),
            last_cancel_poll: AtomicU64::new(f64::NEG_INFINITY.to_bits()),
            last_signal_check: AtomicU64::new(0f64.to_bits()),
        }
    }

    /// Whether the solve was stopped by an exception or a cancellation.
    pub(crate) fn stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }

    pub(crate) fn was_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    /// The first exception raised by a callback, if any.
    pub(crate) fn take_error(&self) -> Option<PyErr> {
        lock(&self.error).take()
    }

    fn fail(&self, err: PyErr) {
        let mut slot = lock(&self.error);
        if slot.is_none() {
            *slot = Some(err);
        }
        self.stopped.store(true, Ordering::Release);
    }

    fn cancel_now(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.stopped.store(true, Ordering::Release);
    }

    /// Ask the cancellation source (rate-limited for Python callables); `true` if the solve
    /// must stop.
    pub(crate) fn poll_cancel(&self, force: bool) -> bool {
        if self.stopped() {
            return true;
        }
        match &self.cb.cancel {
            Cancel::None => {}
            Cancel::Token(flag) => {
                if flag.load(Ordering::Acquire) {
                    self.cancel_now();
                }
            }
            Cancel::Callable(f) => {
                let t = self.native.now_ms();
                let last = f64::from_bits(self.last_cancel_poll.load(Ordering::Relaxed));
                if force || t - last >= CANCEL_POLL_MS {
                    self.last_cancel_poll.store(t.to_bits(), Ordering::Relaxed);
                    match Python::attach(|py| f.bind(py).call0()?.is_truthy()) {
                        Ok(true) => self.cancel_now(),
                        Ok(false) => {}
                        Err(e) => self.fail(e),
                    }
                }
            }
        }
        self.stopped()
    }

    /// Run pending signal handlers (Ctrl-C raises `KeyboardInterrupt`), rate-limited.
    fn check_signals(&self, t: f64) {
        if !self.cb.signals {
            return;
        }
        let last = f64::from_bits(self.last_signal_check.load(Ordering::Relaxed));
        if t - last < SIGNAL_POLL_MS {
            return;
        }
        self.last_signal_check.store(t.to_bits(), Ordering::Relaxed);
        if let Err(e) = Python::attach(|py| py.check_signals()) {
            self.fail(e);
        }
    }

    /// Report the end of a successful solve.
    pub(crate) fn progress_done(&self) {
        self.progress("done", 1.0);
    }

    fn font_arg<'py>(&self, py: Python<'py>, font: &FontSpec) -> PyResult<Bound<'py, PyAny>> {
        let args = (font.family.as_str(), font.weight, font.italic, font.size);
        match &self.cb.font_spec {
            Some(cls) => cls.bind(py).call1(args),
            None => Ok(args.into_pyobject(py)?.into_any()),
        }
    }

    fn candidate_arg<'py>(
        &self,
        py: Python<'py>,
        id: &str,
        r: &Rect,
        leader: bool,
    ) -> PyResult<Bound<'py, PyAny>> {
        let bbox = match &self.cb.bbox {
            Some(cls) => cls.bind(py).call1((r.x0, r.y0, r.w(), r.h()))?,
            None => (r.x0, r.y0, r.w(), r.h()).into_pyobject(py)?.into_any(),
        };
        match &self.cb.candidate {
            Some(cls) => cls.bind(py).call1((id, bbox, leader)),
            None => Ok((id, bbox, leader).into_pyobject(py)?.into_any()),
        }
    }
}

/// Read one finite, non-negative number from a callback result.
fn metric(v: &Bound<'_, PyAny>, name: &str) -> PyResult<f64> {
    let x: f64 = v.extract().map_err(|_| {
        PyTypeError::new_err(format!(
            "measure callback: {name} must be a number (got {})",
            v.get_type()
                .name()
                .map(|n| n.to_string())
                .unwrap_or_default()
        ))
    })?;
    if !x.is_finite() || x < 0.0 {
        return Err(PyValueError::new_err(format!(
            "measure callback: {name} must be finite and >= 0 (got {x})"
        )));
    }
    Ok(x)
}

/// Accept `None`, a mapping or an object with `width`/`ascent`/`descent`, or a 3-sequence.
fn parse_metrics(r: &Bound<'_, PyAny>) -> PyResult<Option<TextMetrics>> {
    if r.is_none() {
        return Ok(None);
    }
    let names = ["width", "ascent", "descent"];
    let mut vals = [0.0; 3];
    if let Ok(d) = r.cast::<PyDict>() {
        for (v, k) in vals.iter_mut().zip(names) {
            let item = d.get_item(k)?.ok_or_else(|| {
                PyTypeError::new_err(format!("measure callback result has no '{k}' key"))
            })?;
            *v = metric(&item, k)?;
        }
    } else if r.cast::<PyTuple>().is_ok() || r.cast::<PyList>().is_ok() {
        let seq: Vec<Bound<'_, PyAny>> = r.extract()?;
        if seq.len() != 3 {
            return Err(PyTypeError::new_err(
                "measure callback must return (width, ascent, descent)",
            ));
        }
        for ((v, k), item) in vals.iter_mut().zip(names).zip(&seq) {
            *v = metric(item, k)?;
        }
    } else {
        for (v, k) in vals.iter_mut().zip(names) {
            let item = r.getattr(k).map_err(|_| {
                PyTypeError::new_err(
                    "measure callback must return a dict or object with width, ascent and \
                     descent, a (width, ascent, descent) tuple, or None",
                )
            })?;
            *v = metric(&item, k)?;
        }
    }
    Ok(Some(TextMetrics {
        width: vals[0],
        ascent: vals[1],
        descent: vals[2],
    }))
}

impl Env for PyEnv {
    fn svg(&self) -> Option<&dyn SvgBackend> {
        label_anything::svg_backend()
    }

    fn raster_override(&self) -> Option<RgbaImage> {
        let mut slot = lock(&self.raster);
        if self.keep_raster {
            slot.clone()
        } else {
            slot.take()
        }
    }

    fn read_file(&self, path: &str) -> Result<Vec<u8>, String> {
        self.native.read_file(path)
    }

    fn now_ms(&self) -> f64 {
        let t = self.native.now_ms();
        self.check_signals(t);
        if self.poll_cancel(false) {
            let n = self.jumps.fetch_add(1, Ordering::Relaxed) + 1;
            return t + STOP_JUMP_MS * n as f64;
        }
        t
    }

    fn measure(&self, text: &str, font: &FontSpec) -> Option<TextMetrics> {
        let f = self.cb.measure.as_ref()?;
        if self.stopped() {
            return None;
        }
        let key: MeasureKey = (
            text.to_string(),
            font.family.clone(),
            font.weight,
            font.italic,
            font.size.to_bits(),
        );
        if let Some(hit) = lock(&self.measured).get(&key) {
            return *hit;
        }
        let out = Python::attach(|py| {
            let r = f.bind(py).call1((text, self.font_arg(py, font)?))?;
            parse_metrics(&r)
        });
        match out {
            Ok(m) => {
                lock(&self.measured).insert(key, m);
                m
            }
            Err(e) => {
                self.fail(e);
                None
            }
        }
    }

    fn extra_cost(&self, item_id: &str, bbox: &Rect, leader: bool) -> f64 {
        let Some(f) = &self.cb.cost else { return 0.0 };
        if self.stopped() {
            return 0.0;
        }
        let out = Python::attach(|py| -> PyResult<f64> {
            let r = f
                .bind(py)
                .call1((self.candidate_arg(py, item_id, bbox, leader)?,))?;
            let v: f64 = r
                .extract()
                .map_err(|_| PyTypeError::new_err("cost callback must return a number"))?;
            if !v.is_finite() || v < 0.0 {
                return Err(PyValueError::new_err(format!(
                    "cost callback must return a finite number >= 0 (got {v})"
                )));
            }
            Ok(v)
        });
        out.unwrap_or_else(|e| {
            self.fail(e);
            0.0
        })
    }

    fn has_cost_callback(&self) -> bool {
        self.cb.cost.is_some()
    }

    fn progress(&self, phase: &str, fraction: f64) {
        if self.poll_cancel(true) {
            return;
        }
        if let Some(f) = &self.cb.progress {
            if let Err(e) = Python::attach(|py| f.bind(py).call1((phase, fraction)).map(drop)) {
                self.fail(e);
            }
        }
    }

    fn cancelled(&self) -> bool {
        self.poll_cancel(false)
    }
}
