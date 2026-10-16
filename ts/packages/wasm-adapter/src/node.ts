/**
 * Node entry of @label-anything/wasm, selected by the `node` export condition. Same API
 * as the browser entry (`index.ts`), but `place`, `validate`, `renderDebugSvg` and
 * `features` instantiate the module synchronously from the bundled
 * `label_anything_bg.wasm` on first use, so `init()` is optional.
 */
import { readFileSync } from "node:fs";
import type { LabelProblem, LabelResult, PlaceOptions, ValidationReport } from "@label-anything/core";
import * as api from "./api.js";
import type { InitInput } from "./raw.js";

export type {
  CandidateInfo,
  FontSpec,
  Issue,
  LabelAnythingApi,
  LabelProblem,
  LabelResult,
  PlaceOptions,
  PriorityValue,
  RgbaPixels,
  TextMetrics,
  ValidationReport,
} from "@label-anything/core";
export type { InitInput } from "./raw.js";
export { PlaceError } from "./place-error.js";
export { initSync, isInitialized, VERSION } from "./api.js";

const WASM_FILE = new URL("../wasm/label_anything_bg.wasm", import.meta.url);

function ensure(): void {
  if (!api.isInitialized()) api.initSync(readFileSync(WASM_FILE));
}

/** Solve a problem (an object or JSON text). Throws `PlaceError` if it is invalid. */
export function place(problem: LabelProblem | string, options?: PlaceOptions): LabelResult {
  ensure();
  return api.place(problem, options);
}

/** Validate a problem (an object or JSON text) against the schema and the semantic rules. */
export function validate(problem: unknown): ValidationReport {
  ensure();
  return api.validate(problem);
}

/** Debug SVG overlay of a problem and a result. */
export function renderDebugSvg(problem: LabelProblem | string, result: LabelResult): string {
  ensure();
  return api.renderDebugSvg(problem, result);
}

/** Optional parts compiled into the WebAssembly module (`shaping`, `decode`, `svg`). */
export function features(): string[] {
  ensure();
  return api.features();
}

/**
 * Instantiate the module. Optional in Node: without an argument (or with a file path or
 * `file:` URL) the file is read synchronously; other inputs go to the browser loader.
 */
export async function init(input?: InitInput | Promise<InitInput>): Promise<void> {
  if (api.isInitialized()) return;
  const v = await input;
  if (v === undefined) return ensure();
  const file = localFile(v);
  if (file !== undefined) return api.initSync(readFileSync(file));
  return api.initAsync(v);
}

/** A file path or `file:` URL (read with fs); other URLs are fetched. */
function localFile(v: InitInput): string | URL | undefined {
  if (v instanceof URL) return v.protocol === "file:" ? v : undefined;
  if (typeof v !== "string") return undefined;
  if (v.startsWith("file:")) return new URL(v);
  return /^[a-z][a-z0-9+.-]+:\/\//i.test(v) ? undefined : v;
}
