/**
 * @label-anything/core — pure TypeScript implementation of Label Anything.
 *
 * `place`, `validate` and `renderDebugSvg` follow the API in `api.ts`; the solver is a
 * line-by-line port of the Rust core (docs/dev/porting.md) and makes the same decisions
 * for the same iteration counts. `placeWith(env, problem)` solves with a custom
 * {@link Env} (clock, files, callbacks, SVG backend).
 */
export type {
  CandidateInfo,
  FontSpec,
  LabelAnythingApi,
  LabelProblem,
  LabelResult,
  Issue,
  PlaceOptions,
  PriorityValue,
  RgbaPixels,
  TextMetrics,
  ValidationReport,
} from "./api.js";
export { PlaceError } from "./api.js";
export { VERSION } from "./version.js";
export { place, validate, renderDebugSvg, type BudgetProfile } from "./place.js";
export { BasicEnv, BUILTIN_SVG, type Env, type Geom, type SvgBackend, type SvgDoc } from "./env.js";

import type { LabelResult } from "./api.js";
import type { Env } from "./env.js";
import { placeWith as placeWithImpl, type BudgetProfile } from "./place.js";

/**
 * Solve a problem (an object) with a custom environment. Throws `PlaceError` if the
 * problem is invalid. `profile: "rust"` uses the Rust core's per-implementation
 * constants (default time budget and moves per ms), for parity tests.
 */
export function placeWith(env: Env, problem: unknown, profile: BudgetProfile = "ts"): LabelResult {
  return placeWithImpl(problem, env, profile) as unknown as LabelResult;
}
