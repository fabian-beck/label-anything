/**
 * @label-anything/wasm — the Rust core of Label Anything compiled to WebAssembly, with
 * the API of `@label-anything/core` (`LabelAnythingApi`).
 *
 * This is the entry for browsers and bundlers: instantiate the module once with
 * `await init()` (fetches `label_anything_bg.wasm` next to the glue) or
 * `initSync(bytes | module)` before calling `place`, `validate` or `renderDebugSvg`.
 * In Node, the `node` export condition selects `node.ts`, which initializes itself.
 */
import { initAsync } from "./api.js";
import type { InitInput } from "./raw.js";

export type * from "./types.js";
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
