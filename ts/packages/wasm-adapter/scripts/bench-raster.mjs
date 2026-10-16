#!/usr/bin/env node
/**
 * Raster preparation timings: `place` with a 2048×2048 raster background passed as
 * pixels (`options.raster`), one item, a 1024×1024 grid (cell 2), for the synthetic
 * "chart" and "photo" images of rust/crates/la-raster/examples/bench.rs (same
 * generator, integer arithmetic). Reports `stats.phases_ms.prepare` (model, raster
 * modes and coverage grids, priorities) and the whole call.
 *
 *   node scripts/bench-raster.mjs [--runs 7] [--native http://127.0.0.1:PORT]
 *
 * The same problems with the pixels as `obstacles.raster.rgba` base64 are timed too (the
 * prepare phase then includes the base64 decode); with --native they are also POSTed to
 * a running `label-anything serve --port PORT`, which gives the same phase natively.
 */
import { readFileSync } from "node:fs";
import * as la from "../dist/node.js";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const runs = Number(opt("--runs", 7));
const native = opt("--native", undefined);
const SIZE = 2048;

class Lcg {
  constructor(seed) {
    this.state = seed >>> 0;
  }
  next() {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  }
  below(n) {
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

function chart(n) {
  const img = { width: n, height: n, data: new Uint8Array(n * n * 4).fill(255) };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) if (x % 128 === 0 || y % 128 === 0) img.data.set([225, 225, 225], (y * n + x) * 4);
  }
  const rng = new Lcg(42);
  const colors = [[31, 119, 180], [255, 127, 14], [44, 160, 44], [214, 39, 40], [148, 103, 189]];
  for (let s = 0; s < 5; s++) {
    let y8 = rng.below(n * 8);
    for (let x = 0; x < n; x++) {
      y8 = Math.min(Math.max(y8 + rng.below(41) - 20, 0), n * 8 - 1);
      disc(img, x * 8 + 4, y8, 12, colors[s]);
    }
  }
  for (let i = 0; i < 3000; i++) disc(img, rng.below(n * 8), rng.below(n * 8), 16 + rng.below(32), colors[rng.below(5)]);
  for (let i = 0; i < 400; i++) {
    const x0 = rng.below(n - 40);
    const y0 = rng.below(n - 12);
    const w = 4 + rng.below(30);
    const h = 6 + rng.below(5);
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) if ((x + y) % 5 !== 0) img.data.set([20, 20, 20], (y * n + x) * 4);
    }
  }
  return img;
}

function photo(n) {
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

const MODES = {
  ink: { mode: "ink", ink: { background: "auto", threshold: 0.12, dilate: 1 } },
  alpha: { mode: "alpha", alpha: { threshold: 0.1 } },
  cost: { mode: "cost", cost: { invert: false }, class: "cost" },
  saliency: { mode: "saliency", class: "salient" },
};

function problem(source) {
  return {
    canvas: { width: SIZE, height: SIZE },
    items: [{ id: "a", anchor: { type: "point", x: 1024, y: 1024 }, label: { type: "text", text: "Label" } }],
    obstacles: { raster: source },
    solver: { strategy: "greedy", grid_cell: 2 },
  };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
la.initSync(readFileSync(new URL("../wasm/label_anything_bg.wasm", import.meta.url)));
console.log(`${SIZE}x${SIZE} raster as pixels, grid cell 2 (1024x1024), median of ${runs} warm runs`);
for (const [name, img] of [
  ["chart", chart(SIZE)],
  ["photo", photo(SIZE)],
]) {
  for (const [mode, opts] of Object.entries(MODES)) {
    const p = problem({ source: "pixels", ...opts });
    const raster = { width: img.width, height: img.height, data: img.data };
    const once = () => {
      const t = performance.now();
      const r = la.place(p, { raster });
      return [performance.now() - t, r.stats.phases_ms.prepare];
    };
    const cold = once();
    const warm = Array.from({ length: runs }, once);
    let line =
      `${`${name} ${mode}`.padEnd(15)} pixels: prepare ${median(warm.map((w) => w[1])).toFixed(1).padStart(6)} ms, ` +
      `place() ${median(warm.map((w) => w[0])).toFixed(1).padStart(6)} ms (first call ${cold[0].toFixed(0)} ms)`;
    const rgba = { width: img.width, height: img.height, data: Buffer.from(img.data.buffer).toString("base64") };
    const body = JSON.stringify(problem({ rgba, ...opts }));
    la.place(body);
    const b64 = Array.from({ length: runs }, () => la.place(body).stats.phases_ms.prepare);
    line += ` | base64: wasm prepare ${median(b64).toFixed(1).padStart(6)} ms`;
    if (native) {
      const post = async () => (await (await fetch(`${native}/place`, { method: "POST", body })).json()).stats.phases_ms.prepare;
      await post();
      const nat = [];
      for (let i = 0; i < runs; i++) nat.push(await post());
      line += `, native ${median(nat).toFixed(1).padStart(6)} ms, ratio ${(median(b64) / median(nat)).toFixed(2)}`;
    }
    console.log(line);
  }
}
