import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaceError, type LabelResult, type PlaceOptions } from "@label-anything/core";
import type { Engine } from "../src/engine.js";
import { createWorkerEngine, serveEngine } from "../src/worker.js";
import { fakeEngine } from "./engines.js";

/** An in-process stand-in for a Worker running `serveEngine(engine)`. */
function fakeWorker(engine: Engine) {
  const listeners: Record<string, ((e: { data?: unknown; message?: string }) => void)[]> = { message: [], error: [] };
  const scope = {
    onmessage: null as null | ((e: { data: unknown }) => void),
    postMessage: (m: unknown) => setTimeout(() => listeners.message!.forEach((f) => f({ data: m }))),
  };
  serveEngine(engine, { measure: null }, scope);
  return {
    postMessage: (m: unknown) => setTimeout(() => scope.onmessage!({ data: m })),
    addEventListener: (type: string, f: (e: never) => void) => listeners[type]!.push(f as never),
    terminate: vi.fn(),
  };
}

const problem = { canvas: { width: 100, height: 100 }, items: [{ id: "a", anchor: { type: "point" as const, x: 10, y: 10 }, label: { type: "text" as const, text: "A" } }] };

describe("worker engine", () => {
  afterEach(() => {
    delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  });

  it("solves in the worker; measure is the worker's own", async () => {
    const fake = fakeEngine();
    const engine = createWorkerEngine(fakeWorker(fake) as never);
    const phases: string[] = [];
    const result = await engine.place(problem, { measure: () => ({ width: 1, ascent: 1, descent: 1 }), progress: (p) => phases.push(p) });
    expect(result.placements[0]).toMatchObject({ id: "a", placed: true });
    expect(fake.last.options.measure).toBeUndefined();
    expect(fake.last.problem).toEqual(problem);
    expect(phases).toEqual([]);
  });

  it("forwards progress and rebuilds PlaceError", async () => {
    const failing: Engine = {
      place(_p, o: PlaceOptions = {}) {
        o.progress?.("greedy", 0.5);
        throw new PlaceError([{ pointer: "/items/0", code: "required", message: "missing" }]);
      },
    };
    const engine = createWorkerEngine(fakeWorker(failing) as never);
    const phases: [string, number][] = [];
    const err = await engine.place(problem, { progress: (p, f) => phases.push([p, f]) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaceError);
    expect((err as PlaceError).errors[0]!.code).toBe("required");
    expect(phases).toEqual([["greedy", 0.5]]);
  });

  it("rejects callbacks that cannot cross threads", async () => {
    const engine = createWorkerEngine(fakeWorker(fakeEngine()) as never);
    await expect(engine.place(problem, { priority: () => 1 })).rejects.toThrow(TypeError);
  });

  it("aborts through shared memory and still returns a result", async () => {
    let sawAbort = false;
    const engine = createWorkerEngine(
      fakeWorker({
        place(p, o: PlaceOptions = {}) {
          sawAbort = !!o.signal?.aborted;
          return fakeEngine().place(p, o);
        },
      }) as never,
    );
    const controller = new AbortController();
    const pending = engine.place(problem, { signal: controller.signal });
    controller.abort();
    const result: LabelResult = await pending;
    expect(sawAbort).toBe(true);
    expect(result.placements.length).toBe(1);
  });

  it("restarts the worker on abort without shared memory", async () => {
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = false;
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const engine = createWorkerEngine(() => {
      const w = fakeWorker(fakeEngine());
      workers.push(w);
      return w as never;
    });
    const controller = new AbortController();
    const pending = engine.place(problem, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0]!.terminate).toHaveBeenCalled();
    const again = await engine.place(problem);
    expect(again.placements.length).toBe(1);
    expect(workers.length).toBe(2);
  });
});
