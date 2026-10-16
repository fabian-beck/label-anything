/**
 * Uniform-grid spatial indexes: a static CSR index and a dynamic one (insert/remove);
 * port of `rust/crates/la-core/src/index.rs`.
 *
 * Queries return ids without duplicates in bucket scan order (rows, then columns, then
 * bucket order). That order is a deterministic function of the index's construction and
 * of the sequence of inserts and removals, and it is the same as in Rust. Results go to
 * a reusable {@link IdList}, so queries do not allocate.
 *
 * @module
 */

import { toIndex } from "./math.js";
import { Rect } from "./geom/index.js";

/** A growable list of ids (Rust `Vec<u32>`), reused across queries. */
export class IdList {
  /** Backing store: the ids are `ids[0..len]`. Replaced (not resized) when it grows. */
  ids: Uint32Array;
  /** Number of ids. */
  len = 0;

  constructor(capacity = 16) {
    this.ids = new Uint32Array(capacity > 0 ? capacity : 1);
  }

  /** Remove all ids (keeps the capacity). */
  clear(): void {
    this.len = 0;
  }

  /** Append an id. */
  push(id: number): void {
    if (this.len === this.ids.length) {
      const grown = new Uint32Array(this.ids.length * 2);
      grown.set(this.ids);
      this.ids = grown;
    }
    this.ids[this.len++] = id;
  }

  /** The `i`-th id (`i < len`). */
  get(i: number): number {
    return this.ids[i]!;
  }

  /** Rust `contains`. */
  includes(id: number): boolean {
    for (let i = 0; i < this.len; i++) if (this.ids[i] === id) return true;
    return false;
  }

  /** A copy of the ids as a plain array. */
  toArray(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.len; i++) out.push(this.ids[i]!);
    return out;
  }
}

/** Output of {@link Buckets.range}: `[c0, c1, r0, r1]` (inclusive). */
const RANGE = new Int32Array(4);

/** Bucket grid geometry. */
class Buckets {
  readonly ox: number;
  readonly oy: number;
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;

  constructor(extent: Rect, cell: number) {
    const c = cell > 0 ? cell : 32;
    this.ox = extent.x0;
    this.oy = extent.y0;
    this.cell = c;
    this.cols = clampCount(toIndex(Math.ceil(extent.w() / c)));
    this.rows = clampCount(toIndex(Math.ceil(extent.h() / c)));
  }

  /** The inclusive bucket range of `r`, clamped, into {@link RANGE}. */
  range(r: Rect): void {
    // cell of coordinate v = floor(v), clamped; truncation equals floor for v >= 0
    RANGE[0] = clampBucket((r.x0 - this.ox) / this.cell, this.cols);
    RANGE[1] = clampBucket((r.x1 - this.ox) / this.cell, this.cols);
    RANGE[2] = clampBucket((r.y0 - this.oy) / this.cell, this.rows);
    RANGE[3] = clampBucket((r.y1 - this.oy) / this.cell, this.rows);
  }
}

function clampCount(n: number): number {
  return n < 1 ? 1 : n > 4096 ? 4096 : n;
}

function clampBucket(v: number, n: number): number {
  if (v !== v || v < 0) return 0;
  if (v >= n) return n - 1;
  return toIndex(v);
}

/** Static index over a fixed set of bounding boxes (compressed sparse rows). */
export class StaticIndex {
  private readonly b: Buckets;
  private readonly offsets: Uint32Array;
  private readonly ids: Uint32Array;
  private readonly boxes: Rect[];
  /** The boxes as `[x0, y0, x1, y1]` per id, for the scans. */
  private readonly bx: Float64Array;
  private readonly stamp: Uint32Array;
  private gen = 0;

  /**
   * Index `boxes` (ids are their positions; empty boxes are skipped) on buckets of size
   * `cell` covering `extent` (at most 4096 × 4096). The array is kept, not copied.
   */
  constructor(boxes: Rect[], extent: Rect, cell: number) {
    const b = new Buckets(extent, cell);
    const counts = new Uint32Array(b.cols * b.rows + 1);
    for (let id = 0; id < boxes.length; id++) {
      const r = boxes[id]!;
      if (r.isEmpty()) continue;
      b.range(r);
      const c0 = RANGE[0]!;
      const c1 = RANGE[1]!;
      const r0 = RANGE[2]!;
      const r1 = RANGE[3]!;
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) counts[row * b.cols + col + 1] += 1;
      }
    }
    for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1]!;
    const fill = counts.slice();
    const ids = new Uint32Array(counts[counts.length - 1]!);
    for (let id = 0; id < boxes.length; id++) {
      const r = boxes[id]!;
      if (r.isEmpty()) continue;
      b.range(r);
      const c0 = RANGE[0]!;
      const c1 = RANGE[1]!;
      const r0 = RANGE[2]!;
      const r1 = RANGE[3]!;
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          const k = row * b.cols + col;
          ids[fill[k]!] = id;
          fill[k] += 1;
        }
      }
    }
    const bx = new Float64Array(4 * boxes.length);
    for (let id = 0; id < boxes.length; id++) {
      const r = boxes[id]!;
      bx[4 * id] = r.x0;
      bx[4 * id + 1] = r.y0;
      bx[4 * id + 2] = r.x1;
      bx[4 * id + 3] = r.y1;
    }
    this.b = b;
    this.offsets = counts;
    this.ids = ids;
    this.boxes = boxes;
    this.bx = bx;
    this.stamp = new Uint32Array(boxes.length);
  }

  /** Number of boxes. */
  len(): number {
    return this.boxes.length;
  }

  /** No boxes. */
  isEmpty(): boolean {
    return this.boxes.length === 0;
  }

  /** Box of `id`. */
  bbox(id: number): Rect {
    return this.boxes[id]!;
  }

  /**
   * Ids whose boxes touch `r` (closed), deduplicated, in bucket scan order (row-major,
   * first occurrence) — deterministic for a given index.
   */
  query(r: Rect, out: IdList): void {
    out.clear();
    if (this.boxes.length === 0) return;
    const b = this.b;
    b.range(r);
    const c0 = RANGE[0]!;
    const c1 = RANGE[1]!;
    const r0 = RANGE[2]!;
    const r1 = RANGE[3]!;
    const { x0, y0, x1, y1 } = r;
    const bx = this.bx;
    const ids = this.ids;
    const offsets = this.offsets;
    if (c0 === c1 && r0 === r1) {
      const k = r0 * b.cols + c0;
      const end = offsets[k + 1]!;
      for (let i = offsets[k]!; i < end; i++) {
        const id = ids[i]!;
        const o = 4 * id;
        if (bx[o]! <= x1 && x0 <= bx[o + 2]! && bx[o + 1]! <= y1 && y0 <= bx[o + 3]!) out.push(id);
      }
      return;
    }
    let gen = (this.gen + 1) >>> 0;
    if (gen === 0) {
      this.stamp.fill(0);
      gen = 1;
    }
    this.gen = gen;
    const stamp = this.stamp;
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const k = row * b.cols + col;
        const end = offsets[k + 1]!;
        for (let i = offsets[k]!; i < end; i++) {
          const id = ids[i]!;
          if (stamp[id] !== gen) {
            stamp[id] = gen;
            const o = 4 * id;
            if (bx[o]! <= x1 && x0 <= bx[o + 2]! && bx[o + 1]! <= y1 && y0 <= bx[o + 3]!) out.push(id);
          }
        }
      }
    }
  }
}

/** An empty bucket (end of a scan). */
const NO_IDS: number[] = [];

/** Dynamic index (placed labels, leader segments). Removal is O(bucket size). */
export class DynIndex {
  private b: Buckets;
  /**
   * Buckets in use, created on first insert (a grid of up to 4096 × 4096 buckets is
   * mostly empty); `bucketOf[k]` is the position of bucket `k` in it plus one, 0 = none.
   */
  private buckets: number[][];
  private bucketOf: Int32Array;
  private boxes: (Rect | null)[];
  /** The boxes as `[x0, y0, x1, y1]` per id (valid where `boxes[id]` is set). */
  private bx: Float64Array;
  private stamp: Uint32Array;
  private gen = 0;
  /** Scan state ({@link scanStart}): box, bucket range, position. */
  private readonly sbox = new Float64Array(4);
  private sc0 = 0;
  private sc1 = 0;
  private sr1 = 0;
  private srow = 0;
  private scol = 0;
  private sv: number[] = NO_IDS;
  private si = 0;

  /** An empty index on buckets of size `cell` covering `extent` (at most 4096 × 4096). */
  constructor(extent: Rect, cell: number) {
    const b = new Buckets(extent, cell);
    this.b = b;
    this.buckets = [];
    this.bucketOf = new Int32Array(b.cols * b.rows);
    this.boxes = [];
    this.bx = new Float64Array(0);
    this.stamp = new Uint32Array(0);
  }

  /** Insert with an explicit id (ids are small integers chosen by the caller). */
  insert(id: number, r: Rect): void {
    while (this.boxes.length <= id) this.boxes.push(null);
    if (this.boxes[id] !== null) this.remove(id);
    this.boxes[id] = r;
    const n = this.boxes.length;
    if (this.bx.length < 4 * n) {
      const old = this.bx.length / 4;
      const grown = new Float64Array(4 * (n > 2 * old ? n : 2 * old));
      grown.set(this.bx);
      this.bx = grown;
    }
    this.bx[4 * id] = r.x0;
    this.bx[4 * id + 1] = r.y0;
    this.bx[4 * id + 2] = r.x1;
    this.bx[4 * id + 3] = r.y1;
    const b = this.b;
    b.range(r);
    const c0 = RANGE[0]!;
    const c1 = RANGE[1]!;
    const r0 = RANGE[2]!;
    const r1 = RANGE[3]!;
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const k = row * b.cols + col;
        let bi = this.bucketOf[k]!;
        if (bi === 0) {
          this.buckets.push([]);
          bi = this.buckets.length;
          this.bucketOf[k] = bi;
        }
        this.buckets[bi - 1]!.push(id);
      }
    }
  }

  /** Remove `id` (no-op when absent). */
  remove(id: number): void {
    const r = id < this.boxes.length ? this.boxes[id]! : null;
    if (r === null) return;
    const b = this.b;
    b.range(r);
    const c0 = RANGE[0]!;
    const c1 = RANGE[1]!;
    const r0 = RANGE[2]!;
    const r1 = RANGE[3]!;
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const bi = this.bucketOf[row * b.cols + col]!;
        if (bi === 0) continue;
        const v = this.buckets[bi - 1]!;
        const p = v.indexOf(id);
        if (p >= 0) {
          // swap_remove
          const last = v.pop()!;
          if (p < v.length) v[p] = last;
        }
      }
    }
    this.boxes[id] = null;
  }

  /** Box of `id`, or null. */
  get(id: number): Rect | null {
    return id < this.boxes.length ? this.boxes[id]! : null;
  }

  /**
   * Ids whose boxes touch `r`, deduplicated, in bucket scan order (deterministic for a
   * given history of inserts and removals; removal swaps the last bucket entry in).
   */
  query(r: Rect, out: IdList): void {
    out.clear();
    const b = this.b;
    b.range(r);
    const c0 = RANGE[0]!;
    const c1 = RANGE[1]!;
    const r0 = RANGE[2]!;
    const r1 = RANGE[3]!;
    if (this.stamp.length < this.boxes.length) {
      const grown = new Uint32Array(this.boxes.length > 2 * this.stamp.length ? this.boxes.length : 2 * this.stamp.length);
      grown.set(this.stamp);
      this.stamp = grown;
    }
    let gen = (this.gen + 1) >>> 0;
    if (gen === 0) {
      this.stamp.fill(0);
      gen = 1;
    }
    this.gen = gen;
    const { x0, y0, x1, y1 } = r;
    const stamp = this.stamp;
    const bx = this.bx;
    const boxes = this.boxes;
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const bi = this.bucketOf[row * b.cols + col]!;
        if (bi === 0) continue;
        const v = this.buckets[bi - 1]!;
        for (let i = 0; i < v.length; i++) {
          const id = v[i]!;
          if (stamp[id] === gen) continue;
          stamp[id] = gen;
          if (boxes[id] !== null) {
            const o = 4 * id;
            if (bx[o]! <= x1 && x0 <= bx[o + 2]! && bx[o + 1]! <= y1 && y0 <= bx[o + 3]!) out.push(id);
          }
        }
      }
    }
  }

  /**
   * Start a scan of the ids whose boxes touch `r` grown by `grow` on every side: the ids
   * of {@link query} (of `r.inflate(grow)`) in the same order, one at a time from
   * {@link scanNext}, so that a caller looking for the first match can stop early. One
   * scan per index at a time; inserts and removals end it.
   */
  scanStart(r: Rect, grow: number): void {
    // r.inflate(grow), then Buckets.range
    const x0 = r.x0 - grow;
    const y0 = r.y0 - grow;
    const x1 = r.x1 + grow;
    const y1 = r.y1 + grow;
    const b = this.b;
    const c0 = clampBucket((x0 - b.ox) / b.cell, b.cols);
    const c1 = clampBucket((x1 - b.ox) / b.cell, b.cols);
    const r0 = clampBucket((y0 - b.oy) / b.cell, b.rows);
    const r1 = clampBucket((y1 - b.oy) / b.cell, b.rows);
    if (this.stamp.length < this.boxes.length) {
      const grown = new Uint32Array(this.boxes.length > 2 * this.stamp.length ? this.boxes.length : 2 * this.stamp.length);
      grown.set(this.stamp);
      this.stamp = grown;
    }
    let gen = (this.gen + 1) >>> 0;
    if (gen === 0) {
      this.stamp.fill(0);
      gen = 1;
    }
    this.gen = gen;
    const sb = this.sbox;
    sb[0] = x0;
    sb[1] = y0;
    sb[2] = x1;
    sb[3] = y1;
    this.sc0 = c0;
    this.sc1 = c1;
    this.sr1 = r1;
    this.srow = r0;
    this.scol = c0;
    this.sv = this.bucket(r0 * b.cols + c0);
    this.si = 0;
  }

  /** The ids of bucket `k` (empty when it was never used). */
  private bucket(k: number): number[] {
    const bi = this.bucketOf[k]!;
    return bi === 0 ? NO_IDS : this.buckets[bi - 1]!;
  }

  /** The next id of the scan started by {@link scanStart}, or -1 when it is done. */
  scanNext(): number {
    const stamp = this.stamp;
    const gen = this.gen;
    const bx = this.bx;
    const boxes = this.boxes;
    const sb = this.sbox;
    for (;;) {
      const v = this.sv;
      while (this.si < v.length) {
        const id = v[this.si++]!;
        if (stamp[id] === gen) continue;
        stamp[id] = gen;
        if (boxes[id] !== null) {
          const o = 4 * id;
          if (bx[o]! <= sb[2]! && sb[0]! <= bx[o + 2]! && bx[o + 1]! <= sb[3]! && sb[1]! <= bx[o + 3]!) return id;
        }
      }
      if (this.scol < this.sc1) this.scol++;
      else if (this.srow < this.sr1) {
        this.srow++;
        this.scol = this.sc0;
      } else {
        this.sv = NO_IDS;
        this.si = 0;
        return -1;
      }
      this.sv = this.bucket(this.srow * this.b.cols + this.scol);
      this.si = 0;
    }
  }

  /** A deep copy (Rust `Clone`). */
  clone(): DynIndex {
    const c = new DynIndex(new Rect(0, 0, 0, 0), this.b.cell); // one bucket, replaced below
    c.b = this.b;
    c.buckets = this.buckets.map((v) => v.slice());
    c.bucketOf = this.bucketOf.slice();
    c.boxes = this.boxes.slice();
    c.bx = this.bx.slice();
    c.stamp = this.stamp.slice();
    c.gen = this.gen;
    return c;
  }
}
