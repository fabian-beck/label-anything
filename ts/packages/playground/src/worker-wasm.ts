/**
 * Engine worker: the Rust core compiled to WebAssembly (`@label-anything/wasm`), answering
 * the requests of `createWorkerEngine` (`@label-anything/extras/worker`). Requests that
 * arrive while the module is still loading wait for it.
 */
import * as wasm from "@label-anything/wasm";
import { serveEngine } from "@label-anything/extras/worker";

type Scope = { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: unknown): void };
const self_ = globalThis as unknown as Scope;

const ready = wasm.init(new URL("label_anything_bg.wasm", self.location.href));
const inner: Scope = { onmessage: null, postMessage: (m) => self_.postMessage(m) };
serveEngine(wasm, { measure: null }, inner);

self_.onmessage = (e: MessageEvent) => {
  ready.then(
    () => inner.onmessage?.(e),
    (err: unknown) => {
      const id = (e.data as { id?: number } | null)?.id ?? 0;
      self_.postMessage({ id, error: { message: `the WebAssembly module did not load: ${String((err as Error)?.message ?? err)}` } });
    },
  );
};
