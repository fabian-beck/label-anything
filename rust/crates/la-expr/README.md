# label-anything-expr

> **Experimental:** Label Anything is still experimental and under active development,
> mostly by an AI coding assistant (Claude Code) with limited human oversight. The API,
> the problem format and the placements can change without deprecation.

The expression language of Label Anything priorities (`attrs.cbo > 10 && attrs.kind ==
'core'`) and the deterministic math behind the engine: `det_math` (functions that return
the same bits on every platform, built from `+ − × ÷ sqrt`) and the PCG32 generator.
Expressions are small, safe and free of side effects: parsing can fail, evaluation
cannot.

Part of [Label Anything](https://fabian-beck.github.io/label-anything/), a label placement engine for charts, maps and
diagrams. To place labels from Rust, use the crate
[`label-anything`](https://crates.io/crates/label-anything), which wires the parts
together; this crate is for programs that need this part alone.

```rust
use label_anything_expr::{parse, Context, Value};

let attrs = Value::from(&serde_json::json!({ "category": "core", "cbo": 41 }));
let expr = parse("attrs.category == 'core' && attrs.cbo > 10").unwrap();
assert_eq!(expr.eval(&Context::new(&attrs)), Value::Bool(true));
```

The grammar and the functions: the
[expression language](https://fabian-beck.github.io/label-anything/reference/expressions/).

MIT License.
