// Moving points (docs/tutorials/interactive-maps.md#moving-points): label a d3-force
// layout while it runs, re-solving every few ticks warm-started from the previous result,
// and measure how much the labels move compared with solving every frame from scratch.
import assert from "node:assert/strict";

// --8<-- [start:force]
import { forceSimulation, forceLink, forceManyBody, forceCenter } from "d3-force";
import { place } from "@label-anything/core";

const names = ["core", "api", "db", "cache", "auth", "web", "mobile", "admin", "queue", "worker",
  "search", "index", "metrics", "logs", "billing", "mail", "cdn", "dns"];
const edges = [["core", "api"], ["core", "db"], ["core", "cache"], ["core", "auth"], ["core", "queue"],
  ["api", "web"], ["api", "mobile"], ["api", "auth"], ["auth", "admin"], ["queue", "worker"],
  ["worker", "db"], ["db", "search"], ["search", "index"], ["cache", "metrics"], ["worker", "metrics"],
  ["core", "logs"], ["api", "logs"], ["billing", "core"], ["billing", "mail"], ["web", "cdn"], ["cdn", "dns"]];
const nodes = names.map((id) => ({ id }));
const links = edges.map(([source, target]) => ({ source, target }));
const W = 640, H = 420;

function problem(warm) {
  return {
    canvas: { width: W, height: H },
    preset: "graph",
    items: nodes.map((n) => ({
      id: n.id,
      anchor: { type: "point", x: n.x, y: n.y, mark: { shape: "circle", r: 6 } },
      label: { type: "text", text: n.id },
    })),
    // the edges as soft obstacles of class `lines` (the graph preset's)
    obstacles: { vector: [{ class: "lines", width: 1, polylines: links.map((l) => [[l.source.x, l.source.y], [l.target.x, l.target.y]]) }] },
    solver: { time_budget_ms: 10 },     // for animation: a short budget
    warm_start: warm,                    // the previous result: each box moves with its node
  };
}

const sim = forceSimulation(nodes)
  .force("link", forceLink(links).id((d) => d.id).distance(50))
  .force("charge", forceManyBody().strength(-150))
  .force("center", forceCenter(W / 2, H / 2))
  .stop();                               // ticked by hand here; in a page: sim.on("tick", ...)

const frames = [];
let result = null;
for (let tick = 0; tick < 120; tick++) {
  sim.tick();
  if (tick % 4 === 0) {                  // re-solve every 4th tick; in between labels follow their nodes
    result = place(problem(result ?? undefined));
    frames.push({ pos: new Map(nodes.map((n) => [n.id, [n.x, n.y]])), result });
  }
}
// --8<-- [end:force]

// the same frames solved from scratch
const cold = frames.map((f) => {
  for (const n of nodes) [n.x, n.y] = f.pos.get(n.id);
  return { pos: f.pos, result: place(problem(undefined)) };
});

/** Mean change of the label offsets (box center − node) between consecutive frames, px. */
function movement(fs) {
  const d = [];
  for (let k = 1; k < fs.length; k++) {
    const off = (f) => new Map(f.result.placements.filter((p) => p.placed).map((p) => {
      const [x, y] = f.pos.get(p.id);
      return [p.id, [p.box.x + p.box.w / 2 - x, p.box.y + p.box.h / 2 - y]];
    }));
    const a = off(fs[k - 1]), b = off(fs[k]);
    for (const [id, [ax, ay]] of a) if (b.has(id)) d.push(Math.hypot(b.get(id)[0] - ax, b.get(id)[1] - ay));
  }
  return d.reduce((s, x) => s + x, 0) / d.length;
}
const warmMove = movement(frames), coldMove = movement(cold);
console.log(`${frames.length} frames; labels move ${warmMove.toFixed(1)} px per frame warm-started, ${coldMove.toFixed(1)} px from scratch`);
assert.ok(warmMove < coldMove, `${warmMove} < ${coldMove}`);
assert.ok(frames.every((f) => f.result.stats.hard_violations === 0));
assert.ok(frames.slice(1).every((f) => f.result.stats.flicker !== undefined));
assert.ok(frames.every((f) => f.result.placements.every((p) => !p.placed || p.anchor !== undefined)));
console.log("ok");
