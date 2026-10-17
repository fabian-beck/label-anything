// Moving points (docs/tutorials/interactive-maps.md#smooth-transitions): the labels of a
// running d3-force layout, re-solved every 4th tick, warm-started, and drawn with smooth
// transitions; once the layout is at rest, a last solve with a lower stability weight.
// Checked by ../browser-checks.mjs.
// --8<-- [start:force-motion]
import { forceSimulation, forceLink, forceManyBody, forceCenter } from "d3-force";
import { place } from "@label-anything/core";
import { LabelMotion, renderLabels } from "@label-anything/extras";

export function forceLabels(svg, nodes, links, width, height) {
  const group = svg.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "g"));
  const font = { family: "Noto Sans, sans-serif", size: 12, weight: 400 };   // what the engine measured
  const motion = new LabelMotion({ duration: 300 });  // glide and fade in 300 ms
  const anchors = () => new Map(nodes.map((n) => [n.id, [n.x, n.y]]));
  let result, ticks = 0;
  const draw = () => {
    const frame = motion.frame(anchors());            // labels follow their nodes meanwhile
    renderLabels(group, frame.result, { font, opacity: frame.opacity, leaderOpacity: frame.leaderOpacity });
  };
  const solve = (stability = 1) => {
    result = place({
      canvas: { width, height },
      preset: "graph",
      items: nodes.map((n) => ({
        id: n.id,
        anchor: { type: "point", x: n.x, y: n.y, mark: { shape: "circle", r: 6 } },
        label: { type: "text", text: n.id },
      })),
      solver: { time_budget_ms: 10 },
      weights: { stability },
      warm_start: result,                             // the previous result: boxes move with their nodes
    });
    motion.target(result);                            // the labels move towards it
  };
  const settle = () => {
    solve(0.3);                                       // at rest: a few labels move to better places
    (function animate() {                             // let the last transitions finish
      draw();
      if (motion.moving) requestAnimationFrame(animate);
    })();
  };
  const sim = forceSimulation(nodes)
    .force("link", forceLink(links).id((d) => d.id).distance(50))
    .force("charge", forceManyBody().strength(-150))
    .force("center", forceCenter(width / 2, height / 2))
    .on("tick", () => {
      if (ticks++ % 4 === 0) solve();                 // re-solve every 4th tick
      draw();
    })
    .on("end", settle);
  return { sim, motion, settle, result: () => result };
}
// --8<-- [end:force-motion]
