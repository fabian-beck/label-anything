//! Generates random expression cases with the results of the Rust implementation, as a
//! parity net between implementations (`conformance/expr/random.json`).
//!
//! ```sh
//! cargo run -p label-anything-expr --example gen_expr_random            # 600 cases → conformance/expr/random.json
//! cargo run -p label-anything-expr --example gen_expr_random -- <n> <out.json> [seed]
//! ```
//!
//! Expressions come from a grammar-based generator (always valid) and from random token
//! soups (mostly errors). Deterministic (PCG32).

use label_anything_expr::det_math::Pcg32;
use label_anything_expr::{parse, Context, Value};
use std::path::Path;

const LEAVES: &[&str] = &[
    "attrs.n",
    "attrs.f",
    "attrs.neg",
    "attrs.z",
    "attrs.nz",
    "attrs.big",
    "attrs.tiny",
    "attrs.s",
    "attrs.u",
    "attrs.e",
    "attrs.emoji",
    "attrs.list",
    "attrs.nested",
    "attrs.obj",
    "attrs.t",
    "attrs.missing",
    "attrs['s p']",
    "attrs.list[1]",
    "attrs.list[2][0]",
    "attrs.obj.k",
    "attrs.nested[1]",
    "id",
    "index",
    "text",
    "priority",
    "tier",
    "x",
    "y",
    "0",
    "1",
    "-0",
    "2.5",
    "1e308",
    "5e-324",
    "0.1",
    "3",
    "'a'",
    "'B'",
    "''",
    "'é'",
    "'😀'",
    "'\\uFFFF'",
    "'org.example.Foo'",
    "'  12.5 '",
    "'-0'",
    "'1e999'",
    "true",
    "false",
    "null",
    "[]",
    "[1, 'a', null]",
    "[0]",
    "[[1], [2, 3]]",
    "attrs",
    "attrs.list.len()",
    "text.upper()",
];

const BIN: &[&str] = &[
    "||", "&&", "==", "!=", "<", "<=", ">", ">=", "+", "-", "*", "/", "%",
];

const FUN1: &[&str] = &[
    "abs", "log", "log1p", "sqrt", "floor", "ceil", "round", "len", "lower", "upper", "number",
];

const FUN2: &[&str] = &[
    "startsWith",
    "endsWith",
    "contains",
    "min",
    "max",
    "coalesce",
];

fn pick<'a>(rng: &mut Pcg32, xs: &[&'a str]) -> &'a str {
    xs[rng.next_below(xs.len() as u32) as usize]
}

fn gen(rng: &mut Pcg32, depth: u32) -> String {
    if depth == 0 || rng.next_below(5) == 0 {
        return pick(rng, LEAVES).to_string();
    }
    let a = gen(rng, depth - 1);
    match rng.next_below(12) {
        0 => format!("!{a}"),
        1 => format!("-({a})"),
        2 => format!("({a})[{}]", gen(rng, depth - 1)),
        3 => format!("{}({a})", pick(rng, FUN1)),
        4 => format!("{}({a}, {})", pick(rng, FUN2), gen(rng, depth - 1)),
        5 => format!("({a}).{}()", pick(rng, FUN1)),
        6 => format!(
            "({a}) in [{}, {}]",
            gen(rng, depth - 1),
            gen(rng, depth - 1)
        ),
        7 => format!("({a}) not in [{}]", gen(rng, depth - 1)),
        8 => format!("max({a}, {}, {})", gen(rng, depth - 1), gen(rng, depth - 1)),
        9 => format!("[{a}, {}]", gen(rng, depth - 1)),
        _ => format!("({a}) {} ({})", pick(rng, BIN), gen(rng, depth - 1)),
    }
}

const SOUP: &[&str] = &[
    "attrs", ".", "n", "s", "[", "]", "(", ")", ",", "1", "-", "+", "*", "!", "==", "<", "in",
    "not", "'x'", "\"y", "\\u00e9", "len", "min", "foo", "true", "null", "&&", "||", "@", "=", "é",
    "😀", " ", "1e", "0.5", "abs", "coalesce",
];

fn soup(rng: &mut Pcg32) -> String {
    let n = 1 + rng.next_below(10) as usize;
    (0..n).map(|_| pick(rng, SOUP)).collect::<Vec<_>>().join("")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let n: usize = args.first().and_then(|s| s.parse().ok()).unwrap_or(600);
    let out = args.get(1).cloned().unwrap_or_else(|| {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../conformance/expr/random.json")
            .to_string_lossy()
            .into_owned()
    });
    let seed: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(2026);
    let context = serde_json::json!({
        "attrs": {
            "n": 41, "f": 2.5, "neg": -7, "z": 0, "nz": -0.0, "big": 1e300, "tiny": 5e-324,
            "s": "core", "u": "Straße", "e": "", "emoji": "a😀\u{ffff}", "t": true,
            "list": [10, "two", [3, 4], null],
            "nested": { "1": "one", "x": [1, 2] },
            "obj": { "k": "v", "w": 0 },
            "s p": "space"
        },
        "id": "item-7", "index": 7, "text": "Hello", "priority": 2.5, "tier": -1, "x": 10.5, "y": -3
    });
    let attrs = Value::from(&context["attrs"]);
    let ctx = Context {
        attrs: &attrs,
        id: "item-7",
        index: 7,
        text: "Hello",
        priority: Some(2.5),
        tier: Some(-1),
        x: 10.5,
        y: -3.0,
    };
    let mut rng = Pcg32::new(seed);
    let mut cases = Vec::with_capacity(n);
    for i in 0..n {
        let src = if i % 4 == 3 {
            soup(&mut rng)
        } else {
            gen(&mut rng, 4)
        };
        let case = match parse(&src) {
            Ok(e) => {
                let v: serde_json::Value = (&e.eval(&ctx)).into();
                serde_json::json!({ "expr": src, "value": v })
            }
            Err(e) => serde_json::json!({ "expr": src, "error": e.code, "offset": e.offset }),
        };
        cases.push(case);
    }
    let doc = serde_json::json!({
        "kind": "expr",
        "name": "random",
        "description": "Random expressions (grammar-based and token soups) with the results of the Rust implementation: a parity net between implementations. Generated by rust/crates/la-expr/examples/gen_expr_random.rs.",
        "context": context,
        "cases": cases,
    });
    let mut text = serde_json::to_string_pretty(&doc).unwrap();
    text.push('\n');
    std::fs::write(&out, text).unwrap();
    println!("{n} cases -> {out}");
}
