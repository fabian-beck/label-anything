//! Unit tests of the expression language. The language-neutral cases shared with the
//! TypeScript implementation are in `conformance/expr/` (run by `tests/conformance_expr.rs`).

use super::*;
use crate::det_math::Pcg32;
use std::collections::BTreeMap;

fn attrs(json: &str) -> Value {
    Value::from(&serde_json::from_str::<serde_json::Value>(json).unwrap())
}

fn ev(src: &str, a: &Value) -> Value {
    parse(src)
        .unwrap_or_else(|e| panic!("{src}: {e}"))
        .eval(&Context::new(a))
}

fn ev0(src: &str) -> Value {
    ev(src, &Value::Obj(BTreeMap::new()))
}

fn err(src: &str) -> (&'static str, usize) {
    match parse(src) {
        Ok(_) => panic!("{src}: expected an error"),
        Err(e) => (e.code, e.offset),
    }
}

#[test]
fn typical_tier_clause() {
    let a = attrs(r#"{"cbo": 41, "category": "core"}"#);
    assert_eq!(
        ev("attrs.cbo > 10 && attrs.category == 'core'", &a),
        Value::Bool(true)
    );
    assert_eq!(
        ev("attrs.cbo > 50 || attrs.category != 'core'", &a),
        Value::Bool(false)
    );
    let e = parse("attrs.category == 'core' && attrs.cbo > 10").unwrap();
    assert!(e.matches(&Context::new(&a)));
    assert_eq!(e.eval_number(&Context::new(&a)), Some(1.0));
    assert_eq!(e.source(), "attrs.category == 'core' && attrs.cbo > 10");
}

#[test]
fn precedence_and_associativity() {
    assert_eq!(ev0("1 + 2 * 3"), Value::Num(7.0));
    assert_eq!(ev0("(1 + 2) * 3"), Value::Num(9.0));
    assert_eq!(ev0("10 - 4 - 3"), Value::Num(3.0));
    assert_eq!(ev0("2 * 3 % 4"), Value::Num(2.0));
    assert_eq!(ev0("-2 * 3"), Value::Num(-6.0));
    assert_eq!(ev0("!1 == 2"), Value::Bool(true)); // '!' binds looser than '=='
    assert_eq!(ev0("true || false && false"), Value::Bool(true));
    assert_eq!(err("1 < 2 < 3"), (EXPR_SYNTAX, 6));
}

#[test]
fn errors_and_offsets() {
    assert_eq!(err("attrs.x +"), (EXPR_SYNTAX, 9));
    assert_eq!(err(""), (EXPR_SYNTAX, 0));
    assert_eq!(err("   "), (EXPR_SYNTAX, 3));
    assert_eq!(err("foo"), (EXPR_UNKNOWN_IDENTIFIER, 0));
    assert_eq!(err("1 + foo(1 +)"), (EXPR_UNKNOWN_IDENTIFIER, 4));
    assert_eq!(err("len(1 +)"), (EXPR_SYNTAX, 7));
    assert_eq!(err("len(1, 2)"), (EXPR_ARITY, 0));
    assert_eq!(err("'x'.startsWith()"), (EXPR_ARITY, 4));
    assert_eq!(err("min()"), (EXPR_ARITY, 0));
    assert_eq!(err("a = 1"), (EXPR_UNKNOWN_IDENTIFIER, 0));
    assert_eq!(err("x = 1"), (EXPR_SYNTAX, 2));
    assert_eq!(err("'abc"), (EXPR_SYNTAX, 0));
    assert_eq!(err("'ab\\u12'"), (EXPR_SYNTAX, 3));
    assert_eq!(err("'\\uD800'"), (EXPR_SYNTAX, 1));
    assert_eq!(err("1e999"), (EXPR_SYNTAX, 0));
    assert_eq!(err("attrs.in"), (EXPR_SYNTAX, 6));
    assert_eq!(err("x not [1]"), (EXPR_SYNTAX, 6));
    assert_eq!(err("x in attrs"), (EXPR_SYNTAX, 5));
    assert_eq!(err("(1 + ) @"), (EXPR_SYNTAX, 5)); // first error in reading order
    assert_eq!(err("'é' + é"), (EXPR_SYNTAX, 6)); // offsets count code points
    assert_eq!(err("'😀' + )"), (EXPR_SYNTAX, 6));
    let e = parse("len(1, 2)").unwrap_err();
    assert_eq!(e.message, "len() takes 1 argument, got 2");
    assert_eq!(
        e.to_string(),
        "expr_arity at offset 0: len() takes 1 argument, got 2"
    );
}

#[test]
fn nesting_limit() {
    let ok = format!("{}1{}", "(".repeat(MAX_DEPTH), ")".repeat(MAX_DEPTH));
    assert_eq!(ev0(&ok), Value::Num(1.0));
    let deep = format!(
        "{}1{}",
        "(".repeat(MAX_DEPTH + 1),
        ")".repeat(MAX_DEPTH + 1)
    );
    assert_eq!(err(&deep), (EXPR_SYNTAX, MAX_DEPTH));
    assert_eq!(
        err(&format!("{}1", "!".repeat(300))),
        (EXPR_SYNTAX, MAX_DEPTH)
    );
    assert_eq!(
        err(&format!("{}1", "-".repeat(257))),
        (EXPR_SYNTAX, MAX_DEPTH)
    );
    assert_eq!(ev0(&format!("{}1", "-".repeat(256))), Value::Num(1.0));
    // Long flat chains are not nesting.
    let chain = vec!["1"; 100_000].join(" + ");
    assert_eq!(ev0(&chain), Value::Num(100_000.0));
    let ors = vec!["false"; 100_000].join(" || ");
    assert_eq!(ev0(&ors), Value::Bool(false));
}

#[test]
fn values_and_helpers() {
    assert!(!truthy(&Value::Null));
    assert!(!truthy(&Value::Num(-0.0)));
    assert!(!truthy(&Value::Str(String::new())));
    assert!(!truthy(&Value::List(vec![])));
    assert!(truthy(&Value::Obj(BTreeMap::new())));
    assert_eq!(term_number(&Value::Bool(true)), Some(1.0));
    assert_eq!(term_number(&Value::Str("1".into())), None);
    assert!(values_equal(&Value::Num(0.0), &Value::Num(-0.0)));
    assert!(!values_equal(&Value::Num(1.0), &Value::Str("1".into())));
    let a = attrs(r#"{"o": {"a": [1, {"b": null}]}, "p": {"a": [1, {"b": null}]}}"#);
    assert_eq!(ev("attrs.o == attrs.p", &a), Value::Bool(true));
    assert_eq!(ev("attrs.o.a == [1, attrs.p.a[1]]", &a), Value::Bool(true));
    assert_eq!(ev("attrs.o", &a), attrs(r#"{"a": [1, {"b": null}]}"#));
    let j: serde_json::Value = (&ev("[1, 'a', null, true]", &a)).into();
    assert_eq!(j, serde_json::json!([1.0, "a", null, true]));
}

#[test]
fn context_variables() {
    let a = attrs(r#"{"k": 1}"#);
    let ctx = Context {
        attrs: &a,
        id: "n1",
        index: 7,
        text: "Hello",
        priority: Some(2.5),
        tier: Some(-3),
        x: 10.5,
        y: f64::NAN,
    };
    let e = |s: &str| parse(s).unwrap().eval(&ctx);
    assert_eq!(e("id + ':' + text"), Value::Str("n1:Hello".into()));
    assert_eq!(e("index * 2"), Value::Num(14.0));
    assert_eq!(e("priority + tier"), Value::Num(-0.5));
    assert_eq!(e("x"), Value::Num(10.5));
    assert_eq!(e("y"), Value::Null);
    assert_eq!(e("attrs"), a);
}

#[test]
fn json_negative_zero_and_big_integers() {
    let a = attrs(r#"{"z": -0, "zf": -0.0, "big": 9007199254740993, "f": 0.30000000000000004}"#);
    let bits = |v: Value| match v {
        Value::Num(x) => x.to_bits(),
        other => panic!("{other:?}"),
    };
    assert_eq!(bits(ev("attrs.z", &a)), (-0.0f64).to_bits());
    assert_eq!(bits(ev("attrs.zf", &a)), (-0.0f64).to_bits());
    assert_eq!(bits(ev("attrs.big", &a)), 9007199254740992.0f64.to_bits());
    assert_eq!(bits(ev("attrs.f", &a)), (0.1f64 + 0.2).to_bits());
}

#[test]
fn number_function() {
    assert_eq!(ev0("number(' -12.5e1 ')"), Value::Num(-125.0));
    assert_eq!(ev0("number('.5')"), Value::Num(0.5));
    for bad in [
        "''",
        "' '",
        "'+1'",
        "'1.'",
        "'- 1'",
        "'0x10'",
        "'1e999'",
        "'1_0'",
        "'\u{a0}1'",
    ] {
        assert_eq!(ev0(&format!("number({bad})")), Value::Null, "{bad}");
    }
    assert_eq!(ev0("number(true)"), Value::Num(1.0));
    assert_eq!(ev0("number(3)"), Value::Num(3.0));
    assert_eq!(ev0("number(null)"), Value::Null);
}

/// Every way of nesting to MAX_DEPTH parses and evaluates on a 1 MiB thread stack, even
/// in unoptimized builds (measured need ≈ 0.47 MiB debug, ≈ 0.23 MiB release).
#[test]
fn max_depth_fits_in_one_mib_of_stack() {
    let d = MAX_DEPTH;
    let cases = vec![
        format!("{}1{}", "(".repeat(d), ")".repeat(d)),
        format!("{}1{}", "[".repeat(d), "]".repeat(d)),
        format!("{}1{}", "abs(".repeat(d), ")".repeat(d)),
        format!("{}1{}", "coalesce(".repeat(d), ")".repeat(d)),
        format!("{}0{}", "attrs[".repeat(d), "]".repeat(d)),
        format!("1{}", ".abs()".repeat(d)),
        format!("{}1", "-".repeat(d)),
        format!("{}1", "!".repeat(d)),
        format!("{}1{}", "-(".repeat(d / 2), ")".repeat(d / 2)),
        format!(
            "{}1 in [1]{}",
            "(1 in [".repeat(d / 2 - 1),
            "])".repeat(d / 2 - 1)
        ),
        format!("{}1{}", "(".repeat(d + 1), ")".repeat(d + 1)),
    ];
    std::thread::Builder::new()
        .stack_size(1 << 20)
        .spawn(move || {
            let a = Value::Obj(BTreeMap::new());
            for (i, src) in cases.iter().enumerate() {
                let r = parse(src);
                assert_eq!(r.is_ok(), i + 1 < cases.len(), "case {i}");
                if let Ok(e) = r {
                    let _ = e.eval(&Context::new(&a));
                    drop(e);
                }
            }
        })
        .unwrap()
        .join()
        .unwrap();
}

/// Random token soups never make the parser or the evaluator panic.
#[test]
fn fuzz_never_panics() {
    let atoms = [
        "attrs",
        "attrs.a",
        "attrs['b']",
        "id",
        "index",
        "text",
        "priority",
        "tier",
        "x",
        "y",
        "1",
        "0",
        "-0",
        "2.5",
        "1e308",
        "'s'",
        "\"\\u00e9\"",
        "true",
        "false",
        "null",
        "[1, 'a']",
        "[]",
        "len",
        "min",
        "coalesce",
        "number",
        "contains",
        "startsWith",
        "(",
        ")",
        "[",
        "]",
        ",",
        ".",
        "+",
        "-",
        "*",
        "/",
        "%",
        "==",
        "!=",
        "<",
        "<=",
        ">",
        ">=",
        "&&",
        "||",
        "!",
        "in",
        "not",
        "@",
        "'",
        "\\",
        "😀",
        "lower",
        "upper",
        "abs",
        "log",
        "log1p",
        "sqrt",
        "round",
        "floor",
        "ceil",
        "max",
        "endsWith",
        "foo",
    ];
    let a = attrs(r#"{"a": [1, 2, {"c": "x"}], "b": -1.5, "s": "Straße"}"#);
    let ctx = Context {
        priority: Some(1.0),
        tier: Some(2),
        ..Context::new(&a)
    };
    let mut rng = Pcg32::new(99);
    let mut parsed = 0;
    for _ in 0..30_000 {
        let n = 1 + rng.next_below(12) as usize;
        let src: Vec<&str> = (0..n)
            .map(|_| atoms[rng.next_below(atoms.len() as u32) as usize])
            .collect();
        let src = src.join(if rng.next_u32() & 1 == 0 { " " } else { "" });
        if let Ok(e) = parse(&src) {
            parsed += 1;
            let _ = e.eval(&ctx);
        }
    }
    assert!(parsed > 500, "only {parsed} parsed");
    // Grammar-based random expressions: always parse, and evaluate without panicking.
    for _ in 0..20_000 {
        let src = random_expr(&mut rng, 4);
        let e = parse(&src).unwrap_or_else(|e| panic!("{src}: {e}"));
        let _ = e.eval(&ctx);
    }
}

fn random_expr(rng: &mut Pcg32, depth: u32) -> String {
    const LEAVES: [&str; 16] = [
        "attrs.a",
        "attrs.b",
        "attrs.s",
        "attrs.zz",
        "attrs['a'][2].c",
        "id",
        "index",
        "priority",
        "tier",
        "x",
        "1",
        "-0",
        "2.5e3",
        "'Straße'",
        "null",
        "[1, [2], 'x']",
    ];
    if depth == 0 || rng.next_below(4) == 0 {
        return LEAVES[rng.next_below(LEAVES.len() as u32) as usize].to_string();
    }
    let a = random_expr(rng, depth - 1);
    let b = random_expr(rng, depth - 1);
    const BIN: [&str; 15] = [
        "||", "&&", "==", "!=", "<", "<=", ">", ">=", "+", "-", "*", "/", "%", "in", "not in",
    ];
    const FUNS: [&str; 12] = [
        "abs", "log", "sqrt", "floor", "round", "log1p", "len", "lower", "number", "ceil", "upper",
        "abs",
    ];
    match rng.next_below(9) {
        0 => format!("!({a})"),
        1 => format!("-({a})"),
        2 => format!("({a})[{b}]"),
        3 => format!("{}({a})", FUNS[rng.next_below(FUNS.len() as u32) as usize]),
        4 => format!("min({a}, {b})"),
        5 => format!("({a}).startsWith({b})"),
        6 => format!("coalesce({a}, {b})"),
        7 => format!("contains({a}, {b})"),
        _ => {
            let op = BIN[rng.next_below(BIN.len() as u32) as usize];
            if op.ends_with("in") {
                format!("({a}) {op} [{b}, 1]")
            } else {
                format!("({a}) {op} ({b})")
            }
        }
    }
}
