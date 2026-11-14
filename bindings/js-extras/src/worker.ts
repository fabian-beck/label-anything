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
 * Problems, results and raster pixels are copied: the caller keeps its pixels and can
 * solve with them again. Text is measured in the worker (with `OffscreenCanvas` where
 * available), so a `measure` passed to `place` is ignored; `priority` and `cost` callbacks
 * cannot cross the thread boundary. Aborting a solve returns the best result so far when
 * the page is cross-origin isolated (`SharedArrayBuffer`); otherwise the worker is
 * restarted and the promise rejects. A worker that fails (a script that does not load, an
 * uncaught error) rejects the pending solves; the engine then starts a new one if it was
 * given a factory, and rejects every later solve if it was given a worker.
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
  addEventListener(type: "messageerror", listener: (e: MessageEvent) => void): void;
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
  const pending = new Map<number, { resolve(r: LabelResult): void; reject(e: unknown): void; progress?: PlaceOptions["progress"]; settled(): void }>();
  /** Why the worker is gone, when it cannot be replaced. */
  let gone: Error | undefined;

  const failAll = (error: unknown) => {
    const all = [...pending.values()];
    pending.clear();
    for (const p of all) {
      p.settled();
      p.reject(error);
    }
  };
  const connect = (): WorkerLike => {
    if (w) return w;
    if (!factory) throw gone ?? new Error("createWorkerEngine: the worker was terminated");
    w = attach(factory());
    return w;
  };
  /** The worker failed: nothing it was asked will be answered, and it is not asked again. */
  const failed = (target: WorkerLike, error: Error) => {
    if (w !== target) return; // a worker replaced after an abort
    w = undefined;
    if (!factory) gone = error;
    try {
      target.terminate();
    } catch {
      // already dead
    }
    failAll(error);
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
      p.settled();
      if ("result" in msg) p.resolve(msg.result);
      else p.reject(msg.error.errors ? new PlaceError(msg.error.errors) : new Error(msg.error.message));
    });
    target.addEventListener("error", (e: ErrorEvent) => failed(target, new Error(`label worker failed: ${e.message}`)));
    target.addEventListener("messageerror", () => failed(target, new Error("label worker failed: a message could not be read")));
    return target;
  }

  return {
    place(problem, options = {}) {
      if (options.priority || options.cost) {
        return Promise.reject(new TypeError("createWorkerEngine: priority and cost callbacks cannot be sent to a worker"));
      }
      // an AbortSignal tells when it aborts; of another object only `aborted` is known, now
      const signal = options.signal as ({ readonly aborted: boolean } & Partial<Pick<AbortSignal, "addEventListener" | "removeEventListener">>) | undefined;
      const shared = typeof SharedArrayBuffer === "function" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== false;
      const abort = shared && signal ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
      if (signal?.aborted) {
        // with shared memory the worker returns the cancelled result, as the engine does;
        // without, an aborted solve rejects, and this one need not start
        if (abort) Atomics.store(abort, 0, 1);
        else return Promise.reject(new DOMException("The solve was aborted", "AbortError"));
      }
      let target: WorkerLike;
      try {
        target = connect();
      } catch (error) {
        return Promise.reject(error);
      }
      const id = next++;
      return new Promise<LabelResult>((resolve, reject) => {
        const onAbort = () => {
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
        };
        const settled = () => signal?.removeEventListener?.("abort", onAbort);
        pending.set(id, { resolve, reject, progress: options.progress, settled });
        const request: Request = { id, problem, raster: options.raster, abort, progress: !!options.progress };
        try {
          target.postMessage(request);
        } catch (error) {
          pending.delete(id);
          reject(error); // e.g. a problem that cannot be cloned
          return;
        }
        signal?.addEventListener?.("abort", onAbort, { once: true });
      });
    },
    terminate() {
      w?.terminate();
      w = undefined;
      gone = undefined;
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
