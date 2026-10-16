// Observable Plot (docs/getting-started/javascript.md): a text mark whose labels avoid each
// other and every mark drawn before it. Checked by ../browser-checks.mjs.
// --8<-- [start:plot]
import * as Plot from "@observablehq/plot";
import { labelAnything } from "@label-anything/extras/plot";

export function chart(cars) {
  return Plot.plot({
    width: 480,
    height: 320,
    marks: [
      Plot.dot(cars, { x: "power", y: "economy", r: 3 }),
      labelAnything(cars, { x: "power", y: "economy", text: "name", r: 3, priority: (d) => d.power }),
    ],
  });
}
// --8<-- [end:plot]
