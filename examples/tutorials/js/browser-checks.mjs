// Runs the browser snippets of the docs (js/browser/*.mjs) in Node with jsdom and the real
// engine (@label-anything/core), using the real d3, Observable Plot, Vega, Leaflet and
// Cytoscape, and stand-ins with the helpers' `…Like` interfaces for MapLibre, sigma (both
// need WebGL) and a Web Worker. Run in a copy of examples/tutorials/data.
import "./harness/dom.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import L from "leaflet";
import cytoscape from "cytoscape";
import { scatterplot } from "./browser/d3.mjs";
import { chart } from "./browser/plot.mjs";
import { render } from "./browser/vega.mjs";
import { addCityLabels } from "./browser/leaflet.mjs";
import { addStationLabels } from "./browser/maplibre.mjs";
import { labelNodes } from "./browser/cytoscape.mjs";
import { labelGraph } from "./browser/sigma.mjs";
import { serve, solveInWorker } from "./browser/worker.mjs";
import { forceLabels } from "./browser/force.mjs";

const items = JSON.parse(readFileSync("../problems/priority-cities.json", "utf8")).items;
const cities = items.map((c) => ({ id: c.id, name: c.label.text, x: c.anchor.x, y: c.anchor.y, population: c.attrs.pop }));
const ok = (what, result, min = 1) => {
  console.log(`${what}: placed ${result.stats.placed}/${result.stats.total}`);
  assert.equal(result.stats.hard_violations, 0, `${what}: hard violations`);
  assert.ok(result.stats.placed >= min, `${what}: placed ${result.stats.placed}`);
};

// d3: labels drawn into the same <svg>
const d3Result = scatterplot(document.body, cities);
ok("d3", d3Result, 20);
assert.equal(document.querySelectorAll("svg g[data-la-labels] text").length >= d3Result.stats.placed, true);

// Observable Plot
const cars = Array.from({ length: 14 }, (_, i) => ({ name: `Car ${i}`, power: 60 + ((i * 37) % 140), economy: 15 + ((i * 11) % 25) }));
const svg = chart(cars);
assert.ok(svg.querySelectorAll("g[aria-label=labels] text").length >= 10, "Plot labels drawn");
console.log("plot: labels drawn", svg.querySelectorAll("g[aria-label=labels] text").length);

// Vega
const view = await render(cities.slice(0, 20));
const marks = view.scenegraph().root.items[0].items;
const texts = marks.find((m) => m.marktype === "text").items;
assert.ok(texts.filter((t) => t.opacity !== 0).length >= 10, "Vega labels visible");
console.log("vega: labels visible", texts.filter((t) => t.opacity !== 0).length);

// Leaflet (jsdom has no layout: give the map a size)
document.body.insertAdjacentHTML("beforeend", '<div id="map"></div>');
const map = L.map("map", { zoomAnimation: false, fadeAnimation: false });
map.getSize = () => L.point(480, 320);
map.setView([49.6, 11.0], 8, { animate: false });
const towns = cities.map((c) => ({ ...c, lat: 49.6 + (160 - c.y) / 300, lon: 11.0 + (c.x - 240) / 300 }));
const layer = addCityLabels(L, map, towns);
ok("leaflet", layer.result, 10);
map.panBy([40, 10], { animate: false });          // re-solved, warm-started from the last result
ok("leaflet after a pan", layer.result, 10);

// MapLibre (stand-in map: a linear projection, one road layer)
const listeners = new Map();
const container = document.createElement("div");
const fakeMap = {
  project: ([lng, lat]) => ({ x: (lng - 10.2) * 300, y: (50.2 - lat) * 300 }),
  getCanvasContainer: () => container,
  getCanvas: () => ({ clientWidth: 480, clientHeight: 320 }),
  on: (e, f) => listeners.set(e, [...(listeners.get(e) ?? []), f]),
  off: (e, f) => listeners.set(e, (listeners.get(e) ?? []).filter((g) => g !== f)),
  queryRenderedFeatures: (_geometry, options) =>
    options?.layers?.includes("roads") ? [{ layer: { id: "roads" }, geometry: { type: "LineString", coordinates: [[10.2, 49.6], [11.8, 49.6]] } }] : [],
};
const stations = towns.map((t) => ({ id: t.id, name: t.name, lat: t.lat, lon: t.lon, passengers: t.population }));
const mapLabels = addStationLabels(fakeMap, stations);
ok("maplibre", mapLabels.result, 10);
assert.ok(container.querySelector("svg text"), "MapLibre overlay drawn");

// Cytoscape (headless), the graph of the node-link tutorial
const graph = JSON.parse(readFileSync("../problems/graph.json", "utf8"));
const edges = [["core", "api"], ["core", "db"], ["api", "web"], ["api", "auth"], ["db", "search"], ["search", "index"]];
const cy = cytoscape({
  headless: true,
  layout: { name: "preset" },      // keep the positions below
  styleEnabled: true,
  elements: [
    ...graph.items.map((n) => ({ data: { id: n.id, label: n.id }, position: { x: n.anchor.x, y: n.anchor.y } })),
    ...edges.map(([s, t]) => ({ data: { id: `${s}-${t}`, source: s, target: t } })),
  ],
  style: [{ selector: "node", style: { label: "data(label)", width: 24, height: 24, "font-size": 12 } }],
});
const graphLabels = labelNodes(cy);
ok("cytoscape", graphLabels.result, 10);

// sigma (stand-in renderer with a graphology-like graph)
const settings = { labelFont: "Arial", labelSize: 14, labelWeight: "normal", defaultDrawNodeLabel: () => {}, nodeReducer: null };
const nodes = Object.fromEntries(graph.items.map((n) => [n.id, { x: n.anchor.x, y: n.anchor.y, size: 6, label: n.id }]));
const renderer = {
  getGraph: () => ({
    forEachNode: (f) => Object.entries(nodes).forEach(([k, v]) => f(k, { ...v })),
    forEachEdge: (f) => edges.forEach(([s, t]) => f(`${s}-${t}`, {}, s, t)),
  }),
  getNodeDisplayData: (k) => nodes[k] && { ...nodes[k] },
  framedGraphToViewport: (p) => ({ x: p.x * 0.75, y: p.y * 0.8 }),
  getDimensions: () => ({ width: 480, height: 320 }),
  getSetting: (k) => settings[k],
  setSetting: (k, v) => (settings[k] = v),
  getCamera: () => ({ on: () => undefined, removeListener: () => undefined }),
  on: () => undefined,
  refresh: () => undefined,
};
const sigmaLabels = labelGraph(renderer);
ok("sigma", sigmaLabels.result, 10);
sigmaLabels.remove();

// d3-force with smooth transitions (the graph of force.mjs): the simulation runs on d3's
// timer for a moment
const forceSvg = document.body.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "svg"));
const services = ["core", "api", "db", "cache", "auth", "web", "mobile", "admin", "queue", "worker",
  "search", "index", "metrics", "logs", "billing", "mail", "cdn", "dns"];
const calls = [["core", "api"], ["core", "db"], ["core", "cache"], ["core", "auth"], ["core", "queue"],
  ["api", "web"], ["api", "mobile"], ["api", "auth"], ["auth", "admin"], ["queue", "worker"],
  ["worker", "db"], ["db", "search"], ["search", "index"], ["cache", "metrics"], ["worker", "metrics"],
  ["core", "logs"], ["api", "logs"], ["billing", "core"], ["billing", "mail"], ["web", "cdn"], ["cdn", "dns"]];
const force = forceLabels(forceSvg, services.map((id) => ({ id })), calls.map(([source, target]) => ({ source, target })), 640, 420);
await new Promise((r) => setTimeout(r, 1500));
force.sim.stop();
ok("d3-force with LabelMotion", force.result(), 15);
assert.ok(force.result().stats.flicker, "warm-started");
assert.equal(forceSvg.querySelectorAll("text").length >= force.result().stats.placed, true, "force labels drawn");

// Web Worker (stand-in: the worker side runs serveEngine in this thread)
const workerListeners = { message: [], error: [] };
const scope = { onmessage: null, postMessage: (m) => setTimeout(() => workerListeners.message.forEach((f) => f({ data: m }))) };
serve(scope);
const worker = {
  postMessage: (m) => setTimeout(() => scope.onmessage({ data: m })),
  addEventListener: (type, f) => workerListeners[type].push(f),
  terminate: () => {},
};
const outliers = JSON.parse(readFileSync("outliers.json", "utf8")).items;
ok("worker", await solveInWorker(worker, { canvas: { width: 800, height: 600 }, items: outliers }), 18);
console.log("ok");
process.exit(0);   // the helpers keep timers for debounced re-solves
