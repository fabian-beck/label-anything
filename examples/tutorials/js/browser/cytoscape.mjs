// Cytoscape.js (docs/tutorials/node-link.md): Cytoscape keeps drawing its node labels;
// Label Anything decides where. Checked by ../browser-checks.mjs (headless Cytoscape).
// --8<-- [start:cytoscape]
import { labelCytoscape } from "@label-anything/extras/cytoscape";

// cy: a cytoscape instance; re-solves after layouts, drags and graph changes
export function labelNodes(cy) {
  return labelCytoscape(cy, {
    priority: (node) => node.degree(),     // hubs first
    avoidEdges: true,                      // edges are soft obstacles (class "edges")
  });
}
// --8<-- [end:cytoscape]
