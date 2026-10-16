// Solving in a Web Worker (docs/getting-started/javascript.md). Checked by
// ../browser-checks.mjs (with a stand-in worker).
import * as core from "@label-anything/core";

// --8<-- [start:worker]
// label-worker.js, started with new Worker(new URL("./label-worker.js", import.meta.url), { type: "module" })
import { serveEngine } from "@label-anything/extras/worker";
export const serve = (scope) => serveEngine(core, {}, scope);   // in the worker: serveEngine(core)
// --8<-- [end:worker]

// --8<-- [start:page]
import { createWorkerEngine } from "@label-anything/extras/worker";

export async function solveInWorker(worker, problem) {
  const engine = createWorkerEngine(worker);   // every helper accepts it as { engine }
  return engine.place(problem);                // a promise; the page stays responsive
}
// --8<-- [end:page]
