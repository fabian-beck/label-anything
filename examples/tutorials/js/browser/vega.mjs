// Vega (docs/getting-started/javascript.md): the labelAnything transform, a drop-in
// alternative to Vega's label transform. Checked by ../browser-checks.mjs.
// --8<-- [start:register]
import * as vega from "vega";
import { registerVegaTransform } from "@label-anything/extras/vega";

registerVegaTransform(vega);     // once, before parsing specs that use it
// --8<-- [end:register]

export const spec = {
  width: 480,
  height: 320,
  data: [{ name: "cities", values: [] }],
  scales: [
    { name: "x", domain: { data: "cities", field: "x" }, range: "width" },
    { name: "y", domain: { data: "cities", field: "y" }, range: "height" },
  ],
  marks: [
    { name: "trend", type: "rule", encode: { enter: { x: { value: 0 }, y: { value: 300 }, x2: { value: 480 }, y2: { value: 20 } } } },
    {
      name: "points", type: "symbol", from: { data: "cities" },
      encode: { enter: { x: { scale: "x", field: "x" }, y: { scale: "y", field: "y" }, size: { value: 30 } } },
    },
    // --8<-- [start:mark]
    {
      type: "text",
      from: { data: "points" },
      encode: { enter: { text: { field: "datum.name" }, fontSize: { value: 11 } } },
      transform: [{
        type: "labelAnything",
        size: { signal: "[width, height]" },
        avoidMarks: ["trend"],                    // marks to avoid besides the labeled points
        priority: "datum.datum.population",
      }],
    },
    // --8<-- [end:mark]
  ],
};

export async function render(cities) {
  const view = new vega.View(vega.parse({ ...spec, data: [{ name: "cities", values: cities }] }), { renderer: "none" });
  await view.runAsync();
  return view;
}
