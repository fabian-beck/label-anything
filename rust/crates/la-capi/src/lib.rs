//! C ABI of Label Anything (see `include/label_anything.h`).
//!
//! JSON in, JSON out. `la_place_json` also accepts a raster background as a raw RGBA8
//! buffer, which skips base64 and image decoding entirely (the buffer is read once).
//!
//! With the cargo feature `jni`, the same library also exports the JNI entry points of
//! the Java binding (`bindings/java`, class `io.github.fabianbeck.labelanything.JniNative`).
//! Both entry points share the implementation below, so the C ABI (used by the Java FFM
//! path) and the JNI path give identical results.

use label_anything::{Env, NativeEnv, RgbaImage};
use serde_json::Value;
use std::ffi::{c_char, CStr, CString};

#[cfg(feature = "jni")]
mod jni;

pub const LA_OK: i32 = 0;
pub const LA_INVALID: i32 = 1;
pub const LA_ERROR: i32 = 2;

struct CEnv {
    inner: NativeEnv,
    rgba: Option<RgbaImage>,
}

impl Env for CEnv {
    fn svg(&self) -> Option<&dyn label_anything::SvgBackend> {
        self.inner.svg()
    }
    fn raster_override(&self) -> Option<RgbaImage> {
        self.rgba.clone()
    }
    fn read_file(&self, path: &str) -> Result<Vec<u8>, String> {
        self.inner.read_file(path)
    }
    fn now_ms(&self) -> f64 {
        self.inner.now_ms()
    }
    fn has_measure_callback(&self) -> bool {
        false
    }
}

fn out_string(dst: *mut *mut c_char, s: String) {
    if dst.is_null() {
        return;
    }
    let c = CString::new(s.replace('\0', "")).unwrap_or_default();
    // SAFETY: `dst` is a valid pointer provided by the caller (checked non-null).
    unsafe { *dst = c.into_raw() };
}

fn error_json(code: &str, message: &str) -> String {
    serde_json::json!([{ "pointer": "", "code": code, "message": message }]).to_string()
}

/// # Safety
/// `ptr` must be NULL or a valid NUL-terminated string.
unsafe fn read_str(ptr: *const c_char) -> Result<String, String> {
    if ptr.is_null() {
        return Err("null string".into());
    }
    CStr::from_ptr(ptr)
        .to_str()
        .map(str::to_string)
        .map_err(|e| format!("invalid UTF-8: {e}"))
}

/// Solve a problem given as JSON text, with an optional raster override. Returns the
/// return code and the result JSON (or the JSON array of errors).
pub(crate) fn place_text(text: &str, img: Option<RgbaImage>) -> (i32, String) {
    let env = CEnv {
        inner: NativeEnv::new(),
        rgba: img,
    };
    let v: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            return (
                LA_INVALID,
                error_json("parse", &format!("invalid JSON: {e}")),
            )
        }
    };
    let report = label_anything::validate(&v);
    if !report.valid {
        return (
            LA_INVALID,
            serde_json::to_string(&report.errors).unwrap_or_default(),
        );
    }
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        label_anything::place_validated(&v, &env, report)
    })) {
        Ok(Ok(r)) => (LA_OK, serde_json::to_string(&r).unwrap_or_default()),
        Ok(Err(e)) => (
            LA_INVALID,
            serde_json::to_string(&e.errors).unwrap_or_default(),
        ),
        Err(_) => (
            LA_ERROR,
            error_json("internal", "internal error (panic) in label placement"),
        ),
    }
}

/// Validate a problem given as JSON text: return code and the report JSON.
pub(crate) fn validate_text(text: &str) -> (i32, String) {
    let r = match serde_json::from_str::<Value>(text) {
        Ok(v) => label_anything::validate(&v),
        Err(e) => label_anything::Report {
            valid: false,
            errors: vec![label_anything::Issue::new(
                "",
                "parse",
                format!("invalid JSON: {e}"),
            )],
            warnings: vec![],
        },
    };
    let code = if r.valid { LA_OK } else { LA_INVALID };
    (code, serde_json::to_string(&r).unwrap_or_default())
}

/// Report JSON for a problem that is not even a string (NULL or invalid UTF-8).
pub(crate) fn validate_unreadable(message: &str) -> String {
    serde_json::json!({"valid": false, "errors": [{"pointer": "", "code": "parse", "message": message}], "warnings": []}).to_string()
}

/// Render the debug SVG of a problem and a result given as JSON text.
pub(crate) fn render_text(problem: &str, result: &str) -> (i32, String) {
    match (
        serde_json::from_str::<Value>(problem),
        serde_json::from_str::<Value>(result),
    ) {
        (Ok(pv), Ok(rv)) => (
            LA_OK,
            label_anything::render_svg(&pv, &rv, &NativeEnv::new()),
        ),
        _ => (LA_INVALID, error_json("parse", "invalid JSON")),
    }
}

/// Solve a problem. See the header for the contract.
///
/// # Safety
/// `problem` must be a valid NUL-terminated UTF-8 string; `rgba` must be NULL or point to
/// `width * height * 4` readable bytes; `result` must be a valid pointer.
#[no_mangle]
pub unsafe extern "C" fn la_place_json(
    problem: *const c_char,
    rgba: *const u8,
    width: u32,
    height: u32,
    result: *mut *mut c_char,
) -> i32 {
    let text = match read_str(problem) {
        Ok(t) => t,
        Err(e) => {
            out_string(result, error_json("parse", &e));
            return LA_ERROR;
        }
    };
    let img = if rgba.is_null() || width == 0 || height == 0 {
        None
    } else {
        let len = width as usize * height as usize * 4;
        Some(RgbaImage {
            width,
            height,
            data: std::slice::from_raw_parts(rgba, len).to_vec(),
        })
    };
    let (code, out) = place_text(&text, img);
    out_string(result, out);
    code
}

/// Validate a problem.
///
/// # Safety
/// `problem` must be a valid NUL-terminated UTF-8 string; `report` a valid pointer.
#[no_mangle]
pub unsafe extern "C" fn la_validate_json(problem: *const c_char, report: *mut *mut c_char) -> i32 {
    let text = match read_str(problem) {
        Ok(t) => t,
        Err(e) => {
            out_string(report, validate_unreadable(&e));
            return LA_INVALID;
        }
    };
    let (code, out) = validate_text(&text);
    out_string(report, out);
    code
}

/// Render the debug SVG overlay.
///
/// # Safety
/// `problem` and `result_json` must be valid NUL-terminated UTF-8 strings; `svg` a valid pointer.
#[no_mangle]
pub unsafe extern "C" fn la_render_svg(
    problem: *const c_char,
    result_json: *const c_char,
    svg: *mut *mut c_char,
) -> i32 {
    let (Ok(p), Ok(r)) = (read_str(problem), read_str(result_json)) else {
        out_string(svg, error_json("parse", "null or invalid string"));
        return LA_ERROR;
    };
    let (code, out) = render_text(&p, &r);
    out_string(svg, out);
    code
}

/// Library version (static).
#[no_mangle]
pub extern "C" fn la_version() -> *const c_char {
    static V: &[u8] = concat!(env!("CARGO_PKG_VERSION"), "\0").as_bytes();
    V.as_ptr() as *const c_char
}

/// Free a string returned by this library.
///
/// # Safety
/// `s` must be NULL or a pointer previously returned by this library and not yet freed.
#[no_mangle]
pub unsafe extern "C" fn la_free(s: *mut c_char) {
    if !s.is_null() {
        drop(CString::from_raw(s));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let p = CString::new(r#"{"items":[{"anchor":{"type":"point","x":10,"y":10},"label":{"type":"text","text":"A"}}]}"#).unwrap();
        let mut out: *mut c_char = std::ptr::null_mut();
        let rc = unsafe { la_place_json(p.as_ptr(), std::ptr::null(), 0, 0, &mut out) };
        assert_eq!(rc, LA_OK);
        let s = unsafe { CStr::from_ptr(out) }.to_str().unwrap().to_string();
        unsafe { la_free(out) };
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["stats"]["placed"], 1);
        let bad = CString::new(r#"{"items":[{"anchor":{"type":"point"}}]}"#).unwrap();
        let rc = unsafe { la_place_json(bad.as_ptr(), std::ptr::null(), 0, 0, &mut out) };
        assert_eq!(rc, LA_INVALID);
        unsafe { la_free(out) };
    }

    #[test]
    fn validate_and_render() {
        let mut out: *mut c_char = std::ptr::null_mut();
        let bad = CString::new(r#"{"items":[{"anchor":{"type":"point","x":1}}]}"#).unwrap();
        let rc = unsafe { la_validate_json(bad.as_ptr(), &mut out) };
        assert_eq!(rc, LA_INVALID);
        let s = unsafe { CStr::from_ptr(out) }.to_str().unwrap().to_string();
        unsafe { la_free(out) };
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["valid"], false);
        let (code, svg) = render_text(
            r#"{"canvas":{"width":10,"height":10},"items":[]}"#,
            r#"{"version":"1","placements":[],"stats":{}}"#,
        );
        assert_eq!(code, LA_OK);
        assert!(svg.contains("<svg"), "{svg}");
    }
}
