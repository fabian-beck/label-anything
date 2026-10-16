// d3 (docs/getting-started/javascript.md): label the dots of a scatterplot; the title and
// everything else drawn in the <svg> are obstacles. Checked by ../browser-checks.mjs.
// --8<-- [start:d3]
import { select } from "d3-selection";
import { labelSelection } from "@label-anything/extras/d3";

export function scatterplot(container, cities) {
  const svg = select(container).append("svg").attr("width", 480).attr("height", 320);
  svg.append("text").attr("x", 12).attr("y", 24).text("Cities of the region");
  const dots = svg.append("g").selectAll("circle").data(cities).join("circle")
    .attr("cx", (d) => d.x).attr("cy", (d) => d.y).attr("r", 3);
  return labelSelection(dots, (d) => d.name, {
    priority: (d) => d.population,     // the larger city wins when space runs out
    preset: "scatter",
    leaders: "straight",               // distant labels with leaders when crowded
  });
}
// --8<-- [end:d3]
