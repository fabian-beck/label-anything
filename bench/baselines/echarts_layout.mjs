// Apache ECharts scatter labels with `labelLayout: {hideOverlap: true}`, rendered server-side (no DOM)
// for the Label Anything benchmark.
//
//   node bench/baselines/echarts_layout.mjs scene.json out.json
//
// scene.json is written by bench/baselines/echarts_baseline.py: the canvas size, the label position (one
// of top / right / bottom / left), the distance from the symbol and the labels in priority order, each
// with its anchor, its mark (circle diameter, or the bounding box of another shape as a rect symbol) and
// its box (w x h). One scatter series on value axes of exactly the canvas (y inverted, no grid margins)
// draws every labeled item; every label is at the given position and distance, and hideOverlap then
// hides, in order of decreasing symbol area (stable, so ties keep the data order = priority), every label
// that overlaps one already shown (ECharts' default: `priority` = the area of the host's bounding rect).
//
// Text measurement: ECharts measures text through its platform API; every label's text is a unique key
// whose measured width is the label box width, and `lineHeight` (padding 0) is the box height, so the
// label rect ECharts lays out is the problem's box. Output: per label its rect and whether it is hidden.
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as echarts from 'echarts';

const [scenePath, outPath] = process.argv.slice(2);
if (!scenePath || !outPath) {
  console.error('usage: node echarts_layout.mjs scene.json out.json');
  process.exit(2);
}
const sc = JSON.parse(readFileSync(scenePath, 'utf8'));
const versions = { echarts: echarts.version, node: process.versions.node };

const key = (k) => `L${k}`;
const widths = new Map(sc.labels.map((l, k) => [key(k), l.w]));
echarts.setPlatformAPI({ measureText: (text) => ({ width: widths.get(text) ?? 0 }) });

const data = sc.labels.map((l, k) => ({
  value: [l.x, l.y], name: key(k),
  symbol: l.rect ? 'rect' : 'circle', symbolSize: l.rect ? [l.rect[0], l.rect[1]] : l.d,
  label: { lineHeight: l.h, fontSize: l.font_size, fontWeight: l.bold ? 'bold' : 'normal' },
}));
const t0 = performance.now();
const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: sc.width, height: sc.height });
chart.setOption({
  animation: false,
  grid: { left: 0, right: 0, top: 0, bottom: 0 },
  xAxis: { type: 'value', min: 0, max: sc.width, show: false },
  yAxis: { type: 'value', min: 0, max: sc.height, show: false, inverse: true },
  series: [{
    type: 'scatter', data, clip: false,
    label: { show: true, position: sc.position, distance: sc.distance, formatter: '{b}', padding: 0 },
    labelLayout: { hideOverlap: true },
  }],
});
const runtimeMs = performance.now() - t0;
const byKey = new Map(sc.labels.map((l, k) => [key(k), l.id]));
const labels = [];
chart.getZr().storage.traverse((el) => {
  const t = el.getTextContent && el.getTextContent();
  if (!t || !byKey.has(t.style.text)) return;
  const r = t.getBoundingRect().clone();
  r.applyTransform(t.getComputedTransform());
  labels.push({ id: byKey.get(t.style.text), x: r.x, y: r.y, w: r.width, h: r.height, hidden: !!t.ignore });
});
chart.dispose();
writeFileSync(outPath, JSON.stringify({ versions, runtime_ms: runtimeMs, labels }));
