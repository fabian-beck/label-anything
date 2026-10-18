/**
 * @label-anything/wasm — the Rust core of Label Anything compiled to WebAssembly, with
 * the API of `@label-anything/core` (`LabelAnythingApi`).
 *
 * This is the entry for browsers and bundlers: instantiate the module once with
 * `await init()` (fetches `label_anything_bg.wasm` next to the glue) or
 * `initSync(bytes | module)` before calling `place`, `validate` or `renderDebugSvg`.
 * In Node, the `node` export condition selects `node.ts`, which initializes itself.
 */
import type { Issue, LabelAnythingApi, PlaceError as CorePlaceError } from "@label-anything/core";
import { initAsync, place, renderDebugSvg, validate, VERSION } from "./api.js";
import type { PlaceError } from "./place-error.js";
import type { InitInput } from "./raw.js";

export type {
  Anchor,
  Box,
  CandidateInfo,
  FontSpec,
  Issue,
  Label,
  LabelAnythingApi,
  LabelItem,
  LabelPlacement,
  LabelProblem,
  LabelResult,
  Leader,
  PlaceOptions,
  PriorityValue,
  RgbaPixels,
  Stats,
  TextMetrics,
  ValidationReport,
} from "@label-anything/core";
export type { InitInput } from "./raw.js";
export { PlaceError } from "./place-error.js";
export { features, initSync, isInitialized, place, renderDebugSvg, validate, VERSION } from "./api.js";

/**
 * Instantiate the WebAssembly module (once; later calls return at once). Without an
 * argument, `label_anything_bg.wasm` is fetched next to the glue with
 * `WebAssembly.instantiateStreaming`; pass a URL, a `Response`, the bytes or a compiled
 * `WebAssembly.Module` to load it from elsewhere.
 */
export function init(input?: InitInput | Promise<InitInput>): Promise<void> {
  return initAsync(input);
}

// Compile-time checks: the same API as @label-anything/core, and a PlaceError of the same shape.
type Implements<T extends LabelAnythingApi> = T;
type _Api = Implements<{
  place: typeof place;
  validate: typeof validate;
  renderDebugSvg: typeof renderDebugSvg;
  VERSION: typeof VERSION;
}>;
type Assignable<A, B extends A> = B;
type _PlaceErrorShape = [
  Assignable<CorePlaceError, PlaceError>,
  Assignable<PlaceError, CorePlaceError>,
  Assignable<new (errors: Issue[]) => CorePlaceError, typeof PlaceError>,
];
