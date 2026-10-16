/**
 * Stability across updates (pan, zoom, data changes): the previous result, re-anchored at
 * the items' new positions, becomes the next solve's `warm_start`, so labels keep their
 * side and only move when they must.
 */
import type { LabelProblem, LabelResult } from "@label-anything/core";

type WarmStart = NonNullable<LabelProblem["warm_start"]>;
export type Anchors = ReadonlyMap<string, readonly [number, number]>;

export class LabelMemory {
  #result: LabelResult | undefined;
  #anchors: Anchors = new Map();

  /** The last result and the anchor positions it was computed for. */
  get result(): LabelResult | undefined {
    return this.#result;
  }
  get anchors(): Anchors {
    return this.#anchors;
  }

  remember(result: LabelResult, anchors: Anchors): void {
    this.#result = result;
    this.#anchors = new Map(anchors);
  }

  clear(): void {
    this.#result = undefined;
    this.#anchors = new Map();
  }

  /**
   * `warm_start` for items now at `anchors`: each previous label box moved with its anchor.
   * Items that were omitted stay omitted-preferred (`placed: false`); new items have no entry.
   */
  warmStart(anchors: Anchors): WarmStart | undefined {
    const prev = this.#result;
    if (!prev) return undefined;
    const placements: WarmStart["placements"] = [];
    for (const p of prev.placements) {
      const a = this.#anchors.get(p.id);
      const b = anchors.get(p.id);
      if (!a || !b) continue;
      if (!p.placed || !p.box) {
        placements.push({ id: p.id, placed: false });
        continue;
      }
      placements.push({
        id: p.id,
        placed: true,
        box: { x: p.box.x + b[0] - a[0], y: p.box.y + b[1] - a[1], w: p.box.w, h: p.box.h },
      });
    }
    return placements.length ? { placements } : undefined;
  }
}
