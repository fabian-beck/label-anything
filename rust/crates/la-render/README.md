# label-anything-render

> **Experimental:** Label Anything is still experimental and under active development,
> mostly by an AI coding assistant (Claude Code) with limited human oversight. The API,
> the problem format and the placements can change without deprecation.

The debug overlay of Label Anything as SVG: placed labels, leaders, candidates, a cost
heatmap per class, item shapes, and the labels left out with their reasons. The layers are
SVG groups with ids (`obstacles`, `heatmap-<class>`, `candidates`, `items`, `leaders`,
`labels`, `unplaced`), so a viewer can toggle them.

Part of [Label Anything](https://fabian-beck.github.io/label-anything/), a label placement engine for charts, maps and
diagrams. To place labels from Rust, use the crate
[`label-anything`](https://crates.io/crates/label-anything), which wires the parts
together; this crate is for programs that need this part alone.

The facade exports this crate as `label_anything::render` and calls it for
`output.debug_svg` and `label_anything::render_svg`. What the overlay shows: the
[debug overlay](https://fabian-beck.github.io/label-anything/concepts/debug-overlay/).

MIT License.
