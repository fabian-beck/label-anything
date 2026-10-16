// sigma.js v2/v3 (docs/tutorials/node-link.md): replaces sigma's label renderer. Checked by
// ../browser-checks.mjs (with a stand-in renderer: sigma needs WebGL).
// --8<-- [start:sigma]
import { labelSigma } from "@label-anything/extras/sigma";

// renderer: new Sigma(graph, container); re-solves after camera moves (debounced)
export function labelGraph(renderer) {
  return labelSigma(renderer, {
    priority: (key, attrs) => attrs.size,  // larger nodes first
    debounce: 120,
  });
}
// --8<-- [end:sigma]
