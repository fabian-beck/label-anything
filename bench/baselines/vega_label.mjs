// Vega's label transform (vega-label) run headless for the Label Anything benchmark.
//
//   node bench/baselines/vega_label.mjs scene.json out.json
//
// scene.json is written by bench/baselines/vega_label_baseline.py: the label area size, the
// labeled items (their mark outlines as SVG paths, label box w x h, priority rank) and the
// obstacle layers, all in layout coordinates (canvas px minus the label area's origin, y down).
// One Vega view is built: one mark per obstacle layer, a `path` base mark with the labeled
// items' marks, and a `text` mark over the base mark (reactive geometry) with the `label`
// transform: anchors in the problem's position order, the problem's offset, avoidMarks = all
// obstacle layers, avoidBaseMark = true (labels avoid every labeled mark), sort = priority
// rank. vega-label rasterizes the avoided marks through node-canvas (`canvas` package).
//
// Text measurement: vega-label takes a label's width from textMetrics.width(item, text) and
// its height from the text item's fontSize. Every tool in the benchmark reserves the
// problem's label box (spec §5 measurement, padding included), so textMetrics.width returns
// the box width (a supported customization point of vega-scenegraph) and fontSize is the box
// height. Output: per label x, y, align, baseline and opacity (0 = not placed).
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as vega from 'vega';

const [scenePath, outPath] = process.argv.slice(2);
if (!scenePath || !outPath) {
  console.error('usage: node vega_label.mjs scene.json out.json');
  process.exit(2);
}
const sc = JSON.parse(readFileSync(scenePath, 'utf8'));
const pkgVersion = (name) =>
  JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;
const versions = {
  vega: vega.version,
  'vega-label': pkgVersion('vega-label'),
  canvas: pkgVersion('canvas'),
  node: process.versions.node,
};

const measure = vega.textMetrics.width;
vega.textMetrics.width = (item, text) => {
  const row = item && item.datum && item.datum.datum;
  return row && typeof row.w === 'number' ? row.w : measure(item, text);
};

const black = { value: '#000' };
const data = [{ name: 'items', values: sc.labels }];
const marks = [];
const avoid = [];
for (const layer of sc.layers) {
  data.push({ name: `${layer.name}_data`, values: layer.values });
  let enter;
  if (layer.type === 'symbol') {
    enter = { x: { field: 'x' }, y: { field: 'y' }, size: { field: 'size' }, shape: { value: 'circle' }, fill: black };
  } else if (layer.type === 'rect') {
    enter = { x: { field: 'x' }, y: { field: 'y' }, width: { field: 'w' }, height: { field: 'h' }, fill: black };
  } else if (layer.type === 'stroke') {
    enter = { path: { field: 'path' }, stroke: black, strokeWidth: { field: 'width' }, strokeCap: { value: 'butt' } };
  } else {
    enter = { path: { field: 'path' }, fill: black };
  }
  marks.push({ type: layer.type === 'symbol' || layer.type === 'rect' ? layer.type : 'path', name: layer.name,
               from: { data: `${layer.name}_data` }, encode: { enter } });
  avoid.push(layer.name);
}
marks.push({ type: 'path', name: 'base', from: { data: 'items' },
             encode: { enter: { path: { field: 'path' }, fill: black } } });
marks.push({
  type: 'text', name: 'labels', from: { data: 'base' },
  encode: { enter: { text: { field: 'datum.text' }, fontSize: { field: 'datum.h' },
                     font: { value: 'Noto Sans' }, fill: black } },
  transform: [{
    type: 'label', size: [sc.width, sc.height], anchor: sc.anchors, offset: [sc.offset],
    avoidMarks: avoid, avoidBaseMark: true, padding: 0,
    sort: { field: 'datum.datum.rank', order: 'ascending' },
  }],
});
const spec = { width: sc.width, height: sc.height, padding: 0, autosize: 'none', data, marks };

// time the label transform itself (bitmaps of the avoided marks + placement)
const Label = vega.transforms.label;
const run = Label.prototype.transform;
let labelMs = 0;
Label.prototype.transform = function (...args) {
  const t = performance.now();
  try {
    return run.apply(this, args);
  } finally {
    labelMs += performance.now() - t;
  }
};

const view = new vega.View(vega.parse(spec), { renderer: 'none' });
const t0 = performance.now();
await view.runAsync();
const totalMs = performance.now() - t0;

function findMark(node, name) {
  if (!node) return null;
  if (node.marktype && node.name === name) return node;
  for (const child of node.items || []) {
    const hit = findMark(child, name);
    if (hit) return hit;
  }
  return null;
}
const mark = findMark(view.scenegraph().root, 'labels');
const labels = (mark ? mark.items : []).map((it) => ({
  id: it.datum.datum.id, x: it.x, y: it.y, align: it.align, baseline: it.baseline, opacity: it.opacity,
}));
writeFileSync(outPath, JSON.stringify({ versions, runtime_ms: labelMs, total_ms: totalMs, labels }));
view.finalize();
