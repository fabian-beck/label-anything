/**
 * The solver behind the helpers. Any object with the `place` function of
 * `@label-anything/core` or `@label-anything/wasm` works; `createWorkerEngine` (from
 * `@label-anything/extras/worker`) gives an asynchronous one that runs in a Web Worker.
 */
import * as core from "@label-anything/core";
import type { LabelProblem, LabelResult, PlaceOptions } from "@label-anything/core";

/** A synchronous engine: `@label-anything/core` or `@label-anything/wasm`. */
export interface Engine {
  place(problem: LabelProblem | string, options?: PlaceOptions): LabelResult;
}

/** An engine that answers asynchronously (e.g. in a Web Worker). */
export interface AsyncEngine {
  place(problem: LabelProblem | string, options?: PlaceOptions): Promise<LabelResult>;
}

export type AnyEngine = Engine | AsyncEngine;

let defaultEngine: AnyEngine | undefined;

/** Sets the engine used when a helper is not given one (`undefined` restores the built-in). */
export function setDefaultEngine(engine: AnyEngine | undefined): void {
  defaultEngine = engine;
}

/** The engine to use: the given one, else the default, else `@label-anything/core`. */
export function resolveEngine(engine?: AnyEngine): AnyEngine {
  const builtin = core as unknown as Partial<Engine>;
  const e = engine ?? defaultEngine ?? (typeof builtin.place === "function" ? (builtin as Engine) : undefined);
  if (!e) {
    throw new Error(
      "@label-anything/extras: no engine available. Pass { engine } (e.g. the @label-anything/wasm module) or call setDefaultEngine().",
    );
  }
  return e;
}

export function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

/** Applies `f` to a value, synchronously unless the value is a promise. */
export function andThen<T, U>(value: T | Promise<T>, f: (v: T) => U): U | Promise<U> {
  return isPromiseLike(value) ? Promise.resolve(value).then(f) : f(value);
}

/**
 * Runs solves so that only the latest one counts: starting a new solve aborts the previous
 * one (an aborted engine returns its best result so far, which is then discarded).
 */
export class LatestRunner {
  #seq = 0;
  #controller: AbortController | undefined;

  constructor(readonly engine: AnyEngine) {}

  /** True while an asynchronous solve is running. */
  get busy(): boolean {
    return this.#controller !== undefined;
  }

  run(
    problem: LabelProblem,
    options: PlaceOptions,
    onResult: (result: LabelResult) => void,
    onError: (error: unknown) => void,
  ): void {
    const seq = ++this.#seq;
    this.#controller?.abort();
    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    this.#controller = controller;
    const signal = combineSignals(options.signal, controller?.signal);
    let out: LabelResult | Promise<LabelResult>;
    try {
      out = this.engine.place(problem, signal ? { ...options, signal } : options);
    } catch (e) {
      this.#done(seq);
      onError(e);
      return;
    }
    if (!isPromiseLike(out)) {
      this.#done(seq);
      onResult(out);
      return;
    }
    out.then(
      (r) => {
        if (seq !== this.#seq) return;
        this.#done(seq);
        onResult(r);
      },
      (e) => {
        if (seq !== this.#seq) return;
        this.#done(seq);
        onError(e);
      },
    );
  }

  /** Aborts the running solve, if any, and drops its result. */
  cancel(): void {
    this.#seq++;
    this.#controller?.abort();
    this.#controller = undefined;
  }

  #done(seq: number): void {
    if (seq === this.#seq) this.#controller = undefined;
  }
}

function combineSignals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  if (!a || !b) return a ?? b;
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  return any ? any([a, b]) : a;
}
