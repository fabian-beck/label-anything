// The JavaScript example of the design brief (§6.2), verbatim, run against
// @label-anything/wasm (the snippet's comment allows it: "or "@label-anything/wasm" with
// the identical API"), after a prelude that creates what it assumes (`points`, `svgEl`),
// followed by checks. The checks also run the commented callback variant of `priority`.
//
//   npm run build:wasm -w @label-anything/wasm && npm run build   # once
//   node examples/brief/js_6_2.mjs
//
// The import below is hoisted (ES modules), so the prelude's variables exist when the
// snippet runs.

// --- prelude: cities with a population, and an SVG scatter plot drawn as <circle>s ---
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const points = Array.from({ length: 90 }, (_, i) => ({
  id: `c${i}`,
  x: Math.round(Math.min(780, Math.max(20, 400 + 150 * gauss())) * 10) / 10,
  y: Math.round(Math.min(580, Math.max(20, 300 + 110 * gauss())) * 10) / 10,
  name: `City ${i}`,
  population: Math.round(1000 * Math.exp(6 * rand())),
}));
const background = Array.from({ length: 300 }, () => [20 + 760 * rand(), 20 + 560 * rand()]);
const circles = [...points.map((p) => [p.x, p.y]), ...background]
  .map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5"/>`)
  .join("");
const svgEl = {
  outerHTML: `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">${circles}</svg>`,
};

// --- §6.2 verbatim (the import names @label-anything/wasm, as its comment allows) ---
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

// --- checks ---
import assert from "node:assert/strict";

function check(r, order, what) {
  assert.equal(r.stats.hard_violations, 0, `${what}: hard violations`);
  assert.equal(r.stats.leader_crossings, 0, `${what}: leader crossings`);
  assert.equal(r.placements.length, points.length, `${what}: one placement per point`);
  assert.ok(r.stats.grid.classes.includes("points"), `${what}: the SVG circles are the class "points"`);
  // omission "prefix": the placed labels are a prefix of the priority order
  const placed = new Set(r.placements.filter((p) => p.placed).map((p) => p.id));
  const k = placed.size;
  assert.ok(k >= 30, `${what}: only ${k} of ${points.length} placed`);
  assert.deepEqual([...placed].sort(), order.slice(0, k).sort(), `${what}: placed set is a prefix`);
  for (const p of r.placements) {
    if (!p.placed) assert.equal(p.reason, "omitted_by_priority", `${what}: reason of ${p.id}`);
  }
  console.log(`${what}: ${k}/${points.length} placed, ${r.placements.filter((p) => p.leader).length} with leaders, ` +
    `${r.stats.runtime_ms.toFixed(1)} ms`);
}

// The items carry no `attrs`, so the population term is missing for all of them: every
// score is 0 and the input order decides (ties "input_order").
check(res, points.map((p) => p.id), "§6.2 as written");

// The commented variant: a priority callback (PlaceOptions.priority, api.ts). It reads
// `item.attrs.population`, so this problem adds `attrs: { population }` to the items.
const withAttrs = {
  canvas: { width: 800, height: 600 },
  items: points.map(p => ({ id: p.id, anchor: { type: "point", x: p.x, y: p.y }, label: { type: "text", text: p.name }, attrs: { population: p.population } })),
  obstacles: { svg: { source: svgEl.outerHTML, classes: [{ selector: "circle", class: "points" }] } },
  avoid: { label: { points: 0.3 } },
  leaders: { style: "straight" },
  priority: { terms: [{ attr: "population", transform: "log1p" }], omission: "prefix" },
};
// higher population first; equal scores keep the input order (ties "input_order")
const byPopulation = points
  .map((p, i) => [p, i])
  .sort(([a, i], [b, j]) => b.population - a.population || i - j)
  .map(([p]) => p.id);
const viaCallback = place(withAttrs, { priority: item => item.attrs.population });
check(viaCallback, byPopulation, "callback priority");
// the attribute term gives the same order as the callback (log1p is monotonic)
check(place(withAttrs), byPopulation, "attribute term");
console.log("ok");
