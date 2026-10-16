//! Raster backgrounds from Python objects, copied once into an [`RgbaImage`].
//!
//! The extension uses the abi3 stable ABI for CPython >= 3.9, where the C buffer API
//! (`PyObject_GetBuffer`) is not available (it joined the limited API in 3.11). Pixels are
//! therefore read through
//!
//! * the NumPy array interface (`__array_interface__`: data pointer, shape, strides),
//!   which NumPy arrays, PIL images and many array libraries implement;
//! * `bytes` / `bytearray`, borrowed directly;
//! * any other buffer object (`memoryview`, `array.array`, ...) through `bytes(obj)`, which
//!   costs one extra copy.
//!
//! Accepted layouts: `H×W×4` (RGBA), `H×W×3` (RGB), `H×W×2` (grey + alpha), `H×W×1` and
//! `H×W` (grey), all `uint8`, any strides; or a flat buffer of `W·H·{4,3,1}` bytes with
//! explicit `width` and `height`.

use label_anything::RgbaImage;
use pyo3::exceptions::{PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyByteArray, PyBytes, PyDict, PyTuple};

/// Largest accepted image: 512 MiB of RGBA data (the PNG decoder's limit, spec §4.6).
const MAX_BYTES: usize = 512 << 20;

/// A strided view of `h × w × c` bytes.
struct View {
    ptr: *const u8,
    /// Length of the underlying allocation when known (bounds are checked against it).
    len: Option<usize>,
    h: usize,
    w: usize,
    c: usize,
    /// Byte strides of the row, column and channel axes.
    strides: [isize; 3],
}

impl View {
    fn contiguous(ptr: *const u8, len: usize, (h, w, c): (usize, usize, usize)) -> View {
        View {
            ptr,
            len: Some(len),
            h,
            w,
            c,
            strides: c_strides(w, c),
        }
    }

    fn check_bounds(&self) -> PyResult<()> {
        let Some(len) = self.len else { return Ok(()) };
        // lowest and highest byte offsets touched by the view
        let (mut lo, mut hi) = (0isize, 0isize);
        for (n, s) in [self.h, self.w, self.c].into_iter().zip(self.strides) {
            let span = (n as isize - 1) * s;
            if span < 0 {
                lo += span;
            } else {
                hi += span;
            }
        }
        if lo < 0 || hi as usize >= len {
            return Err(PyValueError::new_err(
                "pixel buffer is smaller than its shape and strides describe",
            ));
        }
        Ok(())
    }

    /// Expand to RGBA8 (the one copy).
    fn to_rgba(&self) -> PyResult<RgbaImage> {
        let (width, height) = (dim(self.w, "width")?, dim(self.h, "height")?);
        let n = self
            .w
            .checked_mul(self.h)
            .and_then(|p| p.checked_mul(4))
            .filter(|&b| b <= MAX_BYTES)
            .ok_or_else(|| {
                PyValueError::new_err(format!(
                    "background image too large ({}×{} px; the limit is 512 MiB of RGBA)",
                    self.w, self.h
                ))
            })?;
        self.check_bounds()?;
        let mut data: Vec<u8> = Vec::with_capacity(n);
        let [sy, sx, sc] = self.strides;
        let packed = sc == 1 && sx == self.c as isize && sy == (self.w * self.c) as isize;
        // SAFETY: `ptr` points to memory owned by a Python object that the caller keeps
        // alive, with the GIL held, while this runs. The offsets stay inside the view the
        // object describes (checked against its length when the length is known).
        unsafe {
            if packed && self.c == 4 {
                std::ptr::copy_nonoverlapping(self.ptr, data.as_mut_ptr(), n);
                data.set_len(n);
            } else {
                for y in 0..self.h as isize {
                    for x in 0..self.w as isize {
                        let p = self.ptr.offset(y * sy + x * sx);
                        let at = |ch: isize| *p.offset(ch * sc);
                        let px = match self.c {
                            4 => [at(0), at(1), at(2), at(3)],
                            3 => [at(0), at(1), at(2), 255],
                            2 => [at(0), at(0), at(0), at(1)],
                            _ => [at(0), at(0), at(0), 255],
                        };
                        data.extend_from_slice(&px);
                    }
                }
            }
        }
        Ok(RgbaImage {
            width,
            height,
            data,
        })
    }
}

fn dim(v: usize, what: &str) -> PyResult<u32> {
    if v == 0 {
        return Err(PyValueError::new_err(format!(
            "background image {what} must be at least 1 px"
        )));
    }
    u32::try_from(v)
        .map_err(|_| PyValueError::new_err(format!("background image {what} is too large")))
}

/// C-order strides of `(h, w, c)` bytes.
fn c_strides(w: usize, c: usize) -> [isize; 3] {
    [(w * c) as isize, c as isize, 1]
}

/// Shape of a flat buffer of `len` bytes with the given width and height.
fn flat_shape(len: usize, width: u32, height: u32) -> PyResult<(usize, usize, usize)> {
    if width == 0 || height == 0 {
        return Err(PyValueError::new_err(
            "a flat pixel buffer needs width and height (or pass an H×W×C array)",
        ));
    }
    let px = width as usize * height as usize;
    for c in [4, 3, 1] {
        if px.checked_mul(c) == Some(len) {
            return Ok((height as usize, width as usize, c));
        }
    }
    Err(PyValueError::new_err(format!(
        "pixel buffer of {len} bytes does not match {width}×{height} px of RGBA, RGB or grey"
    )))
}

/// `(h, w, c)` of an array shape; checks explicit `width`/`height` against it.
fn image_shape(shape: &[usize], width: u32, height: u32) -> PyResult<(usize, usize, usize)> {
    let (h, w, c) = match *shape {
        [n] => return flat_shape(n, width, height),
        [h, w] => (h, w, 1),
        [h, w, c] if (1..=4).contains(&c) => (h, w, c),
        _ => {
            return Err(PyValueError::new_err(format!(
                "background array must have shape H×W×4 (RGBA), H×W×3 (RGB), H×W×2, H×W×1 \
                 or H×W (got {shape:?})"
            )))
        }
    };
    if (width != 0 && width as usize != w) || (height != 0 && height as usize != h) {
        return Err(PyValueError::new_err(format!(
            "background array is {w}×{h} px but width={width}, height={height} were given"
        )));
    }
    Ok((h, w, c))
}

/// `bytes(obj)` for any buffer object.
fn py_bytes<'py>(obj: &Bound<'py, PyAny>) -> PyResult<Bound<'py, PyBytes>> {
    Ok(obj
        .py()
        .get_type::<PyBytes>()
        .call1((obj,))?
        .cast_into::<PyBytes>()?)
}

/// Read `obj.__array_interface__` (version 3 of the NumPy array interface).
fn from_array_interface(iface: &Bound<'_, PyDict>, width: u32, height: u32) -> PyResult<RgbaImage> {
    let get = |k: &str| -> PyResult<Option<Bound<'_, PyAny>>> {
        Ok(iface.get_item(k)?.filter(|v| !v.is_none()))
    };
    let typestr: String = get("typestr")?
        .ok_or_else(|| PyTypeError::new_err("__array_interface__ without typestr"))?
        .extract()?;
    if !matches!(typestr.as_str(), "|u1" | "<u1" | ">u1" | "=u1") {
        return Err(PyTypeError::new_err(format!(
            "background array must have dtype uint8 (got typestr {typestr:?}); convert it \
             with arr.astype(numpy.uint8), or pass it through label_anything.place(), which \
             converts float images in [0, 1]"
        )));
    }
    if get("mask")?.is_some() {
        return Err(PyTypeError::new_err(
            "masked arrays are not supported as backgrounds",
        ));
    }
    let shape: Vec<usize> = get("shape")?
        .ok_or_else(|| PyTypeError::new_err("__array_interface__ without shape"))?
        .extract()?;
    let strides: Option<Vec<isize>> = get("strides")?.map(|s| s.extract()).transpose()?;
    let offset: usize = get("offset")?
        .map(|o| o.extract())
        .transpose()?
        .unwrap_or(0);
    let data =
        get("data")?.ok_or_else(|| PyTypeError::new_err("__array_interface__ without data"))?;
    let (h, w, c) = image_shape(&shape, width, height)?;
    let strides = match strides.as_deref() {
        None => c_strides(w, c),
        Some(&[s]) => [s * (w * c) as isize, s * c as isize, s],
        Some(&[sy, sx]) => [sy, sx, 0],
        Some(&[sy, sx, sc]) => [sy, sx, sc],
        Some(s) => {
            return Err(PyValueError::new_err(format!(
                "array interface strides {s:?} do not match its shape {shape:?}"
            )))
        }
    };
    // `data` is (pointer, read_only) or an object exposing the buffer (PIL: bytes)
    if let Ok(t) = data.cast::<PyTuple>() {
        let addr: usize = t.get_item(0)?.extract()?;
        if addr == 0 {
            return Err(PyValueError::new_err(
                "background array has a null data pointer",
            ));
        }
        let view = View {
            ptr: (addr + offset) as *const u8,
            len: None,
            h,
            w,
            c,
            strides,
        };
        return view.to_rgba();
    }
    let owned = match data.cast::<PyBytes>() {
        Ok(b) => b.clone(),
        Err(_) => py_bytes(&data)?,
    };
    let bytes = owned.as_bytes();
    let bytes = bytes
        .get(offset..)
        .ok_or_else(|| PyValueError::new_err("array interface offset lies beyond its data"))?;
    View {
        ptr: bytes.as_ptr(),
        len: Some(bytes.len()),
        h,
        w,
        c,
        strides,
    }
    .to_rgba()
}

/// Convert a Python raster object (see the module docs) into an RGBA image.
pub(crate) fn rgba_image(obj: &Bound<'_, PyAny>, width: u32, height: u32) -> PyResult<RgbaImage> {
    if let Ok(b) = obj.cast::<PyBytes>() {
        let data = b.as_bytes();
        return View::contiguous(
            data.as_ptr(),
            data.len(),
            flat_shape(data.len(), width, height)?,
        )
        .to_rgba();
    }
    if let Ok(b) = obj.cast::<PyByteArray>() {
        // SAFETY: no Python code runs while the bytes are copied, so the bytearray cannot
        // be resized or freed in the meantime.
        let data = unsafe { b.as_bytes() };
        return View::contiguous(
            data.as_ptr(),
            data.len(),
            flat_shape(data.len(), width, height)?,
        )
        .to_rgba();
    }
    if let Ok(iface) = obj.getattr("__array_interface__") {
        let iface = iface
            .cast_into::<PyDict>()
            .map_err(|_| PyTypeError::new_err("__array_interface__ must be a dict"))?;
        // `obj` (borrowed for this whole call) keeps the pixel memory alive
        return from_array_interface(&iface, width, height);
    }
    // other buffer objects (memoryview, array.array, ...): one extra copy through bytes()
    let owned = py_bytes(obj).map_err(|_| {
        PyTypeError::new_err(format!(
            "a raster background must be a NumPy uint8 array, bytes, bytearray or another \
             buffer object (got {})",
            obj.get_type()
                .name()
                .map(|n| n.to_string())
                .unwrap_or_else(|_| "?".into())
        ))
    })?;
    let data = owned.as_bytes();
    // a memoryview knows its shape
    let shape: Option<Vec<usize>> = obj
        .getattr("shape")
        .ok()
        .and_then(|s| s.extract::<Vec<usize>>().ok())
        .filter(|s| s.len() > 1);
    let hwc = match shape {
        Some(shape) => {
            let hwc = image_shape(&shape, width, height)?;
            if hwc.0 * hwc.1 * hwc.2 != data.len() {
                return Err(PyValueError::new_err(
                    "buffer shape does not match its size (expected uint8 items)",
                ));
            }
            hwc
        }
        None => flat_shape(data.len(), width, height)?,
    };
    View::contiguous(data.as_ptr(), data.len(), hwc).to_rgba()
}
