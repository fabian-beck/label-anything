//! Micro-benchmark of expression evaluation (run in release):
//!
//! ```sh
//! cargo run --release -p label-anything-expr --example bench_eval
//! ```
//!
//! Target: a typical tier clause evaluates in < 200 ns.

use label_anything_expr::{parse, Context, Value};
use std::hint::black_box;
use std::time::Instant;

fn bench(name: &str, src: &str, attrs: &Value, iters: u32) {
    let expr = parse(src).expect("parse");
    let ctx = Context {
        id: "n42",
        index: 42,
        text: "org.example.Foo",
        ..Context::new(attrs)
    };
    // warm-up
    for _ in 0..iters / 10 {
        black_box(expr.matches(black_box(&ctx)));
    }
    let t = Instant::now();
    for _ in 0..iters {
        black_box(expr.matches(black_box(&ctx)));
    }
    let matches_ns = t.elapsed().as_nanos() as f64 / iters as f64;
    let t = Instant::now();
    for _ in 0..iters {
        black_box(expr.eval(black_box(&ctx)));
    }
    let eval_ns = t.elapsed().as_nanos() as f64 / iters as f64;
    let t = Instant::now();
    let n = iters / 20;
    for _ in 0..n {
        black_box(parse(black_box(src)).unwrap());
    }
    let parse_ns = t.elapsed().as_nanos() as f64 / n as f64;
    println!(
        "{name:<28} matches {matches_ns:>7.1} ns   eval {eval_ns:>7.1} ns   parse {parse_ns:>8.1} ns   {src}"
    );
}

fn bench_math(name: &str, f: impl Fn(f64) -> f64) {
    let n = 5_000_000u32;
    let mut x = 0.0f64;
    let t = Instant::now();
    for i in 0..n {
        x += f(black_box(0.37 + i as f64 * 1e-6));
    }
    black_box(x);
    println!(
        "det_math::{name:<20} {:>6.1} ns",
        t.elapsed().as_nanos() as f64 / n as f64
    );
}

fn main() {
    use label_anything_expr::det_math as dm;
    bench_math("ln", dm::ln);
    bench_math("ln_1p", dm::ln_1p);
    bench_math("exp", dm::exp);
    bench_math("pow(x, 2.7)", |x| dm::pow(x, 2.7));
    bench_math("pow(x, 3)", |x| dm::pow(x, 3.0));
    bench_math("sin_cos_deg", |x| {
        let (s, c) = dm::sin_cos_deg(x * 1000.0);
        s + c
    });
    bench_math("atan2_deg", |x| dm::atan2_deg(x, 1.0 - x));
    bench_math("cbrt", dm::cbrt);
    bench_math("round_half_away", |x| dm::round_half_away(x * 100.0));
    let attrs = Value::from(&serde_json::json!({
        "category": "core",
        "cbo": 41,
        "loc": 1200,
        "name": "org.example.Foo",
        "package": "org.example",
        "tags": ["api", "stable"],
        "metrics": { "wmc": 17, "rfc": 33 },
        "deprecated": false,
        "owner": "team-a",
        "score": 0.73
    }));
    let n = 5_000_000;
    bench(
        "tier clause",
        "attrs.category == 'core' && attrs.cbo > 10",
        &attrs,
        n,
    );
    bench(
        "numeric term",
        "log1p(attrs.loc) * 2 + attrs.score",
        &attrs,
        n,
    );
    bench(
        "string method",
        "attrs.name.startsWith('org.') && !attrs.deprecated",
        &attrs,
        n,
    );
    bench(
        "membership",
        "attrs.owner in ['team-a', 'team-b', 'team-c']",
        &attrs,
        n,
    );
    bench(
        "nested member",
        "attrs.metrics.wmc > 10 || attrs.metrics.rfc > 50",
        &attrs,
        n,
    );
    bench("coverage key", "coalesce(attrs.package, 'none')", &attrs, n);
}
