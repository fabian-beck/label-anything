// Rough timings of process() and backdropLuma() on 2048×2048 synthetic rasters (decode
// excluded), the same pixels as rust/crates/la-raster/examples/bench.rs (integer
// arithmetic only), so the printed coverage checksums must equal the Rust ones.
//
// Run (from ts/, after `npx tsc -b packages/raster`):
//   node packages/raster/bench/bench.mjs [size] [cell] [filter]
import { backdropLuma, process } from "../dist/index.js";

class Lcg {
  constructor(seed) {
    this.state = seed >>> 0;
  }
  next() {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  }
  below(n) {
    // floor(next * n / 2^32) without precision loss (next < 2^32, n < 2^21).
    return Math.floor((this.next() * n) / 4294967296);
  }
}

function blend(img, x, y, rgb, k) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height || k === 0) return;
  const i = (y * img.width + x) * 4;
  for (let c = 0; c < 3; c++) img.data[i + c] = Math.floor((rgb[c] * k + img.data[i + c] * (16 - k)) / 16);
}

function disc(img, cx8, cy8, r8, rgb) {
  const x0 = Math.trunc((cx8 - r8) / 8) - 1;
  const x1 = Math.trunc((cx8 + r8) / 8) + 1;
  const y0 = Math.trunc((cy8 - r8) / 8) - 1;
  const y1 = Math.trunc((cy8 + r8) / 8) + 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let k = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const dx = x * 8 + sx * 2 + 1 - cx8;
          const dy = y * 8 + sy * 2 + 1 - cy8;
          if (dx * dx + dy * dy <= r8 * r8) k++;
        }
      }
      blend(img, x, y, rgb, k);
    }
  }
}

function chart(size) {
  const n = size;
  const img = { width: n, height: n, data: new Uint8Array(n * n * 4).fill(255) };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (x % 128 === 0 || y % 128 === 0) img.data.set([225, 225, 225], (y * n + x) * 4);
    }
  }
  const rng = new Lcg(42);
  const colors = [[31, 119, 180], [255, 127, 14], [44, 160, 44], [214, 39, 40], [148, 103, 189]];
  for (let s = 0; s < 5; s++) {
    let y8 = rng.below(size * 8);
    for (let x = 0; x < size; x++) {
      y8 = Math.min(Math.max(y8 + rng.below(41) - 20, 0), size * 8 - 1);
      disc(img, x * 8 + 4, y8, 12, colors[s]);
    }
  }
  for (let i = 0; i < 3000; i++) {
    const cx = rng.below(size * 8);
    const cy = rng.below(size * 8);
    const r = 16 + rng.below(32);
    disc(img, cx, cy, r, colors[rng.below(5)]);
  }
  for (let i = 0; i < 400; i++) {
    const x0 = rng.below(size - 40);
    const y0 = rng.below(size - 12);
    const w = 4 + rng.below(30);
    const h = 6 + rng.below(5);
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) if ((x + y) % 5 !== 0) img.data.set([20, 20, 20], (y * n + x) * 4);
    }
  }
  return img;
}

function photo(size) {
  const n = size;
  const data = new Uint8Array(n * n * 4).fill(255);
  const rng = new Lcg(7);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const noise = rng.below(48);
      data[i] = (Math.floor((x * 255) / n) + noise) % 256;
      data[i + 1] = (Math.floor((y * 255) / n) + Math.floor(noise / 2)) % 256;
      data[i + 2] = (Math.floor(((x + y) * 127) / n) + noise) % 256;
    }
  }
  return { width: n, height: n, data };
}

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
