/**
 * Engine worker: the TypeScript core (`@label-anything/core`), answering the requests of
 * `createWorkerEngine` (`@label-anything/extras/worker`).
 *
 * The playground's budgets are the Rust core's (100 search moves per ms). The TypeScript
 * engine makes 40 moves per ms of its budget, so the budget is multiplied by 2.5 here: both
 * engines run the same number of moves and give identical layouts — as the defaults do
 * (100 ms in Rust, 250 ms in TypeScript, 10,000 moves each) — and the TypeScript engine's
 * wall-clock guard (3 × its budget) leaves it the time it needs. Text is measured with the
 * bundled Noto Sans in both (no host measurement), the font the playground draws with.
 */
import { place, type LabelProblem, type PlaceOptions } from "@label-anything/core";
import { serveEngine } from "@label-anything/extras/worker";

const TS_PER_RUST = 2.5;

const engine = {
  place(problem: LabelProblem | string, options: PlaceOptions = {}) {
    const p = (typeof problem === "string" ? JSON.parse(problem) : problem) as LabelProblem;
    const budget = p.solver?.time_budget_ms;
    const scaled = typeof budget === "number" ? { ...p, solver: { ...p.solver, time_budget_ms: budget * TS_PER_RUST } } : p;
    return place(scaled, options);
  },
};

serveEngine(engine, { measure: null });
