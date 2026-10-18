/**
 * @label-anything/core — pure TypeScript implementation of Label Anything.
 *
 * `place`, `validate` and `renderDebugSvg` follow the API in `api.ts`; the solver is a
 * line-by-line port of the Rust core (docs/dev/porting.md) and makes the same decisions
 * for the same iteration counts. `placeWith(env, problem)` solves with a custom
 * {@link Env} (clock, files, callbacks, SVG backend).
 */
export type {
  Anchor,
  Box,
  CandidateInfo,
  FontSpec,
  Label,
  LabelAnythingApi,
  LabelItem,
  LabelPlacement,
  LabelProblem,
  LabelResult,
  Leader,
  Issue,
  PlaceOptions,
  PriorityValue,
  RgbaPixels,
  Stats,
  TextMetrics,
  ValidationReport,
} from "./api.js";
export { PlaceError } from "./api.js";
export { VERSION } from "./version.js";
export { place, validate, renderDebugSvg, type BudgetProfile } from "./place.js";
export { BasicEnv, BUILTIN_SVG, type Env, type Geom, type SvgBackend, type SvgDoc } from "./env.js";
export type {
  SolveTrace,
  TraceCandidate,
  TraceChange,
  TraceEvent,
  TraceFate,
  TraceIdle,
  TraceItem,
  TraceMoveKind,
  TraceOutcome,
  TracePhase,
  TraceVariant,
} from "./trace.js";

import type { LabelResult, ValidationReport } from "./api.js";
import type { Env } from "./env.js";
import { PlaceError } from "./api.js";
import { placeReported, placeTracedWith, placeWith as placeWithImpl, type BudgetProfile } from "./place.js";
import type { SolveTrace } from "./trace.js";
import { Issue } from "./validate.js";

/**
 * Solve a problem (an object) with a custom environment. Throws `PlaceError` if the
 * problem is invalid. `profile: "rust"` uses the Rust core's per-implementation
 * constants (default time budget and moves per ms), for parity tests.
 */
export function placeWith(env: Env, problem: unknown, profile: BudgetProfile = "ts"): LabelResult {
  return placeWithImpl(problem, env, profile) as unknown as LabelResult;
}

/**
 * Solve a problem and record what the solver decided, step by step (ADR 0046; TypeScript
 * only): candidate generation, the greedy pass, every local-search move and the passes
 * after the search, each event with the placement changes it made. The result is the one
 * {@link placeWith} gives: tracing never changes a decision. Throws `PlaceError` if the
 * problem is invalid.
 */
export function placeTraced(env: Env, problem: unknown, profile: BudgetProfile = "ts"): { result: LabelResult; trace: SolveTrace } {
  const { result, trace } = placeTracedWith(problem, env, profile);
  return { result: result as unknown as LabelResult, trace };
}

/**
 * Solve a problem whose validation report (from {@link validate}) is already known; its
 * warnings are passed through to the result. Throws `PlaceError` if the report is not
 * valid or the problem cannot be prepared.
 */
export function placeValidated(env: Env, problem: unknown, report: ValidationReport, profile: BudgetProfile = "ts"): LabelResult {
  if (!report.valid) throw new PlaceError(report.errors);
  const warnings = report.warnings.map((w) => new Issue(w.pointer ?? "", w.code, w.message));
  return placeReported(problem, env, warnings, profile) as unknown as LabelResult;
}
