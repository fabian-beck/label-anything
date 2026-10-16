// Rough timings of the geometry hot paths of the TypeScript port, with the same inputs
// (PCG32) as rust/crates/la-core/examples/geom_bench.rs, so the printed checksums must equal
// the Rust ones:
//
// * rasterize 100k discs (r = 1.5 px) into a 1920×1080 extent with 4 px cells, then build
//   the summed-area table;
// * 1M SAT queries (coveredArea) of label-sized rectangles;
// * 100k static index queries on 100k points (and the index build);
// * 1M shape-vs-rectangle overlap tests per shape kind (rectangles near the shapes).
//
// Run (from ts/, after `npx tsc -b packages/core`):
//   node packages/core/bench/geom-bench.mjs [runs]
import { sinCosDeg } from "../dist/detmath.js";
import { P, Rect } from "../dist/geom/index.js";
import { Shape } from "../dist/geom/shape.js";
import { GridSpec, Sat } from "../dist/grid/index.js";
import { MaskRaster } from "../dist/grid/raster.js";
import { Pcg32 } from "../dist/pcg.js";
import { IdList, StaticIndex } from "../dist/spatial.js";

const runs = Number(process.argv[2] ?? 5);

/**
 * Best wall time in ms of `runs` runs of `f` (which returns a checksum), after a warm-up
 * run. On a busy machine the minimum is the most stable statistic. (No forced GC between
 * runs: after a forced full GC, allocating the large typed arrays of the rasterizer made
 * the next run much slower than in normal operation.)
 */
function best(f) {
  let t = Infinity;
  let sum = f();
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    sum = f();
    t = Math.min(t, performance.now() - t0);
  }
  return [t, sum];
}

function report(name, [ms, checksum]) {
  console.log(`${name.padEnd(44)} ${ms.toFixed(2).padStart(9)} ms   checksum ${checksum}`);
}

function shapes(rng, kind, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = new P(rng.nextF64() * 200, rng.nextF64() * 200);
    if (kind === 0) {
      out.push(Shape.circle(c, 1 + rng.nextF64() * 19));
    } else if (kind === 1) {
      const rx = 2 + rng.nextF64() * 18;
      const ry = 2 + rng.nextF64() * 18;
      out.push(Shape.ellipse(c, rx, ry, rng.nextF64() * 180));
    } else if (kind === 2) {
      const w = 4 + rng.nextF64() * 36;
      const h = 4 + rng.nextF64() * 36;
      const r = rng.nextF64() * 5;
      out.push(Shape.rect(c, w, h, r, rng.nextF64() * 90));
    } else {
      const ring = [];
      for (let k = 0; k < 8; k++) {
        const [s, co] = sinCosDeg(k * 45);
        const r = 5 + rng.nextF64() * 15;
        ring.push(new P(c.x + co * r, c.y + s * r));
      }
      out.push(Shape.polygon([ring], false, c));
    }
  }
  return out;
}

// 1. rasterize 100k discs + SAT
const grid = GridSpec.covering(new Rect(0, 0, 1920, 1080), 4);
let rng = new Pcg32(1);
const discs = new Float64Array(200_000);
for (let i = 0; i < 100_000; i++) {
  discs[2 * i] = rng.nextF64() * 1920;
  discs[2 * i + 1] = rng.nextF64() * 1080;
}
let sat = null;
report(
  "raster: 100k discs r=1.5 (480x270) + SAT",
  best(() => {
    const m = new MaskRaster(grid);
    for (let i = 0; i < 100_000; i++) m.discXY(discs[2 * i], discs[2 * i + 1], 1.5);
    const cov = m.intoCoverage();
    sat = Sat.fromCoverage(grid.cols, grid.rows, cov);
    let sum = 0;
    for (let i = 0; i < cov.length; i++) sum += cov[i];
    return sum;
  }),
);

// 2. 1M SAT queries
rng = new Pcg32(2);
const pool = [];
for (let i = 0; i < 65_536; i++) {
  const x = rng.nextF64() * 1940 - 20;
  const y = rng.nextF64() * 1100 - 20;
  const w = 5 + rng.nextF64() * 75;
  pool.push(Rect.xywh(x, y, w, 5 + rng.nextF64() * 25));
}
report(
  "sat: 1M covered_area queries",
  best(() => {
    let total = 0;
    for (let i = 0; i < 1_000_000; i++) total += sat.coveredArea(grid, pool[i & 65_535]);
    return total;
  }),
);

// 3. spatial index: 100k points, 100k queries
rng = new Pcg32(3);
const boxes = [];
for (let i = 0; i < 100_000; i++) {
  const p = new P(rng.nextF64() * 1920, rng.nextF64() * 1080);
  boxes.push(Rect.fromCenter(p, 0, 0));
}
const queries = [];
for (let i = 0; i < 100_000; i++) {
  const x = rng.nextF64() * 1920 - 40;
  const y = rng.nextF64() * 1080 - 10;
  const w = 20 + rng.nextF64() * 60;
  queries.push(Rect.xywh(x, y, w, 8 + rng.nextF64() * 12));
}
const extent = new Rect(0, 0, 1920, 1080);
let ix = null;
report(
  "index: build on 100k points (cell 16)",
  best(() => {
    ix = new StaticIndex(boxes.slice(), extent, 16);
    return ix.len();
  }),
);
report(
  "index: 100k queries",
  best(() => {
    const buf = new IdList();
    let total = 0;
    for (let i = 0; i < queries.length; i++) {
      ix.query(queries[i], buf);
      total += buf.len;
    }
    return total;
  }),
);

// 4. shape-vs-rect overlap tests
for (const [kind, name] of [
  [0, "circle"],
  [1, "ellipse"],
  [2, "round rect"],
  [3, "polygon"],
]) {
  rng = new Pcg32(4 + kind);
  const ss = shapes(rng, kind, 1024);
  const pk = new Int32Array(4096);
  const pr = [];
  for (let i = 0; i < 4096; i++) {
    const k = rng.nextBelow(1024);
    const c = ss[k].reference();
    const x = c.x + rng.nextF64() * 60 - 40;
    const y = c.y + rng.nextF64() * 40 - 25;
    const w = 10 + rng.nextF64() * 50;
    pk[i] = k;
    pr.push(Rect.xywh(x, y, w, 6 + rng.nextF64() * 14));
  }
  report(
    `overlaps_rect: 1M tests, ${name}`,
    best(() => {
      let hits = 0;
      for (let i = 0; i < 1_000_000; i++) {
        if (ss[pk[i & 4095]].overlapsRect(pr[i & 4095])) hits += 1;
      }
      return hits;
    }),
  );
}
