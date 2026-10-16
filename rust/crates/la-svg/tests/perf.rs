//! Performance: a 10 000-element SVG parses and classifies in < 50 ms (release builds).
//! Shared CI runners (`CI` set) are slower and noisy, so there only gross regressions
//! (3×) fail; the benchmark's performance targets are the release gate.
//!
//! `cargo test --release -p label-anything-svg --test perf -- --nocapture` prints timings.

use std::time::Instant;

use label_anything_svg::{classify, parse, ClassRule, ParseOptions};

fn auto_rules() -> Vec<ClassRule> {
    vec![
        ClassRule::new(":background", "ignore"),
        ClassRule::new("text", "text"),
        ClassRule::new(
            "circle, ellipse, rect:small, use:small, path:small",
            "points",
        ),
        ClassRule::new("path, line, polyline, polygon", "lines"),
        ClassRule::new("*", "ink"),
    ]
}

fn circles(n: usize) -> String {
    let mut s = String::from(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1000\" height=\"1000\">\n<rect width=\"1000\" height=\"1000\" fill=\"white\"/>\n<g class=\"points\">\n",
    );
    for i in 0..n {
        let x = (i * 37 % 1000) as f64 + 0.5;
        let y = (i * 91 % 1000) as f64 + 0.25;
        s.push_str(&format!("<circle cx=\"{x}\" cy=\"{y}\" r=\"3\" fill=\"steelblue\" stroke=\"white\" stroke-width=\"0.5\"/>\n"));
    }
    s.push_str("</g>\n</svg>\n");
    s
}

fn mixed(n: usize) -> String {
    let mut s = String::from(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"1000\" height=\"1000\" viewBox=\"0 0 500 500\">\n\
         <style>.m { fill: #1f77b4; stroke: #1f77b4 } text { font-size: 10px }</style>\n\
         <defs><path id=\"mk\" d=\"M 0 3 C 0.8 3 1.56 2.68 2.12 2.12 C 2.68 1.56 3 0.8 3 0 C 3 -0.8 2.68 -1.56 2.12 -2.12 C 1.56 -2.68 0.8 -3 0 -3 C -0.8 -3 -1.56 -2.68 -2.12 -2.12 C -2.68 -1.56 -3 -0.8 -3 0 C -3 0.8 -2.68 1.56 -2.12 2.12 C -1.56 2.68 -0.8 3 0 3 z\"/></defs>\n",
    );
    for i in 0..n {
        let x = (i * 37 % 500) as f64;
        let y = (i * 91 % 500) as f64;
        match i % 4 {
            0 => s.push_str(&format!(
                "<use xlink:href=\"#mk\" class=\"m\" x=\"{x}\" y=\"{y}\"/>\n"
            )),
            1 => s.push_str(&format!(
                "<path d=\"M {x} {y} l 10 5 l 5 -10\" fill=\"none\" stroke=\"black\"/>\n"
            )),
            2 => s.push_str(&format!(
                "<rect x=\"{x}\" y=\"{y}\" width=\"8\" height=\"4\" rx=\"1\"/>\n"
            )),
            _ => s.push_str(&format!(
                "<text x=\"{x}\" y=\"{y}\" text-anchor=\"middle\">L{i}</text>\n"
            )),
        }
    }
    s.push_str("</svg>\n");
    s
}

/// The bound in ms (see the module comment).
fn limit_ms() -> f64 {
    if std::env::var_os("CI").is_some() {
        150.0
    } else {
        50.0
    }
}

fn time(label: &str, svg: &str, expect_prims: usize) -> f64 {
    let rules = auto_rules();
    let mut best = f64::INFINITY;
    for _ in 0..5 {
        let t = Instant::now();
        let scene = parse(svg, &ParseOptions::default()).unwrap();
        let classified = classify(&scene, &rules, "ink").unwrap();
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(scene.primitives.len(), expect_prims, "{label}");
        assert!(classified.len() <= scene.primitives.len());
        best = best.min(ms);
    }
    println!(
        "{label}: {best:.2} ms (best of 5, parse + classify, {} KiB)",
        svg.len() / 1024
    );
    best
}

#[test]
fn ten_thousand_circles() {
    let svg = circles(10_000);
    // 1 background rect + 10 000 circles with fill and stroke.
    let ms = time("10k circles", &svg, 1 + 20_000);
    if !cfg!(debug_assertions) {
        assert!(ms < limit_ms(), "10k circles took {ms:.1} ms");
    }
}

#[test]
fn ten_thousand_mixed_elements() {
    let svg = mixed(10_000);
    // uses (fill + stroke), paths (stroke), rects (fill), texts (rect).
    let ms = time("10k mixed", &svg, 2 * 2500 + 2500 + 2500 + 2500);
    if !cfg!(debug_assertions) {
        assert!(ms < limit_ms(), "10k mixed elements took {ms:.1} ms");
    }
}
