//! JNI entry points of the Java binding (cargo feature `jni`).
//!
//! Native methods of `io.github.fabianbeck.labelanything.JniNative` (`bindings/java`):
//!
//! ```java
//! static native byte[] version();
//! static native byte[] placeJson(byte[] problem, ByteBuffer rgbaDirect, byte[] rgbaArray,
//!                                int rgbaOffset, int width, int height);
//! static native byte[] validateJson(byte[] problem);
//! static native byte[] renderSvg(byte[] problem, byte[] result);
//! ```
//!
//! Text crosses the boundary as UTF-8 byte arrays rather than `jstring`, whose "modified
//! UTF-8" differs from UTF-8 for NUL and supplementary characters. Every reply except
//! `version` is `[code, utf8...]`: byte 0 is the return code of the C ABI (`LA_OK`,
//! `LA_INVALID`, `LA_ERROR`), the rest is the JSON (or SVG) text the C ABI would return.
//!
//! The raster comes either as a direct `ByteBuffer`, read in place through
//! `GetDirectBufferAddress` (the zero-copy path, as `la_place_json`), or as a region of a
//! `byte[]`; either way the pixels are copied once into the image, exactly like the C ABI.
//!
//! The JNI function table is called directly (indices from `jni.h`; the table is
//! append-only since JNI 1.1), so the feature adds no dependency.

use crate::{
    error_json, place_text, render_text, validate_text, validate_unreadable, LA_ERROR, LA_INVALID,
};
use label_anything::RgbaImage;
use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr::null_mut;

type JObject = *mut c_void;
type JInt = i32;
type JLong = i64;
type JBoolean = u8;
/// `JNIEnv *`: a pointer to the pointer to the function table.
type Env = *mut *const *const c_void;

// Indices into `struct JNINativeInterface_` (jni.h).
const GET_ARRAY_LENGTH: usize = 171;
const NEW_BYTE_ARRAY: usize = 176;
const GET_BYTE_ARRAY_REGION: usize = 200;
const SET_BYTE_ARRAY_REGION: usize = 208;
const EXCEPTION_CHECK: usize = 228;
const GET_DIRECT_BUFFER_ADDRESS: usize = 230;
const GET_DIRECT_BUFFER_CAPACITY: usize = 231;

/// What an entry point hands back to Java.
enum Out {
    /// `[code, utf8...]`.
    Reply(i32, String),
    /// Plain bytes (version string).
    Raw(Vec<u8>),
    /// A Java exception is pending (e.g. a bad array region): return null so it is thrown.
    Pending,
}

struct Jni(Env);

impl Jni {
    /// The function at `index` of the JNI function table.
    ///
    /// # Safety
    /// `self.0` must be the `JNIEnv *` of the current thread and `F` the exact
    /// `extern "system"` signature of that table entry.
    unsafe fn func<F: Copy>(&self, index: usize) -> F {
        debug_assert_eq!(
            std::mem::size_of::<F>(),
            std::mem::size_of::<*const c_void>()
        );
        let table: *const *const c_void = *self.0;
        let entry: *const c_void = *table.add(index);
        std::mem::transmute_copy::<*const c_void, F>(&entry)
    }

    unsafe fn exception_pending(&self) -> bool {
        let f: unsafe extern "system" fn(Env) -> JBoolean = self.func(EXCEPTION_CHECK);
        f(self.0) != 0
    }

    /// Copy `len` bytes of `array` starting at `start`; `None` if Java threw.
    unsafe fn read_region(&self, array: JObject, start: JInt, len: JInt) -> Option<Vec<u8>> {
        let f: unsafe extern "system" fn(Env, JObject, JInt, JInt, *mut i8) =
            self.func(GET_BYTE_ARRAY_REGION);
        let mut v = vec![0u8; len.max(0) as usize];
        f(self.0, array, start, len, v.as_mut_ptr() as *mut i8);
        if self.exception_pending() {
            None
        } else {
            Some(v)
        }
    }

    /// The whole content of a `byte[]` (`Some(empty)` for null).
    unsafe fn read_bytes(&self, array: JObject) -> Option<Vec<u8>> {
        if array.is_null() {
            return Some(Vec::new());
        }
        let len: unsafe extern "system" fn(Env, JObject) -> JInt = self.func(GET_ARRAY_LENGTH);
        let n = len(self.0, array);
        self.read_region(array, 0, n)
    }

    /// A new `byte[]` holding `parts` concatenated (null if Java threw, e.g. OOM).
    unsafe fn new_bytes(&self, parts: &[&[u8]]) -> JObject {
        let total: usize = parts.iter().map(|p| p.len()).sum();
        let Ok(total) = JInt::try_from(total) else {
            return null_mut();
        };
        let new: unsafe extern "system" fn(Env, JInt) -> JObject = self.func(NEW_BYTE_ARRAY);
        let set: unsafe extern "system" fn(Env, JObject, JInt, JInt, *const i8) =
            self.func(SET_BYTE_ARRAY_REGION);
        let array = new(self.0, total);
        if array.is_null() || self.exception_pending() {
            return null_mut();
        }
        let mut at: JInt = 0;
        for p in parts {
            if !p.is_empty() {
                // fits: the sum fits in a jint
                set(self.0, array, at, p.len() as JInt, p.as_ptr() as *const i8);
                at += p.len() as JInt;
            }
        }
        array
    }

    /// Address and capacity of a direct `ByteBuffer` (`None` if it is not direct).
    unsafe fn direct_buffer(&self, buffer: JObject) -> Option<(*const u8, JLong)> {
        let addr: unsafe extern "system" fn(Env, JObject) -> *mut c_void =
            self.func(GET_DIRECT_BUFFER_ADDRESS);
        let cap: unsafe extern "system" fn(Env, JObject) -> JLong =
            self.func(GET_DIRECT_BUFFER_CAPACITY);
        let a = addr(self.0, buffer);
        let c = cap(self.0, buffer);
        if a.is_null() || c < 0 {
            None
        } else {
            Some((a as *const u8, c))
        }
    }
}

/// Run an entry point body, turning panics into an `LA_ERROR` reply.
unsafe fn run(env: Env, body: impl FnOnce(&Jni) -> Out) -> JObject {
    let jni = Jni(env);
    let out = catch_unwind(AssertUnwindSafe(|| body(&jni))).unwrap_or_else(|_| {
        Out::Reply(
            LA_ERROR,
            error_json("internal", "internal error (panic) in the JNI entry point"),
        )
    });
    match out {
        Out::Reply(code, text) => jni.new_bytes(&[&[code as u8], text.as_bytes()]),
        Out::Raw(bytes) => jni.new_bytes(&[&bytes]),
        Out::Pending => null_mut(),
    }
}

/// UTF-8 text of a `byte[]`, or the reply to send instead.
unsafe fn text_of(jni: &Jni, array: JObject, code_on_error: i32) -> Result<String, Out> {
    let Some(bytes) = jni.read_bytes(array) else {
        return Err(Out::Pending);
    };
    String::from_utf8(bytes).map_err(|e| {
        Out::Reply(
            code_on_error,
            error_json("parse", &format!("invalid UTF-8: {e}")),
        )
    })
}

/// `static native byte[] version()`: the library version (UTF-8, no return code).
///
/// # Safety
/// Called by the JVM with a valid `JNIEnv *`.
#[no_mangle]
pub unsafe extern "system" fn Java_io_github_fabianbeck_labelanything_JniNative_version(
    env: Env,
    _class: JObject,
) -> JObject {
    run(env, |_| {
        Out::Raw(env!("CARGO_PKG_VERSION").as_bytes().to_vec())
    })
}

/// `static native byte[] placeJson(byte[] problem, ByteBuffer rgbaDirect, byte[] rgbaArray,
/// int rgbaOffset, int width, int height)`: `la_place_json`. With `width > 0 && height > 0`
/// the raster comes from `rgbaDirect` (a direct buffer of at least `width * height * 4`
/// bytes from its address) or else from `rgbaArray[rgbaOffset..]`.
///
/// # Safety
/// Called by the JVM with a valid `JNIEnv *` and arguments of the declared Java types.
#[no_mangle]
pub unsafe extern "system" fn Java_io_github_fabianbeck_labelanything_JniNative_placeJson(
    env: Env,
    _class: JObject,
    problem: JObject,
    rgba_direct: JObject,
    rgba_array: JObject,
    rgba_offset: JInt,
    width: JInt,
    height: JInt,
) -> JObject {
    run(env, |jni| {
        let text = match text_of(jni, problem, LA_ERROR) {
            Ok(t) => t,
            Err(out) => return out,
        };
        let mut img = None;
        if width > 0 && height > 0 && !(rgba_direct.is_null() && rgba_array.is_null()) {
            let len = width as u64 * height as u64 * 4;
            let too_large = || {
                Out::Reply(
                    LA_ERROR,
                    error_json(
                        "invalid_value",
                        &format!("raster of {width}x{height} pixels is too large"),
                    ),
                )
            };
            let data = if !rgba_direct.is_null() {
                let Some((addr, cap)) = jni.direct_buffer(rgba_direct) else {
                    return Out::Reply(
                        LA_ERROR,
                        error_json(
                            "invalid_value",
                            "the rgba buffer is not a direct ByteBuffer",
                        ),
                    );
                };
                if (cap as u64) < len {
                    return Out::Reply(
                        LA_ERROR,
                        error_json(
                            "invalid_value",
                            &format!("the rgba buffer holds {cap} bytes, {width}x{height}x4 = {len} needed"),
                        ),
                    );
                }
                let Ok(n) = usize::try_from(len) else {
                    return too_large();
                };
                // SAFETY: the JVM guarantees `cap` readable bytes at `addr` while the
                // buffer is reachable (it is an argument of this call); `n <= cap`.
                std::slice::from_raw_parts(addr, n).to_vec()
            } else {
                let Ok(n) = JInt::try_from(len) else {
                    return too_large();
                };
                match jni.read_region(rgba_array, rgba_offset, n) {
                    Some(d) => d,
                    None => return Out::Pending,
                }
            };
            img = Some(RgbaImage {
                width: width as u32,
                height: height as u32,
                data,
            });
        }
        let (code, out) = place_text(&text, img);
        Out::Reply(code, out)
    })
}

/// `static native byte[] validateJson(byte[] problem)`: `la_validate_json`.
///
/// # Safety
/// Called by the JVM with a valid `JNIEnv *` and a `byte[]` argument.
#[no_mangle]
pub unsafe extern "system" fn Java_io_github_fabianbeck_labelanything_JniNative_validateJson(
    env: Env,
    _class: JObject,
    problem: JObject,
) -> JObject {
    run(env, |jni| {
        let Some(bytes) = jni.read_bytes(problem) else {
            return Out::Pending;
        };
        match String::from_utf8(bytes) {
            Ok(text) => {
                let (code, out) = validate_text(&text);
                Out::Reply(code, out)
            }
            Err(e) => Out::Reply(
                LA_INVALID,
                validate_unreadable(&format!("invalid UTF-8: {e}")),
            ),
        }
    })
}

/// `static native byte[] renderSvg(byte[] problem, byte[] result)`: `la_render_svg`.
///
/// # Safety
/// Called by the JVM with a valid `JNIEnv *` and `byte[]` arguments.
#[no_mangle]
pub unsafe extern "system" fn Java_io_github_fabianbeck_labelanything_JniNative_renderSvg(
    env: Env,
    _class: JObject,
    problem: JObject,
    result: JObject,
) -> JObject {
    run(env, |jni| {
        let p = match text_of(jni, problem, LA_ERROR) {
            Ok(t) => t,
            Err(out) => return out,
        };
        let r = match text_of(jni, result, LA_ERROR) {
            Ok(t) => t,
            Err(out) => return out,
        };
        let (code, out) = render_text(&p, &r);
        Out::Reply(code, out)
    })
}
