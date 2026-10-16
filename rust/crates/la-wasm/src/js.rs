//! Small JavaScript helpers (an inline wasm-bindgen snippet).
//!
//! The `cost` and `measure` trampolines build the callback arguments and check the return
//! value on the JavaScript side, so one candidate or one measurement costs a single
//! boundary crossing instead of one `Reflect.set`/`Reflect.get` per field.

use js_sys::Function;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(inline_js = r#"
export function laNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function laCost(f, itemId, x, y, w, h, leader) {
  const v = f({ itemId, box: { x, y, w, h }, leader });
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new TypeError(
      `label-anything: the cost callback must return a finite number (got ${String(v)} for item "${itemId}")`,
    );
  }
  return v;
}

export function laMeasure(f, text, family, weight, italic, size) {
  const m = f(text, { family, weight, italic, size });
  if (m === null || m === undefined) return undefined;
  const width = m.width, ascent = m.ascent, descent = m.descent;
  if (!Number.isFinite(width) || !Number.isFinite(ascent) || !Number.isFinite(descent)) {
    throw new TypeError(
      "label-anything: the measure callback must return null or {width, ascent, descent} with finite numbers",
    );
  }
  return [width, ascent, descent];
}
"#)]
extern "C" {
    /// Milliseconds from `performance.now()` (`Date.now()` where it is missing).
    #[wasm_bindgen(js_name = laNow)]
    pub fn now() -> f64;

    /// `f({itemId, box: {x, y, w, h}, leader})`, which must return a finite number.
    #[wasm_bindgen(catch, js_name = laCost)]
    pub fn cost(
        f: &Function,
        item_id: &JsValue,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        leader: bool,
    ) -> Result<f64, JsValue>;

    /// `f(text, {family, weight, italic, size})` as `[width, ascent, descent]`, or `None`
    /// when the callback returns `null`/`undefined` (built-in measurement).
    #[wasm_bindgen(catch, js_name = laMeasure)]
    pub fn measure(
        f: &Function,
        text: &str,
        family: &JsValue,
        weight: u16,
        italic: bool,
        size: f64,
    ) -> Result<Option<Vec<f64>>, JsValue>;
}
