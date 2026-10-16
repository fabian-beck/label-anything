// Port of the unit tests of rust/crates/la-core/src/index.rs.
import { describe, expect, it } from "vitest";
import { Rect } from "../src/geom/index.js";
import { DynIndex, IdList, StaticIndex } from "../src/spatial.js";

describe("index", () => {
  it("static_query", () => {
    const boxes = [Rect.xywh(0, 0, 10, 10), Rect.xywh(50, 50, 5, 5), Rect.xywh(5, 5, 100, 2)];
    const ix = new StaticIndex(boxes, Rect.xywh(0, 0, 200, 200), 16);
    const out = new IdList();
    ix.query(Rect.xywh(8, 8, 1, 1), out);
    expect(out.toArray()).toEqual([0]);
    ix.query(Rect.xywh(0, 0, 60, 60), out);
    expect(out.toArray().sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("dynamic_insert_remove", () => {
    const ix = new DynIndex(Rect.xywh(0, 0, 100, 100), 10);
    ix.insert(3, Rect.xywh(0, 0, 30, 30));
    ix.insert(1, Rect.xywh(20, 20, 5, 5));
    const out = new IdList();
    ix.query(Rect.xywh(21, 21, 1, 1), out);
    expect(out.toArray().sort((a, b) => a - b)).toEqual([1, 3]);
    ix.remove(3);
    ix.query(Rect.xywh(21, 21, 1, 1), out);
    expect(out.toArray()).toEqual([1]);
  });

  it("dynamic_scan_order_follows_history", () => {
    // results are in bucket scan order; removal swaps the last bucket entry in
    const ix = new DynIndex(Rect.xywh(0, 0, 100, 100), 10);
    for (const id of [4, 2, 7, 5]) ix.insert(id, Rect.xywh(1 + id, 1, 1, 1));
    const out = new IdList(1);
    ix.query(Rect.xywh(0, 0, 9.5, 9.5), out);
    expect(out.toArray()).toEqual([4, 2, 7, 5]);
    ix.remove(4);
    ix.query(Rect.xywh(0, 0, 9.5, 9.5), out);
    expect(out.toArray()).toEqual([5, 2, 7]);
    ix.insert(2, Rect.xywh(15, 1, 1, 1)); // re-insert moves 2 to the next bucket
    ix.query(Rect.xywh(0, 0, 19.5, 9.5), out);
    expect(out.toArray()).toEqual([5, 7, 2]);
    expect(out.includes(7) && !out.includes(4)).toBe(true);
    expect(ix.get(4)).toBeNull();
    expect(ix.get(99)).toBeNull();
    expect(ix.get(2)!.eq(Rect.xywh(15, 1, 1, 1))).toBe(true);
    const copy = ix.clone();
    ix.remove(5);
    copy.query(Rect.xywh(0, 0, 19.5, 9.5), out);
    expect(out.toArray()).toEqual([5, 7, 2]);
  });

  it("static_query_dedups_and_skips_empty_boxes", () => {
    const boxes = [Rect.xywh(0, 0, 50, 50), Rect.EMPTY, Rect.xywh(30, 30, 1, 1)];
    const ix = new StaticIndex(boxes, Rect.xywh(0, 0, 100, 100), 10);
    expect(ix.len()).toBe(3);
    expect(ix.isEmpty()).toBe(false);
    const out = new IdList();
    ix.query(Rect.xywh(0, 0, 100, 100), out);
    expect(out.toArray()).toEqual([0, 2]);
    // touching counts (closed boxes)
    ix.query(Rect.xywh(50, 50, 10, 10), out);
    expect(out.toArray()).toEqual([0]);
    expect(new StaticIndex([], Rect.xywh(0, 0, 1, 1), 1).isEmpty()).toBe(true);
  });
});
