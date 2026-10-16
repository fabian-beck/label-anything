// Label your outliers in five lines (docs/tutorials/outliers.md), in Node.js.
// Run in a copy of examples/tutorials/data: node ../js/outliers.mjs
// --8<-- [start:five]
import { readFileSync } from "node:fs";
import { place } from "@label-anything/core";

const rows = readFileSync("outliers.csv", "utf8").trim().split("\n").slice(1).map((line) => line.split(","));
const result = place({
  preset: "scatter",
  obstacles: { raster: { source: "scatter.png" } },
  items: rows.map(([, x, y, name]) => ({ anchor: { type: "point", x: +x, y: +y }, label: { type: "text", text: name } })),
}, { readFile: (path) => readFileSync(path) });
for (const p of result.placements) console.log(p.text?.lines, p.box, p.leader);
// --8<-- [end:five]

// --- checks (not shown in the docs) ---
const { stats } = result;
if (stats.hard_violations !== 0 || stats.leader_crossings !== 0 || stats.placed < 18) {
  throw new Error(`unexpected result: ${JSON.stringify(stats)}`);
}
console.log(`ok: placed ${stats.placed}/${stats.total}`);
