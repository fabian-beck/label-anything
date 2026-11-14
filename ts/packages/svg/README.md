# @label-anything/svg

> **Experimental:** Label Anything is still experimental and under active development,
> mostly by an AI coding assistant (Claude Code) with limited human oversight. The API,
> the problem format and the placements can change without deprecation.

SVG backgrounds as obstacle geometry for the [Label Anything](https://fabian-beck.github.io/label-anything/) label placement
engine, in pure TypeScript with zero dependencies: the package parses an SVG document
with its own XML parser (no `DOMParser`, so it runs in Node, Deno, Bun, workers and
browsers), resolves styles and transforms, and returns what the document draws as
polygons, polylines and text boxes in canvas pixels, classified by CSS-like selectors. It
mirrors the Rust crate `label-anything-svg`; both pass `conformance/svg`.

To place labels over an SVG, use
[`@label-anything/core`](https://www.npmjs.com/package/@label-anything/core), which builds
on this package; use this one for the geometry alone.

```ts
import { classify, parseSvg } from "@label-anything/svg";

const scene = parseSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
  <rect width="200" height="100" fill="white"/>
  <circle id="p1" cx="50" cy="50" r="4" fill="steelblue"/>
  <text x="100" y="50" font-size="10">Label</text>
</svg>`);
if (!scene.ok) throw new Error(scene.error.message); // functions return results, never throw

const classified = classify(scene.value, [
  { selector: ":background", class: "ignore" }, // the white rectangle behind everything
  { selector: "text", class: "text" },
  { selector: "circle", class: "points" },
], "ink"); // the class of everything else
if (classified.ok) classified.value.map((c) => c.class); // ["points", "text"]
```

Not modelled: clipping, masks, filters, markers, dashes, gradients and patterns (any
paint server counts as opaque) and per-glyph text positioning.

MIT License.
