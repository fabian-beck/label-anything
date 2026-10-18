// D3-Labeler (Evan Wang, 2013: simulated annealing over label positions) run headless for the Label
// Anything benchmark.
//
//   node bench/baselines/d3_labeler.mjs scene.json out.json
//
// scene.json is written by bench/baselines/d3_labeler_baseline.py: the label area size, the number of
// sweeps, the seed and the labels in priority order, each with its anchor (and mark radius) and its box
// (w x h), in layout coordinates (canvas px minus the label area's origin, y down). The tool is the
// original labeler.js (vendor/d3-labeler, pinned commit), used as its README shows: every label starts
// with its baseline-left corner at its anchor, `d3.labeler().label(labels).anchor(anchors).width(W)
// .height(H).start(nsweeps)`. Its energy weighs leader length, leader crossings, label-label and
// label-anchor overlap and an orientation bias; walls keep the baseline-left corner (x, y) in [0, W] x
// [0, H]; the box of a label is [x, x + w] x [y - h + 2, y + 2]. It never omits a label. Its random
// moves use Math.random, replaced here by a seeded generator (mulberry32) so runs are reproducible.
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';

const [scenePath, outPath] = process.argv.slice(2);
if (!scenePath || !outPath) {
  console.error('usage: node d3_labeler.mjs scene.json out.json');
  process.exit(2);
}
const sc = JSON.parse(readFileSync(scenePath, 'utf8'));

let seed = sc.seed >>> 0;
Math.random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
globalThis.d3 = {};
vm.runInThisContext(readFileSync(new URL('./vendor/d3-labeler/labeler.js', import.meta.url), 'utf8'));

const lab = sc.labels.map((l) => ({ x: l.x, y: l.y, width: l.w, height: l.h }));
const anc = sc.labels.map((l) => ({ x: l.x, y: l.y, r: l.r }));
const t0 = performance.now();
if (lab.length) globalThis.d3.labeler().label(lab).anchor(anc).width(sc.width).height(sc.height).start(sc.sweeps);
const runtimeMs = performance.now() - t0;
const labels = lab.map((l, k) => ({ id: sc.labels[k].id, x: l.x, y: l.y - l.height + 2 }));
writeFileSync(outPath, JSON.stringify({ versions: { 'd3-labeler': sc.commit, node: process.versions.node },
                                        runtime_ms: runtimeMs, labels }));
