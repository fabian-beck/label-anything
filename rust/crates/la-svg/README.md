# label-anything-svg

> **Experimental:** Label Anything is still experimental and under active development,
> mostly by an AI coding assistant (Claude Code) with limited human oversight. The API,
> the problem format and the placements can change without deprecation.

SVG backgrounds as obstacle geometry: the crate parses an SVG document with its own small
XML parser, resolves styles and transforms, and turns what the document draws into
polygons, polylines and text boxes in canvas pixels, classified by CSS-like selectors.
No dependencies. The TypeScript package `@label-anything/svg` implements the same
algorithms.

Part of [Label Anything](https://fabian-beck.github.io/label-anything/), a label placement engine for charts, maps and
diagrams. To place labels from Rust, use the crate
[`label-anything`](https://crates.io/crates/label-anything), which wires the parts
together; this crate is for programs that need this part alone.

```rust
use label_anything_svg::{classify, parse, ClassRule, ParseOptions};

let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
  <rect width="200" height="100" fill="white"/>
  <circle id="p1" cx="50" cy="50" r="4" fill="steelblue"/>
  <text x="100" y="50" font-size="10">Label</text>
</svg>"#;
let scene = parse(svg, &ParseOptions::default()).unwrap();
let rules = vec![
    ClassRule::new(":background", "ignore"),
    ClassRule::new("text", "text"),
    ClassRule::new("circle", "points"),
];
let classified = classify(&scene, &rules, "ink").unwrap();
assert_eq!(classified.len(), 2);
assert_eq!(classified[0].class, "points");
```

Not modelled: clipping, masks, filters, markers, dashes, gradients and patterns (any
paint server counts as opaque) and per-glyph text positioning. Feature `serde` derives
`Serialize` for the data types.

MIT License.
