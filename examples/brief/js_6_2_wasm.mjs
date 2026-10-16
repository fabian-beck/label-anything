// The JavaScript example of the design brief (§6.2), run against @label-anything/wasm (the
// snippet's comment allows it: "or "@label-anything/wasm" with the identical API"); the
// same prelude and checks as js_6_2.mjs (@label-anything/core).
//
//   npm run build:wasm -w @label-anything/wasm && npm run build   # once
//   node examples/brief/js_6_2_wasm.mjs

import { points, svgEl, checks } from "./js_6_2_shared.mjs";

// --- §6.2 verbatim but for the package name (as its comment allows) ---
import { place } from "@label-anything/wasm";   // or "@label-anything/core" with the identical API
const res = place({
  canvas: { width: 800, height: 600 },
  items: points.map(p => ({ id: p.id, anchor: { type: "point", x: p.x, y: p.y }, label: { type: "text", text: p.name } })),
  obstacles: { svg: { source: svgEl.outerHTML, classes: [{ selector: "circle", class: "points" }] } },
  avoid: { label: { points: 0.3 } },
  leaders: { style: "straight" },
  priority: { terms: [{ attr: "population", transform: "log1p" }], omission: "prefix" },
  // or: priority: item => item.attrs.population   (callback, TS/WASM)
});

checks(res, place, "wasm");
