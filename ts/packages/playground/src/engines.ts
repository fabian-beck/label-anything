/**
 * The two engines, each in its own Web Worker: the Rust core compiled to WebAssembly and
 * the TypeScript port. Solves are asynchronous, so the drawing keeps moving while the
 * engine works; a worker is created on first use.
 */
import type { LabelProblem, LabelResult, RgbaPixels } from "@label-anything/core";
import { createWorkerEngine, type WorkerEngine } from "@label-anything/extras/worker";

export type EngineId = "wasm" | "ts";

export const ENGINE_NAMES: Record<EngineId, string> = { wasm: "WebAssembly", ts: "TypeScript" };

export interface Solved {
  result: LabelResult;
  /** Time from sending the problem to receiving the result (ms), messaging included. */
  roundTrip: number;
}

export class Engines {
  #workers = new Map<EngineId, WorkerEngine>();
  #base: URL;

  constructor(base: URL) {
    this.#base = base;
  }

  #worker(id: EngineId): WorkerEngine {
    let w = this.#workers.get(id);
    if (!w) {
      const url = new URL(`engine-${id}.js`, this.#base);
      w = createWorkerEngine(() => new Worker(url, { type: "module", name: `label-anything-${id}` }));
      this.#workers.set(id, w);
    }
    return w;
  }

  /** Solve `problem`; `raster` pixels are copied (the worker takes ownership of the copy). */
  async place(id: EngineId, problem: LabelProblem, raster?: RgbaPixels): Promise<Solved> {
    const t0 = performance.now();
    const options = raster ? { raster: { width: raster.width, height: raster.height, data: new Uint8ClampedArray(raster.data) } } : {};
    const result = await this.#worker(id).place(problem, options);
    return { result, roundTrip: performance.now() - t0 };
  }

  /** Load an engine ahead of its first solve (a tiny problem). */
  async warmUp(id: EngineId): Promise<void> {
    await this.place(id, { canvas: { width: 10, height: 10 }, items: [] });
  }
}

/** Placements compared between two results: the same items placed, at the same boxes and leaders. */
export function samePlacements(a: LabelResult, b: LabelResult): { same: number; total: number; firstDiff?: string } {
  let same = 0;
  let firstDiff: string | undefined;
  const n = Math.max(a.placements.length, b.placements.length);
  for (let i = 0; i < n; i++) {
    const p = a.placements[i];
    const q = b.placements[i];
    const eq =
      p !== undefined &&
      q !== undefined &&
      p.id === q.id &&
      p.placed === q.placed &&
      JSON.stringify(p.box ?? null) === JSON.stringify(q.box ?? null) &&
      JSON.stringify(p.leader?.points ?? null) === JSON.stringify(q.leader?.points ?? null) &&
      JSON.stringify(p.text?.lines ?? null) === JSON.stringify(q.text?.lines ?? null);
    if (eq) same++;
    else firstDiff ??= p?.id ?? q?.id;
  }
  return { same, total: n, firstDiff };
}
