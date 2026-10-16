//! SVG background → parse + classify: a scene or a structured error, never a panic.
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let text = String::from_utf8_lossy(data);
    let rules = [
        la_svg::ClassRule::new("text", "text"),
        la_svg::ClassRule::new("circle, rect:small", "points"),
        la_svg::ClassRule::new("*", "ink"),
    ];
    if let Ok(scene) = la_svg::parse(&text, &la_svg::ParseOptions::default()) {
        let _ = la_svg::classify(&scene, &rules, "ink");
    }
});
