// @label-anything/wasm (docs/getting-started/javascript.md): the Rust core compiled to
// WebAssembly, with the API of @label-anything/core.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as core from "@label-anything/core";

// --8<-- [start:wasm]
import { init, place, features, VERSION } from "@label-anything/wasm";

await init();                // browsers: fetches label_anything_bg.wasm once; Node: optional
const problem = JSON.parse(readFileSync("outliers.json", "utf8"));
const result = place(problem, { readFile: (path) => readFileSync(path) });
console.log(VERSION, features(), result.stats.implementation, `${result.stats.placed}/${result.stats.total}`);
// --8<-- [end:wasm]
assert.equal(result.stats.hard_violations, 0);
assert.ok(result.stats.placed >= 18);
assert.doesNotMatch(result.stats.implementation, /^ts\//);   // the Rust core inside (reports "rust/…")

// --8<-- [start:switch]
const options = { readFile: (path) => readFileSync(path) };
const viaWasm = place(problem, options);        // the Rust core
const viaTs = core.place(problem, options);     // the TypeScript port
console.log(viaWasm.placements.every((p, i) => JSON.stringify(p.box) === JSON.stringify(viaTs.placements[i].box)));
// --8<-- [end:switch]
assert.ok(viaWasm.placements.every((p, i) => JSON.stringify(p.box) === JSON.stringify(viaTs.placements[i].box)), "same boxes");
console.log("ok");
