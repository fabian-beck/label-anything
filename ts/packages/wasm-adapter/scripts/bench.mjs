#!/usr/bin/env node
/**
 * Times `place` of the built package in Node.
 *
 *   node scripts/bench.mjs [--runs 10] [--warmup 3] problem.json...
 *
 * For each problem: the first call after instantiation (cold: V8 compiles and tiers up the
 * module lazily), then the median of --runs calls after --warmup calls (warm). "total" is
 * the whole call (JSON.stringify, copying in, solving, JSON.parse of the result); "solver"
 * is `stats.runtime_ms` (from model building to the result object).
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import * as la from "../dist/node.js";

const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = Number(args[i + 1]);
  args.splice(i, 2);
  return v;
}
const runs = option("--runs", 10);
const warmup = option("--warmup", 3);
if (args.length === 0) {
  console.error("usage: node scripts/bench.mjs [--runs 10] [--warmup 3] problem.json...");
  process.exit(2);
}

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const t0 = performance.now();
la.initSync(readFileSync(new URL("../wasm/label_anything_bg.wasm", import.meta.url)));
console.log(`instantiate: ${(performance.now() - t0).toFixed(1)} ms (features: ${la.features().join(", ")})`);

for (const file of args) {
  const problem = JSON.parse(readFileSync(file, "utf8"));
  const once = () => {
    const t = performance.now();
    const r = la.place(problem);
    return { total: performance.now() - t, solver: r.stats.runtime_ms, placed: r.stats.placed, n: r.stats.total };
  };
  const cold = once();
  for (let i = 0; i < warmup; i++) once();
  const warm = Array.from({ length: runs }, once);
  console.log(
    `${basename(file)}: placed ${cold.placed}/${cold.n}; cold ${cold.total.toFixed(1)} ms ` +
      `(solver ${cold.solver.toFixed(1)}); warm median ${median(warm.map((w) => w.total)).toFixed(1)} ms ` +
      `(solver ${median(warm.map((w) => w.solver)).toFixed(1)}, min ${Math.min(...warm.map((w) => w.total)).toFixed(1)}) over ${runs} runs`,
  );
}
