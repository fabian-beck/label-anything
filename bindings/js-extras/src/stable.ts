/**
 * Stability across updates (pan, zoom, data changes): the previous result, re-anchored at
 * the items' new positions, becomes the next solve's `warm_start`, so labels keep their
 * side and only move when they must.
 */
import type { LabelProblem, LabelResult } from "@label-anything/core";

type WarmStart = NonNullable<LabelProblem["warm_start"]>;
export type Anchors = ReadonlyMap<string, readonly [number, number]>;

/**
 * How a warm start pins the labels (`warm_start.pin`), so that they keep their places and
 * the solve only adds labels around them:
 *
 * - `true`: the view only moved, as a map that was panned. Every label stays, whatever
 *   its priority.
 * - `"yield"`: the view was zoomed or turned. The labels that sit at their items stay
 *   there, giving way only to a more important label that has no other place. A label on
 *   a leader was put aside for lack of room, which has changed: it is free to take a
 *   better place (and keeps its own while that is still good).
 */
export type Pin = boolean | "yield";

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
   * `warm_start` for items now at `anchors`: each previous label box moved with its anchor,
   * with its rotation and its leader.
   * Items that were omitted stay omitted-preferred (`placed: false`); new items have no entry.
   * With `pin` the labels are pinned: they keep these boxes exactly where they still can,
   * and the solve only adds labels around them (see `Pin`).
   */
  warmStart(anchors: Anchors, pin?: Pin): WarmStart | undefined {
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
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      placements.push({
        id: p.id,
        placed: true,
        box: { x: p.box.x + dx, y: p.box.y + dy, w: p.box.w, h: p.box.h },
        // a turned label stays turned, and a leader keeps its way (a label is its box
        // only with both: without them a pinned label, `warm_start.pin`, is placed anew)
        ...(p.rotation ? { rotation: p.rotation } : {}),
        ...(p.leader ? { leader: { points: p.leader.points.map((q) => [q[0]! + dx, q[1]! + dy] as [number, number]), style: p.leader.style } } : {}),
        ...(pin === "yield" && p.leader ? { pin: false } : {}),
      });
    }
    if (!placements.length) return undefined;
    return pin ? { pin, placements } : { placements };
  }
}
