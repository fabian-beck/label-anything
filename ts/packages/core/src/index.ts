/**
 * @label-anything/core — pure TypeScript implementation of Label Anything.
 *
 * The solver entry points (`place`, `validate`, `renderDebugSvg`) follow the API in
 * `api.ts`; they are added as the port of the Rust core lands (docs/dev/porting.md).
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
