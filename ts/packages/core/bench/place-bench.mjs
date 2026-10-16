// Timings of `place` on the brief's performance problems (§5.8), against the TypeScript
// targets:
//
// * p200:  200 labels + 10k obstacle points, 800×600     ≤ 60 ms
// * p2000: 2,000 labels + 100k obstacle points, 1920×1080 ≤ 600 ms (greedy)
//
// Problems: preset "scatter", items `{"id": "i<k>", "anchor": {"type": "point", ...},
// "label": {"type": "text", "text": "Label <k>"}}` with anchors uniform in
// [10, w−10]×[10, h−10] and one vector layer `{"class": "points", "points": [...],
// "r": 1.5}`, `"solver": {"strategy": "greedy"}`; coordinates from PCG32 with fixed seeds,
// so every run (and the Rust CLI on the written files) solves the same problems.
//
// Run from the repository root after `npm run build`:
//   node ts/packages/core/bench/place-bench.mjs [runs] [--write <dir>]
// `--write <dir>` also writes p200.json and p2000.json (e.g. to time the Rust CLI:
// `rust/target/release/label-anything place <dir>/p2000.json -o /dev/null`).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { place } from "../dist/index.js";
import { Pcg32 } from "../dist/pcg.js";

const args = process.argv.slice(2);
const wi = args.indexOf("--write");
const writeDir = wi >= 0 ? args[wi + 1] : null;
const runs = Number(args.find((a, i) => /^\d+$/.test(a) && (wi < 0 || i !== wi + 1)) ?? 7);

/** The performance problem with `n` labels and `points` obstacle points on a `w × h` canvas. */
export function perfProblem(n, points, w, h, seed) {
  const rng = new Pcg32(seed);
  const items = [];
  for (let k = 0; k < n; k++) {
    const x = 10 + rng.nextF64() * (w - 20);
    const y = 10 + rng.nextF64() * (h - 20);
    items.push({ id: `i${k}`, anchor: { type: "point", x, y }, label: { type: "text", text: `Label ${k}` } });
  }
  const pts = [];
  for (let k = 0; k < points; k++) pts.push([rng.nextF64() * w, rng.nextF64() * h]);
  return {
    preset: "scatter",
    canvas: { width: w, height: h },
    items,
    obstacles: { vector: [{ class: "points", points: pts, r: 1.5 }] },
    solver: { strategy: "greedy" },
  };
}

const cases = [
  { name: "p200", problem: perfProblem(200, 10_000, 800, 600, 200), target: 60 },
  { name: "p2000", problem: perfProblem(2000, 100_000, 1920, 1080, 2000), target: 600 },
];

if (writeDir !== null && writeDir !== undefined) {
  mkdirSync(writeDir, { recursive: true });
  for (const c of cases) writeFileSync(join(writeDir, `${c.name}.json`), JSON.stringify(c.problem));
}

for (const c of cases) {
  // warm-up (JIT tier-up)
  let r = place(c.problem);
  r = place(c.problem);
  const times = [];
  const reported = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    r = place(c.problem);
    times.push(performance.now() - t0);
    reported.push(r.stats.runtime_ms);
  }
  times.sort((a, b) => a - b);
  reported.sort((a, b) => a - b);
  const min = times[0];
  const median = times[times.length >> 1];
  const ph = r.stats.phases_ms;
  console.log(
    `${c.name.padEnd(6)} placed ${String(r.stats.placed).padStart(4)}/${r.stats.total}  ` +
      `min ${min.toFixed(1).padStart(7)} ms  median ${median.toFixed(1).padStart(7)} ms  ` +
      `(target ${c.target} ms: ${min <= c.target ? "ok" : "MISSED"})  ` +
      `phases prepare ${ph.prepare.toFixed(1)} candidates ${ph.candidates.toFixed(1)} greedy ${ph.greedy.toFixed(1)} ` +
      `local ${ph.local.toFixed(1)} verify ${ph.verify.toFixed(1)}  candidates ${r.stats.candidates}`,
  );
}
