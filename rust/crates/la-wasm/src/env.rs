//! The environment of one solve, backed by the JavaScript `PlaceOptions` of the call.
//!
//! * Clock: `performance.now()` (`std::time::Instant` panics on wasm32-unknown-unknown).
//! * Files: only through the optional `readFile` callback.
//! * SVG: the backend compiled into the facade ([`label_anything::svg_backend`]).
//! * Raster: `options.raster` pixels, copied once into WASM memory per model build.
//! * `measure`, `cost`, `progress`: JavaScript functions. The first exception thrown by
//!   any callback is kept; from then on no callback is called again (they return neutral
//!   values), [`Env::cancelled`] is true, and the binding rethrows the exception instead
//!   of returning the result. The core has no way to unwind, so "stop" means the solve
//!   finishes without calling back into JavaScript.
//! * `signal`: [`Env::cancelled`] reads `signal.aborted`. A synchronous `place` call
//!   blocks the JavaScript thread, so the flag can only change between solves or inside
//!   one of the callbacks.

use crate::js;
use js_sys::{ArrayBuffer, Function, Reflect, Uint8Array};
use la_core::geom::Rect;
use label_anything::{Env, FontSpec, RgbaImage, SvgBackend, TextMetrics};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use wasm_bindgen::{JsCast, JsValue};

/// `options.raster`: a view on the caller's bytes (not copied until the core asks).
struct Pixels {
    width: u32,
    height: u32,
    data: Uint8Array,
}

/// The JavaScript environment of one `place` call.
pub struct JsEnv {
    start: f64,
    measure: Option<Function>,
    cost: Option<Function>,
    progress: Option<Function>,
    read_file: Option<Function>,
    signal: Option<JsValue>,
    raster: Option<Pixels>,
    failed: Cell<bool>,
    error: Cell<Option<JsValue>>,
    /// Item ids as JavaScript strings (one conversion per item, not per candidate).
    ids: RefCell<HashMap<String, JsValue>>,
    families: RefCell<Vec<(String, JsValue)>>,
}

fn type_error(message: &str) -> JsValue {
    js_sys::TypeError::new(message).into()
}

fn range_error(message: &str) -> JsValue {
    js_sys::RangeError::new(message).into()
}

fn get(obj: &JsValue, key: &str) -> Result<JsValue, JsValue> {
    Reflect::get(obj, &JsValue::from_str(key))
}

fn is_absent(v: &JsValue) -> bool {
    v.is_undefined() || v.is_null()
}

fn function(options: &JsValue, key: &str) -> Result<Option<Function>, JsValue> {
    let v = get(options, key)?;
    if is_absent(&v) {
        return Ok(None);
    }
    v.dyn_into::<Function>()
        .map(Some)
        .map_err(|_| type_error(&format!("label-anything: options.{key} must be a function")))
}

/// A `Uint8Array` on the bytes of an ArrayBuffer view (any realm) or an `ArrayBuffer`,
/// without copying.
fn byte_view(v: &JsValue) -> Option<Uint8Array> {
    if let Some(a) = v.dyn_ref::<Uint8Array>() {
        return Some(a.clone());
    }
    if v.is_instance_of::<ArrayBuffer>() {
        return Some(Uint8Array::new(v));
    }
    if ArrayBuffer::is_view(v) {
        let buffer = get(v, "buffer").ok()?;
        let offset = get(v, "byteOffset").ok()?.as_f64()?;
        let length = get(v, "byteLength").ok()?.as_f64()?;
        return Some(Uint8Array::new_with_byte_offset_and_length(
            &buffer,
            offset as u32,
            length as u32,
        ));
    }
    None
}

fn dimension(raster: &JsValue, key: &str) -> Result<u32, JsValue> {
    match get(raster, key)?.as_f64() {
        Some(x) if x.fract() == 0.0 && x >= 1.0 && x <= u32::MAX as f64 => Ok(x as u32),
        _ => Err(type_error(&format!(
            "label-anything: options.raster.{key} must be a positive integer"
        ))),
    }
}

fn pixels(options: &JsValue) -> Result<Option<Pixels>, JsValue> {
    let r = get(options, "raster")?;
    if is_absent(&r) {
        return Ok(None);
    }
    if !r.is_object() {
        return Err(type_error(
            "label-anything: options.raster must be {width, height, data}",
        ));
    }
    let width = dimension(&r, "width")?;
    let height = dimension(&r, "height")?;
    let data = byte_view(&get(&r, "data")?).ok_or_else(|| {
        type_error("label-anything: options.raster.data must be a Uint8Array or Uint8ClampedArray")
    })?;
    let expected = width as u64 * height as u64 * 4;
    if data.length() as u64 != expected {
        return Err(range_error(&format!(
            "label-anything: options.raster.data has {} bytes, width * height * 4 = {expected}",
            data.length()
        )));
    }
    Ok(Some(Pixels {
        width,
        height,
        data,
    }))
}

impl JsEnv {
    /// An environment without callbacks (debug rendering).
    pub fn empty() -> JsEnv {
        JsEnv {
            start: js::now(),
            measure: None,
            cost: None,
            progress: None,
            read_file: None,
            signal: None,
            raster: None,
            failed: Cell::new(false),
            error: Cell::new(None),
            ids: RefCell::new(HashMap::new()),
            families: RefCell::new(Vec::new()),
        }
    }

    /// The environment of `options` (a `PlaceOptions` object, `undefined` or `null`).
    /// Wrong option types are a `TypeError`, a wrong pixel count a `RangeError`.
    pub fn from_options(options: &JsValue) -> Result<JsEnv, JsValue> {
        let mut env = JsEnv::empty();
        if is_absent(options) {
            return Ok(env);
        }
        if !options.is_object() {
            return Err(type_error(
                "label-anything: the options must be an object (PlaceOptions)",
            ));
        }
        env.measure = function(options, "measure")?;
        env.cost = function(options, "cost")?;
        env.progress = function(options, "progress")?;
        env.read_file = function(options, "readFile")?;
        let signal = get(options, "signal")?;
        if !is_absent(&signal) {
            if !signal.is_object() {
                return Err(type_error(
                    "label-anything: options.signal must be an AbortSignal",
                ));
            }
            env.signal = Some(signal);
        }
        env.raster = pixels(options)?;
        Ok(env)
    }

    /// Keep the first callback exception; later callbacks are skipped.
    fn fail(&self, e: JsValue) {
        if !self.failed.replace(true) {
            self.error.set(Some(e));
        }
    }

    /// The first exception thrown by a callback, if any.
    pub fn take_error(&self) -> Option<JsValue> {
        self.error.take()
    }

    /// Calls `f` with the item id as a JavaScript string, converted once per id.
    fn with_id<R>(&self, id: &str, f: impl FnOnce(&JsValue) -> R) -> R {
        let Ok(mut ids) = self.ids.try_borrow_mut() else {
            return f(&JsValue::from_str(id));
        };
        if let Some(v) = ids.get(id) {
            return f(v);
        }
        let v = JsValue::from_str(id);
        let r = f(&v);
        ids.insert(id.to_string(), v);
        r
    }

    fn with_family<R>(&self, family: &str, f: impl FnOnce(&JsValue) -> R) -> R {
        let Ok(mut fams) = self.families.try_borrow_mut() else {
            return f(&JsValue::from_str(family));
        };
        if let Some((_, v)) = fams.iter().find(|(name, _)| name == family) {
            return f(v);
        }
        let v = JsValue::from_str(family);
        let r = f(&v);
        fams.push((family.to_string(), v));
        r
    }
}

impl Env for JsEnv {
    fn svg(&self) -> Option<&dyn SvgBackend> {
        label_anything::svg_backend()
    }

    fn raster_override(&self) -> Option<RgbaImage> {
        let p = self.raster.as_ref()?;
        Some(RgbaImage {
            width: p.width,
            height: p.height,
            data: p.data.to_vec(),
        })
    }

    fn read_file(&self, path: &str) -> Result<Vec<u8>, String> {
        if self.failed.get() {
            return Err(format!("not read after a callback exception ({path})"));
        }
        let Some(f) = &self.read_file else {
            return Err(format!(
                "file access is not available in this environment ({path}); pass the readFile option"
            ));
        };
        match f.call1(&JsValue::UNDEFINED, &JsValue::from_str(path)) {
            Ok(v) => {
                if let Some(s) = v.as_string() {
                    return Ok(s.into_bytes());
                }
                match byte_view(&v) {
                    Some(bytes) => Ok(bytes.to_vec()),
                    None => {
                        self.fail(type_error(&format!(
                            "label-anything: readFile must return a Uint8Array (path {path})"
                        )));
                        Err(format!("readFile returned no bytes ({path})"))
                    }
                }
            }
            Err(e) => {
                self.fail(e);
                Err(format!("readFile threw ({path})"))
            }
        }
    }

    fn now_ms(&self) -> f64 {
        js::now() - self.start
    }

    fn measure(&self, text: &str, font: &FontSpec) -> Option<TextMetrics> {
        let f = self.measure.as_ref()?;
        if self.failed.get() {
            return None;
        }
        let r = self.with_family(&font.family, |family| {
            js::measure(f, text, family, font.weight, font.italic, font.size)
        });
        match r {
            Ok(Some(m)) if m.len() == 3 => Some(TextMetrics {
                width: m[0],
                ascent: m[1],
                descent: m[2],
            }),
            Ok(_) => None,
            Err(e) => {
                self.fail(e);
                None
            }
        }
    }

    fn extra_cost(&self, item_id: &str, bbox: &Rect, leader: bool) -> f64 {
        let Some(f) = &self.cost else { return 0.0 };
        if self.failed.get() {
            return 0.0;
        }
        let r = self.with_id(item_id, |id| {
            js::cost(f, id, bbox.x0, bbox.y0, bbox.w(), bbox.h(), leader)
        });
        r.unwrap_or_else(|e| {
            self.fail(e);
            0.0
        })
    }

    fn has_cost_callback(&self) -> bool {
        self.cost.is_some()
    }

    fn progress(&self, phase: &str, fraction: f64) {
        let Some(f) = &self.progress else { return };
        if self.failed.get() {
            return;
        }
        if let Err(e) = f.call2(
            &JsValue::UNDEFINED,
            &JsValue::from_str(phase),
            &JsValue::from_f64(fraction),
        ) {
            self.fail(e);
        }
    }

    fn cancelled(&self) -> bool {
        if self.failed.get() {
            return true;
        }
        let Some(signal) = &self.signal else {
            return false;
        };
        match get(signal, "aborted") {
            Ok(v) => v.is_truthy(),
            Err(e) => {
                self.fail(e);
                true
            }
        }
    }
}
