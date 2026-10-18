/**
 * The explainer's engine worker: the TypeScript core solving with a trace
 * (`placeTraced`), without a clock and with the Rust core's budgets, so every solve is
 * deterministic and gives the placements of the Rust core (and of the WebAssembly engine).
 */
import { BasicEnv, PlaceError, placeTraced, type LabelProblem } from "@label-anything/core";

interface Request {
  id: number;
  problem: LabelProblem;
}

self.onmessage = (ev: MessageEvent<Request>) => {
  const { id, problem } = ev.data;
  try {
    const t0 = performance.now();
    const { result, trace } = placeTraced(new BasicEnv(), problem, "rust");
    self.postMessage({ id, ok: true, result, trace, ms: performance.now() - t0 });
  } catch (e) {
    const message = e instanceof PlaceError ? e.errors.map((x) => `${x.pointer || "/"}: ${x.message}`).join("\n") : e instanceof Error ? e.message : String(e);
    self.postMessage({ id, ok: false, error: message });
  }
};
