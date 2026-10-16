// The JavaScript example of the design brief (§6.2), verbatim, run against
// @label-anything/core (the pure TypeScript engine), after a prelude that creates what it
// assumes (`points`, `svgEl`), followed by checks (js_6_2_shared.mjs). js_6_2_wasm.mjs
// runs it against @label-anything/wasm, as the snippet's comment allows.
//
//   npm run build                     # once
//   node examples/brief/js_6_2.mjs

import { points, svgEl, checks } from "./js_6_2_shared.mjs";

// --- §6.2 verbatim ---
import { place } from "@label-anything/core";   // or "@label-anything/wasm" with the identical API
const res = place({
  canvas: { width: 800, height: 600 },
  items: points.map(p => ({ id: p.id, anchor: { type: "point", x: p.x, y: p.y }, label: { type: "text", text: p.name } })),
  obstacles: { svg: { source: svgEl.outerHTML, classes: [{ selector: "circle", class: "points" }] } },
  avoid: { label: { points: 0.3 } },
  leaders: { style: "straight" },
  priority: { terms: [{ attr: "population", transform: "log1p" }], omission: "prefix" },
  // or: priority: item => item.attrs.population   (callback, TS/WASM)
});

checks(res, place, "core");
