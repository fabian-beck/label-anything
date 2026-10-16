//! C ABI of Label Anything (see `include/label_anything.h`).
//!
//! JSON in, JSON out. `la_place_json` also accepts a raster background as a raw RGBA8
//! buffer, which skips base64 and image decoding entirely (the buffer is read once).

use label_anything::{Env, NativeEnv, RgbaImage};
use serde_json::Value;
use std::ffi::{c_char, CStr, CString};

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
    fn raster(&self) -> Option<&dyn label_anything::RasterBackend> {
        self.inner.raster()
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
    let env = CEnv {
        inner: NativeEnv::new(),
        rgba: img,
    };
    let v: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            out_string(result, error_json("parse", &format!("invalid JSON: {e}")));
            return LA_INVALID;
        }
    };
    let report = label_anything::validate(&v);
    if !report.valid {
        out_string(
            result,
            serde_json::to_string(&report.errors).unwrap_or_default(),
        );
        return LA_INVALID;
    }
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        label_anything::place_validated(&v, &env, report)
    })) {
        Ok(Ok(r)) => {
            out_string(result, serde_json::to_string(&r).unwrap_or_default());
            LA_OK
        }
        Ok(Err(e)) => {
            out_string(result, serde_json::to_string(&e.errors).unwrap_or_default());
            LA_INVALID
        }
        Err(_) => {
            out_string(
                result,
                error_json("internal", "internal error (panic) in label placement"),
            );
            LA_ERROR
        }
    }
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
            out_string(report, serde_json::json!({"valid": false, "errors": [{"pointer": "", "code": "parse", "message": e}], "warnings": []}).to_string());
            return LA_INVALID;
        }
    };
    let r = match serde_json::from_str::<Value>(&text) {
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
    let valid = r.valid;
    out_string(report, serde_json::to_string(&r).unwrap_or_default());
    if valid {
        LA_OK
    } else {
        LA_INVALID
    }
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
    match (
        serde_json::from_str::<Value>(&p),
        serde_json::from_str::<Value>(&r),
    ) {
        (Ok(pv), Ok(rv)) => {
            out_string(svg, label_anything::render_svg(&pv, &rv, &NativeEnv::new()));
            LA_OK
        }
        _ => {
            out_string(svg, error_json("parse", "invalid JSON"));
            LA_INVALID
        }
    }
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
}
