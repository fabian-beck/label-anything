// Synthetic 8-bit RGBA test images for the raster benchmarks: a line "chart" and a noisy
// "photo", generated with integer arithmetic only, so that they are the same pixels as in
// rust/crates/la-raster/examples/bench.rs (and the coverage checksums can be compared).
// Used by ./bench.mjs and by ../../wasm-adapter/scripts/bench-raster.mjs.

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

/** A white chart with grid lines, polylines, discs and text-like blocks, `size` px square. */
export function chart(size) {
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

/** A colour gradient with noise (hundreds of thousands of distinct colours), `size` px square. */
export function photo(size) {
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
