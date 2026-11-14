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

`place` takes the problem as a `serde_json::Value` and returns the result as one, or a
`PlaceError` with the validation errors (JSON pointer, code and message each).
`place_json` does the same on JSON text, `validate` reports errors and warnings without
solving, and `render_svg` draws the debug overlay. `place_with` solves in an environment
of your own (the trait `Env`): file access, text measurement, priority and cost
callbacks, progress and cancellation.

```toml
[dependencies]
label-anything = "0.1"
serde_json = "1"
```

Features, all default: `parallel` (data-parallel phases on all cores; the result does not
depend on the number of threads), `decode` (PNG, JPEG and WebP raster backgrounds; raw
RGBA always works) and `std-clock` (the system clock for the solver's time guard; leave
it out on `wasm32-unknown-unknown`).

The command line is the crate `label-anything-cli`, the C ABI `label-anything-capi`.
The problem and result formats, the options and their defaults, tutorials and a
playground: <https://fabian-beck.github.io/label-anything/>.

MIT License. The crate embeds the metrics of a Noto Sans subset (SIL Open Font License
1.1) through `label-anything-text`.
