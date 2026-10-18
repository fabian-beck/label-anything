# label-anything

> **Experimental:** Label Anything is still experimental and under active development,
> mostly by an AI coding assistant (Claude Code) with limited human oversight. The API,
> the problem format and the placements can change without deprecation.

Rust facade of **Label Anything**, a label placement engine for charts, maps and
diagrams. One JSON problem in (`spec/schema/problem.v1.json`), one JSON result out.

```rust
let problem = serde_json::json!({
    "canvas": {"width": 800, "height": 600},
    "items": [{"id": "a", "anchor": {"type": "point", "x": 100, "y": 100},
               "label": {"type": "text", "text": "Alpha"}}]
});
let result = label_anything::place(&problem).unwrap();
assert_eq!(result["stats"]["hard_violations"], 0);
```

See the repository README for the full documentation.
