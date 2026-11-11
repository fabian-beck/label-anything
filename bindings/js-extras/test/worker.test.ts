import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaceError, type LabelResult, type PlaceOptions } from "@label-anything/core";
import type { Engine } from "../src/engine.js";
import { createWorkerEngine, serveEngine } from "../src/worker.js";
import { fakeEngine } from "./engines.js";

/** An in-process stand-in for a Worker running `serveEngine(engine)`. */
function fakeWorker(engine: Engine) {
  const listeners: Record<string, ((e: { data?: unknown; message?: string }) => void)[]> = { message: [], error: [], messageerror: [] };
  const scope = {
    onmessage: null as null | ((e: { data: unknown }) => void),
    postMessage: (m: unknown) => setTimeout(() => listeners.message!.forEach((f) => f({ data: m }))),
  };
  serveEngine(engine, { measure: null }, scope);
  return {
    postMessage: (m: unknown) => setTimeout(() => scope.onmessage!({ data: m })),
    addEventListener: (type: string, f: (e: never) => void) => listeners[type]!.push(f as never),
    terminate: vi.fn(),
    /** As the browser does when the worker's script fails. */
    fail: (message: string) => listeners.error!.forEach((f) => f({ message })),
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

  it("copies raster pixels: the caller solves with them again", async () => {
    const fake = fakeEngine();
    const posted: unknown[][] = [];
    const worker = fakeWorker(fake);
    const post = worker.postMessage;
    worker.postMessage = (...args: unknown[]) => {
      posted.push(args);
      return post(args[0]);
    };
    const engine = createWorkerEngine(worker as never);
    const raster = { width: 2, height: 1, data: new Uint8Array(8).fill(255) };
    await engine.place(problem, { raster });
    await engine.place(problem, { raster });
    expect(posted.every((args) => args.length === 1)).toBe(true); // nothing transferred
    expect(raster.data.length).toBe(8);
    expect(fake.last.options.raster).toEqual(raster);
  });

  it("an aborted signal cancels the solve before it starts", async () => {
    let sawAbort = false;
    const engine = createWorkerEngine(
      fakeWorker({
        place(p, o: PlaceOptions = {}) {
          sawAbort = !!o.signal?.aborted;
          return fakeEngine().place(p, o);
        },
      }) as never,
    );
    await engine.place(problem, { signal: AbortSignal.abort() });
    expect(sawAbort).toBe(true);

    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = false;
    const unshared = createWorkerEngine(fakeWorker(fakeEngine()) as never);
    await expect(unshared.place(problem, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("leaves no abort listener behind", async () => {
    const engine = createWorkerEngine(fakeWorker(fakeEngine()) as never);
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    for (let k = 0; k < 3; k++) await engine.place(problem, { signal: controller.signal });
    expect(added).toHaveBeenCalledTimes(3);
    expect(removed).toHaveBeenCalledTimes(3);
  });

  it("a failed worker rejects pending and later solves", async () => {
    const worker = fakeWorker(fakeEngine());
    const engine = createWorkerEngine(worker as never);
    const pending = engine.place(problem);
    worker.fail("script error");
    await expect(pending).rejects.toThrow("label worker failed: script error");
    expect(worker.terminate).toHaveBeenCalled();
    await expect(engine.place(problem)).rejects.toThrow("label worker failed: script error");
  });

  it("a failed worker is replaced when there is a factory", async () => {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const engine = createWorkerEngine(() => {
      const w = fakeWorker(fakeEngine());
      workers.push(w);
      return w as never;
    });
    const pending = engine.place(problem);
    workers[0]!.fail("script error");
    await expect(pending).rejects.toThrow("label worker failed");
    expect((await engine.place(problem)).placements.length).toBe(1);
    expect(workers.length).toBe(2);
  });

  it("rejects, not throws, after terminate", async () => {
    const engine = createWorkerEngine(fakeWorker(fakeEngine()) as never);
    engine.terminate();
    await expect(engine.place(problem)).rejects.toThrow("terminated");
  });
});
