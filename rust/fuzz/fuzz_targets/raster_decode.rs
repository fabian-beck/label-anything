//! Raster background → decode (PNG, JPEG, WebP): an image or a structured error.
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = la_raster::decode(data);
});
