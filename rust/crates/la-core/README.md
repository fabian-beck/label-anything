# label-anything-core

> **Experimental:** Label Anything is still experimental and under active development,
> mostly by an AI coding assistant (Claude Code) with limited human oversight. The API,
> the problem format and the placements can change without deprecation.

The core of the Label Anything label placement engine: validation, geometry, cost grids,
candidates, priority and the solver. It reads one problem (`problem.v1`, JSON) and returns
one result (`result.v1`): the placed labels and their leaders, and the reason for every
label left out. The core does no I/O: files, the clock, SVG backgrounds and host callbacks
come through the trait `env::Env`.

Part of [Label Anything](https://fabian-beck.github.io/label-anything/), a label placement engine for charts, maps and
diagrams. To place labels from Rust, use the crate
[`label-anything`](https://crates.io/crates/label-anything), which wires the parts
together; this crate is for programs that need this part alone.

```rust
use label_anything_core::{env::BasicEnv, place};

let problem = serde_json::json!({
    "canvas": {"width": 400, "height": 300},
    "items": [{"id": "a", "anchor": {"type": "point", "x": 100, "y": 100},
               "label": {"type": "text", "text": "Alpha"}}]
});
let result = place(&problem, &BasicEnv).unwrap();
assert_eq!(result["stats"]["placed"], 1);
```

Features: `parallel` (data-parallel phases with rayon; the result does not depend on the
number of threads) and `decode` (PNG, JPEG and WebP raster backgrounds; raw RGBA always
works). Without features the crate builds for `wasm32-unknown-unknown`.

The formats, the options and their defaults: the
[documentation](https://fabian-beck.github.io/label-anything/concepts/) and the
[specification](https://fabian-beck.github.io/label-anything/reference/spec/).

MIT License.
