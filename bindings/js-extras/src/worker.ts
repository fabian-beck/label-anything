/**
 * Solve in a Web Worker so the page stays responsive.
 *
 * ```js
 * // label-worker.js
 * import * as core from "@label-anything/core";        // or @label-anything/wasm
 * import { serveEngine } from "@label-anything/extras/worker";
 * serveEngine(core);
 *
 * // page
 * import { createWorkerEngine } from "@label-anything/extras/worker";
 * const engine = createWorkerEngine(new Worker(new URL("./label-worker.js", import.meta.url), { type: "module" }));
 * const result = await engine.place(problem);
 * labelMapLibre(map, data, { engine, ... });             // every helper accepts it
 * ```
 *
 * Problems and results are copied; raster pixels are transferred. Text is measured in the
 * worker (with `OffscreenCanvas` where available), so a `measure` passed to `place` is
 * ignored; `priority` and `cost` callbacks cannot cross the thread boundary. Aborting a
 * solve returns the best result so far when the page is cross-origin isolated
 * (`SharedArrayBuffer`); otherwise the worker is restarted and the promise rejects.
 */
import { PlaceError, type Issue, type LabelProblem, type LabelResult, type PlaceOptions } from "@label-anything/core";
import type { AsyncEngine, Engine } from "./engine.js";
import { canvasMeasure, type MeasureFn } from "./measure.js";

interface Request {
  id: number;
  problem: LabelProblem | string;
  raster?: PlaceOptions["raster"];
  /** Int32Array over a SharedArrayBuffer: [0] = 1 when aborted. */
  abort?: Int32Array;
  progress?: boolean;
}

type Response =
  | { id: number; result: LabelResult }
  | { id: number; error: { message: string; errors?: Issue[] } }
  | { id: number; progress: [string, number] };

interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
  addEventListener(type: "error", listener: (e: ErrorEvent) => void): void;
  terminate(): void;
}

export interface WorkerEngine extends AsyncEngine {
  /** Stops the worker; pending solves reject. */
  terminate(): void;
}

/**
 * An asynchronous engine backed by a worker that runs {@link serveEngine}. Pass a worker,
 * or a factory (needed to restart it after an abort without `SharedArrayBuffer`).
 */
export function createWorkerEngine(worker: WorkerLike | (() => WorkerLike)): WorkerEngine {
  const factory = typeof worker === "function" ? worker : undefined;
  let w: WorkerLike | undefined = typeof worker === "function" ? undefined : worker;
  let next = 1;
  const pending = new Map<number, { resolve(r: LabelResult): void; reject(e: unknown): void; progress?: PlaceOptions["progress"] }>();

  const failAll = (error: unknown) => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  const connect = (): WorkerLike => {
    if (w) return w;
    if (!factory) throw new Error("createWorkerEngine: the worker was terminated");
    w = attach(factory());
    return w;
  };
  if (w) attach(w);

  function attach(target: WorkerLike): WorkerLike {
    target.addEventListener("message", (e: MessageEvent) => {
      const msg = e.data as Response;
      const p = pending.get(msg.id);
      if (!p) return;
      if ("progress" in msg) {
        p.progress?.(msg.progress[0], msg.progress[1]);
        return;
      }
      pending.delete(msg.id);
      if ("result" in msg) p.resolve(msg.result);
      else p.reject(msg.error.errors ? new PlaceError(msg.error.errors) : new Error(msg.error.message));
    });
    target.addEventListener("error", (e: ErrorEvent) => failAll(new Error(`label worker failed: ${e.message}`)));
    return target;
  }

  return {
    place(problem, options = {}) {
      if (options.priority || options.cost) {
        return Promise.reject(new TypeError("createWorkerEngine: priority and cost callbacks cannot be sent to a worker"));
      }
      const target = connect();
      const id = next++;
      const shared = typeof SharedArrayBuffer === "function" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== false;
      const abort = shared && options.signal ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
      return new Promise<LabelResult>((resolve, reject) => {
        pending.set(id, { resolve, reject, progress: options.progress });
        const request: Request = { id, problem, raster: options.raster, abort, progress: !!options.progress };
        const transfer = options.raster ? [options.raster.data.buffer as ArrayBuffer] : [];
        target.postMessage(request, transfer);
        options.signal?.addEventListener(
          "abort",
          () => {
            if (!pending.has(id)) return;
            if (abort) {
              Atomics.store(abort, 0, 1);
            } else if (factory) {
              // no shared memory: restart the worker; this solve (and any queued) is lost
              const old = w;
              w = undefined;
              old?.terminate();
              failAll(new DOMException("The solve was aborted", "AbortError"));
            }
          },
          { once: true },
        );
      });
    },
    terminate() {
      w?.terminate();
      w = undefined;
      failAll(new Error("label worker terminated"));
    },
  };
}

export interface ServeOptions {
  /** Text measurement in the worker (default: `OffscreenCanvas` where available). */
  measure?: MeasureFn | null;
}

/** Answers {@link createWorkerEngine} requests in a worker. */
export function serveEngine(engine: Engine, options: ServeOptions = {}, scope: { onmessage: unknown; postMessage(m: unknown): void } = globalThis as never): void {
  const measure = options.measure === undefined ? canvasMeasure() : (options.measure ?? undefined);
  scope.onmessage = (e: MessageEvent<Request>) => {
    const { id, problem, raster, abort, progress } = e.data;
    const signal = abort ? ({ get aborted() { return Atomics.load(abort, 0) === 1; } } as unknown as AbortSignal) : undefined;
    try {
      const result = engine.place(problem, {
        ...(measure ? { measure } : {}),
        ...(raster ? { raster } : {}),
        ...(signal ? { signal } : {}),
        ...(progress ? { progress: (phase: string, fraction: number) => scope.postMessage({ id, progress: [phase, fraction] }) } : {}),
      });
      scope.postMessage({ id, result });
    } catch (err) {
      const errors = (err as { errors?: Issue[] }).errors;
      scope.postMessage({ id, error: { message: String((err as Error)?.message ?? err), ...(errors ? { errors } : {}) } });
    }
  };
}
