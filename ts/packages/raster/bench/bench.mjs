// Rough timings of process() and backdropLuma() on 2048×2048 synthetic rasters (decode
// excluded), the same pixels as rust/crates/la-raster/examples/bench.rs (integer
// arithmetic only), so the printed coverage checksums must equal the Rust ones.
//
// Run (from ts/, after `npx tsc -b packages/raster`):
//   node packages/raster/bench/bench.mjs [size] [cell] [filter]
import { backdropLuma, process } from "../dist/index.js";
import { chart, photo } from "./images.mjs";

function fnv1a32(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

function bench(filter, label, iterations, f) {
  if (!label.includes(filter)) return;
  const first = f();
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t = performance.now();
    f();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const sums = first.map((c) => `${c.class}:${fnv1a32(c.coverage)}`).join(" ");
  console.log(
    `${label.padEnd(22)} min ${times[0].toFixed(2).padStart(7)} ms  median ${times[times.length >> 1].toFixed(2).padStart(7)} ms  ${sums}`,
  );
}

const size = Number(process_arg(2) ?? 2048);
const cell = Number(process_arg(3) ?? 2);
const filter = process_arg(4) ?? "";
function process_arg(i) {
  return globalThis.process.argv[i];
}
const cols = Math.ceil(size / cell);
const grid = { originX: 0, originY: 0, cell, cols, rows: cols };
const place = { scale: 1, offset: [0, 0] };
const ink = { kind: "ink", background: null, threshold: 0.12, dilate: 1 };
const classmap = {
  kind: "classmap",
  palette: [
    [[31, 119, 180], "a"],
    [[214, 39, 40], "b"],
    [[20, 20, 20], "text"],
  ],
  tolerance: 0.08,
  unmatchedInk: true,
  background: null,
  inkThreshold: 0.12,
};
console.log(`${size}x${size} raster, cell ${cell} -> ${cols}x${cols} grid`);
for (const [name, img] of [
  ["chart", chart(size)],
  ["photo", photo(size)],
]) {
  bench(filter, `${name} ink`, 15, () => process(img, ink, "ink", place, grid));
  bench(filter, `${name} alpha`, 9, () => process(img, { kind: "alpha", threshold: 0.1 }, "ink", place, grid));
  bench(filter, `${name} cost`, 9, () => process(img, { kind: "cost", invert: false }, "cost", place, grid));
  bench(filter, `${name} classmap`, 9, () => process(img, classmap, "ink", place, grid));
  bench(filter, `${name} saliency`, 5, () => process(img, { kind: "saliency" }, "salient", place, grid));
  bench(filter, `${name} luma`, 9, () => [{ class: "luma", coverage: backdropLuma([[img, place]], [255, 255, 255], grid) }]);
}
