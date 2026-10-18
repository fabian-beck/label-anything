// d3fc-label-layout (layoutRemoveOverlaps(layoutGreedy())) run headless for the Label Anything benchmark.
//
//   node bench/baselines/d3fc_layout.mjs scene.json out.json
//
// scene.json is written by bench/baselines/d3fc_baseline.py: the label area and the labels in priority
// order, each with its anchor point, its box (w x h) and the margin m it keeps from the anchor (mark
// radius + placement offset). d3fc's strategies know only the labels: each label takes one of 8 positions
// with a corner or an edge midpoint at its anchor (`util/placements.js`), so every label goes to d3fc as
// its box grown by m on each side; the box drawn is the grown rect shrunk back by m, which keeps it m from
// the anchor (and the d3fc collision test conservative: grown rects that do not overlap hold boxes that do
// not either). The strategy is the README's: greedy in input order (least overlap area with the other
// rects, then least area outside the bounds = the label area), then removeOverlaps hides the label with
// the largest overlap until none overlaps. Output: per label the box position and whether it is hidden.
import { readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { performance } from 'node:perf_hooks';

// The package publishes its ES sources with extensionless relative imports (its `main`, a rollup
// bundle, is not in the npm tarball): a resolve hook adds ".js" to relative specifiers that fail.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); } catch (e) {
    if (specifier.startsWith('.') && !specifier.endsWith('.js')) return next(specifier + '.js', context);
    throw e;
  }
}`));
const { default: layoutGreedy } = await import('@d3fc/d3fc-label-layout/src/greedy.js');
const { default: layoutRemoveOverlaps } = await import('@d3fc/d3fc-label-layout/src/removeOverlaps.js');

const [scenePath, outPath] = process.argv.slice(2);
if (!scenePath || !outPath) {
  console.error('usage: node d3fc_layout.mjs scene.json out.json');
  process.exit(2);
}
const sc = JSON.parse(readFileSync(scenePath, 'utf8'));
const pkgVersion = (name) =>
  JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;
const versions = { 'd3fc-label-layout': pkgVersion('@d3fc/d3fc-label-layout'), node: process.versions.node };

const data = sc.labels.map((l) => ({ x: l.x, y: l.y, width: l.w + 2 * l.m, height: l.h + 2 * l.m }));
const [x0, y0, x1, y1] = sc.area;
const strategy = layoutRemoveOverlaps(layoutGreedy().bounds({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }));
const t0 = performance.now();
const out = strategy(data);
const runtimeMs = performance.now() - t0;
const labels = out.map((r, k) => ({
  id: sc.labels[k].id, x: r.x + sc.labels[k].m, y: r.y + sc.labels[k].m, location: r.location, hidden: !!r.hidden,
}));
writeFileSync(outPath, JSON.stringify({ versions, runtime_ms: runtimeMs, labels }));
