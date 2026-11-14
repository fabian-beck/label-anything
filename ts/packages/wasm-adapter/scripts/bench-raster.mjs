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
import { chart, photo } from "../../raster/bench/images.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const runs = Number(opt("--runs", 7));
const native = opt("--native", undefined);
const SIZE = 2048;

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
