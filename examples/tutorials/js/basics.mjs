// Getting started with JavaScript/TypeScript (docs/getting-started/javascript.md):
// place, validate, errors, options and the debug overlay with @label-anything/core.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

// --8<-- [start:place]
import { place, validate, renderDebugSvg, PlaceError } from "@label-anything/core";

const problem = {
  canvas: { width: 800, height: 600 },
  items: [
    { id: "a", anchor: { type: "point", x: 120, y: 80 }, label: { type: "text", text: "Alpha" } },
    { id: "b", anchor: { type: "point", x: 130, y: 85 }, label: { type: "text", text: "Beta" } },
    { id: "c", anchor: { type: "point", x: 400, y: 300 }, label: { type: "text", text: "Gamma" } },
  ],
};
const result = place(problem);           // also accepts the problem as JSON text
for (const p of result.placements) {
  if (p.placed) console.log(p.id, p.box, p.anchor_side, p.leader?.points);
  else console.log(p.id, "omitted:", p.reason, p.blocked_by);
}
// --8<-- [end:place]
assert.equal(result.stats.placed, 3);
assert.equal(result.stats.hard_violations, 0);

// --8<-- [start:validate]
const report = validate({ canvas: { width: -1, height: 100 }, items: [] });
console.log(report.valid, report.errors);   // false [{ pointer: "/canvas/width", code: "range", ... }]
try {
  place({ items: [{ anchor: { type: "point", x: 1 }, label: { type: "text", text: "A" } }] });
} catch (e) {
  if (!(e instanceof PlaceError)) throw e;
  for (const issue of e.errors) console.log(issue.pointer, issue.code, issue.message);   // /items/0/anchor/y required ...
}
// --8<-- [end:validate]
assert.equal(report.valid, false);
assert.equal(report.errors[0].pointer, "/canvas/width");

// --8<-- [start:options]
const controller = new AbortController();     // controller.abort() cancels from a callback or a worker
const withOptions = place(problem, {
  measure: (text, font) => ({ width: 0.6 * font.size * text.length, ascent: 0.8 * font.size, descent: 0.2 * font.size }),
  priority: (item, index) => (item.id === "c" ? [1, 0] : 10 - index),   // a score, or [tier, score]
  cost: (candidate) => (candidate.box.y < 40 ? 5 : 0),                 // extra cost per candidate
  progress: (phase, fraction) => console.log(phase, fraction.toFixed(2)),
  signal: controller.signal,
});
// --8<-- [end:options]
assert.equal(withOptions.stats.placed, 3);
assert.ok(Math.abs(withOptions.placements[0].box.w - (0.6 * 12 * 5 + 2 * 1.8)) < 1e-9, JSON.stringify(withOptions.placements[0].box));
assert.equal(withOptions.placements[2].priority.tier, 1);

// --8<-- [start:pixels]
const width = 400, height = 300;
const data = new Uint8ClampedArray(width * height * 4).fill(255);   // e.g. ctx.getImageData(...).data
for (let y = 0; y < height; y++) for (let x = 180; x < 220; x++) data.set([30, 30, 30], (y * width + x) * 4);
const onPixels = place(
  {
    obstacles: { raster: { source: "host", mode: "ink" } },   // options for the pixels below
    avoid: { label: { ink: "hard" } },
    items: [{ id: "p", anchor: { type: "point", x: 200, y: 150 }, label: { type: "text", text: "Next to the band" } }],
  },
  { raster: { width, height, data } },                        // an ImageData qualifies
);
// --8<-- [end:pixels]
const box = onPixels.placements[0].box;
assert.ok(onPixels.placements[0].placed && (box.x + box.w <= 180 || box.x >= 220), JSON.stringify(onPixels.placements[0]));

// --8<-- [start:debug]
writeFileSync("overlay.svg", renderDebugSvg(problem, result));   // marks, obstacles, boxes, leaders
// --8<-- [end:debug]
console.log("ok");
